// usage-context: plan usage and the context window, in one pane.
//
// Pane "usage-context" draws on every surface (the terminal and the Desktop
// app); the band above the prompt carries the usage rows as a fallback only
// while the pane is not placed.
//
// session.measure / turn.complete: take the plan windows (five_hour, seven_day)
//   the last response reported and save a sample per window in $.store, so the
//   recent rate survives restarts and parallel sessions. Refresh the context
//   breakdown (the free local estimate, never the token-count requests).
// ui.render (Pane, AbovePrompt): draw them.
//
// When there is no live reading yet (or a response carried no rate-limit
// headers), it shows the last one saved in statusline-limits.json, dimmed.

const PANE = 'usage-context'
const HOUR = 3_600_000
// recent: how far back the recent rate looks; minSpan: the least history it
// needs (a weekly rate from a few busy hours would ignore sleep); floor: the
// least elapsed time the window average divides by, so a young window's first
// minutes don't project to several hundred percent.
const WINDOWS = {
  five_hour: { label: '5h', length: 5 * HOUR, recent: 45 * 60_000, minSpan: 10 * 60_000, floor: 30 * 60_000, perHour: 1, unit: '/h' },
  seven_day: { label: 'wk', length: 7 * 24 * HOUR, recent: 24 * HOUR, minSpan: 18 * HOUR, floor: 24 * HOUR, perHour: 24, unit: '/day' },
}
const ORDER = ['five_hour', 'seven_day']
const MAX_SAMPLES = 300
const KEY_PREFIX = 'rl:'
const HIDDEN_KEY = 'paneHidden'
// Segment colours for the context bar; free space and the buffer are dim blocks.
const PALETTE = ['cyan', 'magenta', 'yellow', 'green', 'blue', 'red', 'white']
const LIST_MAX = 8
// The Desktop app's own context colours (sampled from its Context panel, app
// 3.6556): the four largest used categories in these, the rest grey, the
// autocompact buffer darker, free space the bare track. Plan bars use the
// first, or the app's amber and danger red as they near the limit.
const APP = { ranked: ['#338ced', '#e76624', '#00a888', '#d28e05'], other: '#959595', buffer: '#5e5e5e', track: '#2b2b2b' }
const APP_LEVEL = { success: '#338ced', warning: '#d28e05', error: '#dc3c3d' }

// Latest plan readings: { kind, percent, resetsAtMs, isCached }, in ORDER.
let readings = []
// Saved samples per window id: [[timeMs, percent], ...], oldest first.
const samples = new Map()
// The clock as of the last tick, so rendering never waits on a call.
let nowMs = 0
// The account's plan, such as "Max 5x" or "Pro", once read; percentages mean more on a bigger plan.
let planName = null
// Latest context figures: { tokens, window, percent, breakdown | null, isExact }.
let context = null
let isRefreshing = false
// Which detail lists the pane has open.
const open = { files: false, mcp: false, agents: false, skills: false }
let isPaneOpen = false
// True once the surface has drawn the pane; the band above the prompt then stays out.
let isPanePlaced = false
// The 30-second redraw, so a second session.start doesn't stack another.
let timer = null

// ---- pure helpers ----

// Which account's windows these are: the CLAUDE_CONFIG_DIR folder name, or
// "main". The plugin store is shared, so two accounts whose windows reset in
// the same hour would otherwise mix their samples.
let account = 'main'

// A window's storage id: the account, the window kind and the hour its reset
// falls in (last, so loadSamples can age it out).
function windowId(kind, resetsAtMs) {
  return KEY_PREFIX + account + ':' + kind + ':' + Math.round(resetsAtMs / HOUR)
}

// Samples since the window's figure last dropped. Usage only falls when the
// window resets early, as a plan upgrade does, and older samples then belong
// to a different count. Small dips are rounding noise.
function sinceDrop(list) {
  let start = 0
  for (let i = 1; i < list.length; i++) if (list[i][1] < list[i - 1][1] - 2) start = i
  return start === 0 ? list : list.slice(start)
}

// "2h10m", "45m", "3d4h": a duration in milliseconds, two units at most.
function span(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return minutes + 'm'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + 'h' + String(minutes % 60).padStart(2, '0') + 'm'
  return Math.floor(hours / 24) + 'd' + (hours % 24) + 'h'
}

// A rate with one decimal under 10, none above.
function rate(n) {
  return n < 10 ? n.toFixed(1) : String(Math.round(n))
}

// 1234 -> "1.2k", 1500000 -> "1.5M".
function short(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1) + 'k'
  return String(Math.round(n))
}

// The last two parts of a path, for a narrow list.
function tail(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/')
}

// The figures for one window, from its reading, its samples and the clock.
function figures(reading, saved, now) {
  const w = WINDOWS[reading.kind]
  const opened = reading.resetsAtMs - w.length
  const elapsed = Math.min(w.length, Math.max(w.floor, now - opened))
  const remaining = Math.max(0, reading.resetsAtMs - now)
  const avg = (reading.percent / (elapsed / HOUR)) * w.perHour

  // Recent rate: from the newest sample at or before the cutoff (or the oldest
  // one if the window is younger), to now. Idle time counts, so a pause lowers it.
  let recent = null
  saved = sinceDrop(saved)
  if (saved.length > 0) {
    const cutoff = now - w.recent
    let from = saved[0]
    for (const s of saved) if (s[0] <= cutoff) from = s
    const hours = (now - from[0]) / HOUR
    if (hours * HOUR >= w.minSpan) recent = (Math.max(0, reading.percent - from[1]) / hours) * w.perHour
  }

  // The pace that decides the end note and colour: the recent rate when there
  // is one, otherwise the average. The window ends where that pace lands it.
  const pace = (recent ?? avg) / w.perHour
  const projected = reading.percent + pace * (remaining / HOUR)
  const hoursToFull = pace > 0 ? (100 - reading.percent) / pace : Infinity
  const willFill = projected >= 100 && reading.percent < 100
  // Budget: the most you can use per unit of time from now and still reach the
  // reset. With less than one unit left (an hour, a day) it says nothing useful.
  const unitsLeft = (remaining / HOUR) * (1 / w.perHour)
  const budget = unitsLeft >= 1 ? (100 - reading.percent) / unitsLeft : null
  return { w, remaining, avg, recent, projected, willFill, hoursToFull, budget }
}

// Theme colours, so the pane follows the user's theme: fine while the pace
// ends under 90%, a warning under 100%, an error when it fills early.
function colorOf(percent, f) {
  if (f.willFill || percent >= 90) return 'error'
  if (f.projected >= 90) return 'warning'
  return 'success'
}

// Split `width` cells among `weights` by largest remainder, each present one at least 1.
function apportion(weights, width) {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0 || width <= 0) return weights.map(() => 0)
  const exact = weights.map((x) => (x / total) * width)
  const cells = exact.map((x, i) => (weights[i] > 0 ? Math.max(1, Math.floor(x)) : 0))
  let left = width - cells.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0])
  for (let k = 0; left > 0 && order.length > 0; k = (k + 1) % order.length, left--) cells[order[k][1]]++
  // Over-allocation from the 1-cell minimum: take back from the widest.
  while (left < 0) {
    const widest = cells.indexOf(Math.max(...cells))
    cells[widest]--
    left++
  }
  return cells
}

// ---- drawing (take the element table, never `$`) ----

// A section title: larger on the Desktop app, bold in the terminal.
function heading(Text, children) {
  return Text({ weight: 'semibold', size: 'heading', children })
}

// A row with `left` at the start and `right` flush with the end.
function spread(Box, left, right, props = {}) {
  return Box({ flexDirection: 'row', justifyContent: 'space-between', columnGap: 2, ...props, children: [left, right] })
}

// One row per plan window: a single line when the surface is wide, otherwise
// two lines in a block no wider than the pane, figures flush right.
function usageRows(els, columns, isDesktop) {
  const { Box, Text } = els
  if (readings.length === 0) {
    return [Text({ dimColor: true, children: 'plan usage: waiting for the first response' })]
  }
  const isWide = columns >= 100
  const width = Math.min(columns - 2, 48)
  const barWidth = columns >= 40 ? 14 : 10
  const rows = []
  for (const r of readings) {
    const f = figures(r, samples.get(windowId(r.kind, r.resetsAtMs)) ?? [], nowMs)
    const dim = r.isCached
    const color = dim ? undefined : colorOf(r.percent, f)
    const filled = Math.max(0, Math.min(barWidth, Math.round((r.percent / 100) * barWidth)))
    // The average only until there is a recent rate, so the notes fit the pane.
    const notes = [f.recent === null ? 'avg ' + rate(f.avg) + '%' + f.w.unit : 'now ' + rate(f.recent) + '%' + f.w.unit]
    if (f.budget !== null && r.percent < 100) notes.push('budget ' + rate(f.budget) + '%' + f.w.unit)
    const endColor = f.willFill && !dim ? 'error' : undefined

    const meter = Box({
      flexDirection: 'row',
      children: [
        Text({ weight: 'semibold', dimColor: dim, children: f.w.label + ' ' }),
        ...(isDesktop && els.Svg
          ? [els.Svg({ source: svgMeter(r.percent, dim ? APP.other : APP_LEVEL[color]), alt: f.w.label + ' ' + Math.round(r.percent) + '%', width: 120, height: 5 })]
          : [Text({ color, dimColor: dim, children: '█'.repeat(filled) }), Text({ dimColor: true, children: '░'.repeat(barWidth - filled) })]),
        Text({ weight: dim ? undefined : 'semibold', dimColor: dim, tabular: true, children: ' ' + (Math.round(r.percent) + '%').padStart(4) }),
      ],
    })
    const resets = Text({ dimColor: true, tabular: true, children: (dim ? 'saved · ' : '') + 'resets in ' + span(f.remaining) })
    const rates = Text({ dimColor: true, tabular: true, children: notes.join('  ') })
    const ending = Text({
      color: endColor,
      dimColor: endColor === undefined,
      tabular: true,
      children: f.willFill ? 'full in ' + span(f.hoursToFull * HOUR) : 'ends near ' + Math.min(100, Math.round(f.projected)) + '%',
    })
    if (isWide) {
      rows.push(Box({ flexDirection: 'row', columnGap: 2, children: [meter, resets, rates, ending] }))
    } else {
      rows.push(
        Box({
          flexDirection: 'column',
          width,
          children: [spread(Box, meter, resets), spread(Box, rates, ending, { paddingLeft: 3 })],
        }),
      )
    }
  }
  return rows
}

// A plan bar as the app draws its own: a rounded fill on a rounded track.
function svgMeter(percent, fill) {
  const w = Math.max(0, Math.min(100, percent)) * 10
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 5" width="1000" height="5" preserveAspectRatio="none">' +
    '<clipPath id="m"><rect width="1000" height="5" rx="2.5"/></clipPath><g clip-path="url(#m)">' +
    '<rect width="1000" height="5" fill="' + APP.track + '"/><rect width="' + w + '" height="5" fill="' + fill + '"/></g></svg>'
  )
}

// The context bar as an SVG 1000 units wide, stretched to the pane: one
// segment per category, a hairline gap between, free space left as the track.
function svgBar(segments) {
  const widths = apportion(segments.map((s) => s.c.tokens), 1000)
  let x = 0
  const rects = segments.map((s, i) => {
    const rect = s.c.kind === 'free' ? '' : '<rect x="' + x + '" width="' + Math.max(0, widths[i] - 3) + '" height="5" fill="' + s.hex + '"/>'
    x += widths[i]
    return rect
  })
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 5" width="1000" height="5" preserveAspectRatio="none">' +
    '<clipPath id="r"><rect width="1000" height="5" rx="2.5"/></clipPath><g clip-path="url(#r)">' +
    '<rect width="1000" height="5" fill="' + APP.track + '"/>' + rects.join('') + '</g></svg>'
  )
}

// The context sections: the window summary (a stacked bar by category and its
// legend), the detail lists behind toggles, and the exact-count footer. Each
// is one block; the pane spaces the blocks.
function contextBlocks(els, columns, redraw, actions, isDesktop) {
  const { Box, Text, Button } = els
  const column = (children) => Box({ flexDirection: 'column', children })
  if (!context) return [Text({ dimColor: true, children: 'context: waiting for the first response' })]

  // Before the first response there is no measured count, and the measured
  // window can differ from the one the breakdown (and the app) use; prefer the
  // breakdown's window, and its local estimate until a count arrives.
  const b = context.breakdown
  const window = b?.rawMaxTokens || context.window
  const tokens = context.tokens || b?.totalTokens || 0
  const pct = window ? (tokens / window) * 100 : context.percent ?? 0
  const summary = [
    spread(
      Box,
      heading(Text, 'Context'),
      Text({
        tabular: true,
        children: [
          Text({ weight: 'semibold', color: pct >= 85 ? 'error' : pct >= 65 ? 'warning' : undefined, children: Math.round(pct) + '%' }),
          Text({ dimColor: true, children: '  ' + short(tokens) + ' / ' + short(window) }),
        ],
      }),
    ),
  ]
  if (!b) {
    summary.push(Text({ dimColor: true, children: 'no breakdown yet' }))
    return [column(summary)]
  }

  const barWidth = Math.max(10, Math.min(columns - 2, 60))
  // Used categories largest first, as the app lists them, then the buffer and free space.
  const shown = b.categories.filter((c) => c.kind !== 'deferred' && c.tokens > 0)
  const cats = [...shown.filter((c) => c.kind === 'used').sort((x, y) => y.tokens - x.tokens), ...shown.filter((c) => c.kind !== 'used')]
  const widths = apportion(cats.map((c) => c.tokens), barWidth)
  let used = 0
  const segments = cats.map((c, i) => {
    const rank = c.kind === 'used' ? used++ : -1
    const hex = rank >= 0 ? APP.ranked[rank] ?? APP.other : c.kind === 'buffer' ? APP.buffer : APP.track
    const color = isDesktop ? hex : rank >= 0 ? PALETTE[rank % PALETTE.length] : undefined
    const glyph = c.kind === 'free' ? '░' : c.kind === 'buffer' ? '▒' : '█'
    return { c, color, hex, text: glyph.repeat(widths[i]) }
  })
  // The desktop's proportional font makes a glyph bar wrap; it gets an SVG bar
  // that fills the pane instead.
  summary.push(
    isDesktop && els.Svg
      ? Box({ marginBottom: 1, children: [els.Svg({ source: svgBar(segments), alt: 'Context ' + Math.round(pct) + '% used', height: 5 })] })
      : Box({
          flexDirection: 'row',
          marginBottom: 1,
          children: segments.map((s) => Text({ color: s.color, dimColor: s.color === undefined, children: s.text })),
        }),
  )
  for (const s of segments) {
    const share = ((s.c.tokens / window) * 100).toFixed(1) + '%'
    summary.push(
      spread(
        Box,
        Box({
          flexDirection: 'row',
          flexShrink: 1,
          children: [
            Text({ color: s.color, dimColor: s.color === undefined, children: '■ ' }),
            Text({ dimColor: s.color === undefined, wrap: 'truncate', children: s.c.name }),
          ],
        }),
        Text({ dimColor: true, tabular: true, children: short(s.c.tokens).padStart(6) + share.padStart(7) }),
      ),
    )
  }
  const deferred = b.categories.filter((c) => c.kind === 'deferred').reduce((a, c) => a + c.tokens, 0)
  if (deferred > 0) summary.push(Text({ dimColor: true, children: 'on-demand tools ' + short(deferred) + ', outside the window' }))
  if (b.autoCompactThreshold) summary.push(Text({ dimColor: true, children: 'compacts at ' + short(b.autoCompactThreshold) }))

  // Detail lists, each behind a toggle.
  const total = (list) => list.reduce((a, x) => a + x.tokens, 0)
  const byTokens = (list) => [...list].sort((x, y) => y.tokens - x.tokens)
  const servers = new Map()
  for (const t of b.mcpTools) {
    const s = servers.get(t.serverName) ?? { tokens: 0, count: 0 }
    s.tokens += t.tokens
    s.count++
    servers.set(t.serverName, s)
  }
  const sections = [
    { key: 'files', hotkey: 'f', title: 'Memory files', sum: total(b.memoryFiles), items: byTokens(b.memoryFiles).map((x) => [x.type + ' ' + tail(x.path), x.tokens]) },
    {
      key: 'mcp',
      hotkey: 'm',
      title: 'MCP servers',
      sum: total(b.mcpTools),
      items: [...servers.entries()].sort((x, y) => y[1].tokens - x[1].tokens).map(([name, s]) => [name + ' (' + s.count + ' tools)', s.tokens]),
    },
    { key: 'agents', hotkey: 'a', title: 'Agents', sum: total(b.agents), items: byTokens(b.agents).map((x) => [x.agentType, x.tokens]) },
    {
      key: 'skills',
      hotkey: 's',
      title: 'Skills',
      sum: b.skills ? b.skills.tokens : 0,
      items: b.skills ? byTokens(b.skills.skillFrontmatter).map((x) => [x.name, x.tokens]) : [],
    },
  ]
  const details = []
  for (const sec of sections) {
    if (sec.items.length === 0) continue
    details.push(
      spread(
        Box,
        Button({
          key: 'toggle-' + sec.key,
          label: (open[sec.key] ? '▾ ' : '▸ ') + sec.title,
          hotkey: sec.hotkey,
          plain: true,
          onPress: () => {
            open[sec.key] = !open[sec.key]
            redraw()
          },
        }),
        Text({ dimColor: true, tabular: true, children: short(sec.sum) }),
      ),
    )
    if (!open[sec.key]) continue
    for (const [name, tokens] of sec.items.slice(0, LIST_MAX)) {
      details.push(
        spread(
          Box,
          Box({ flexShrink: 1, children: [Text({ wrap: 'truncate', children: name })] }),
          Text({ dimColor: true, tabular: true, children: short(tokens) }),
          { paddingLeft: 2 },
        ),
      )
    }
    if (sec.items.length > LIST_MAX) {
      details.push(Text({ dimColor: true, children: '  … ' + (sec.items.length - LIST_MAX) + ' more' }))
    }
  }

  const footer = Box({
    flexDirection: 'row',
    columnGap: 2,
    alignItems: 'center',
    children: [
      Button({ key: 'exact', label: context.isExact ? 'Recount' : 'Exact count', hotkey: 'e', variant: 'secondary', onPress: actions.exact }),
      Text({ dimColor: true, children: context.isExact ? 'counted by the API' : 'local estimate' }),
    ],
  })

  const blocks = [column(summary)]
  if (details.length > 0) blocks.push(column(details))
  blocks.push(footer)
  return blocks
}

// ---- hooks ----

export function register(on) {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    nowMs = await $.clock.now()
    const dir = await $.env.get('CLAUDE_CONFIG_DIR')
    if (dir) account = String(dir).split(/[\\/]/).filter(Boolean).pop() || 'main'
    await loadSamples($)
    await readPlan($)
    await takeReading($)
    await takeContext($, 'summary')
    timer?.cancel?.()
    timer = $.clock.every(30_000, async () => {
      nowMs = await $.clock.now()
      $.ui.invalidate('ui.render')
    })
    // Open the pane unless the user closed it themselves last time. In a narrow
    // terminal the open waits, and the band shows the usage rows meanwhile.
    try {
      await $.command.register({ name: 'meter', description: 'Show or hide the usage and context pane', immediate: true })
      if (!(await $.store.get(HIDDEN_KEY))) await openPane($)
    } catch {
      // The pane is optional; the band still draws.
    }
    return result
  })

  on('command.run', { command: 'meter' }, async ($) => {
    if (isPaneOpen) {
      await $.ui.close({ id: PANE })
      isPaneOpen = false
      isPanePlaced = false
      await $.store.set(HIDDEN_KEY, true)
    } else {
      await $.store.delete(HIDDEN_KEY)
      await openPane($)
    }
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      isPaneOpen = false
      isPanePlaced = false
      // The user closed it: stay closed in later sessions until /meter.
      if (e.origin && e.origin.kind === 'person') await $.store.set(HIDDEN_KEY, true)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    nowMs = await $.clock.now()
    if (e.changed.includes('rateLimits')) await accept($, e.rateLimits)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      await takeReading($)
      await takeContext($, 'summary')
    }
    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    isPanePlaced = true
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const columns = e.props.bodyColumns ?? 40
    const redraw = () => $.ui.invalidate('ui.render')
    const actions = { exact: () => takeContext($, 'full') }
    const usage = Box({
      flexDirection: 'column',
      children: [
        spread(Box, heading(Text, 'Plan usage'), Text({ dimColor: true, children: planName ?? '' })),
        ...usageRows(els, columns, e.surface !== 'terminal'),
      ],
    })
    return Box({
      flexDirection: 'column',
      paddingX: 1,
      rowGap: 1,
      children: [usage, ...contextBlocks(els, columns, redraw, actions, e.surface !== 'terminal')],
    })
  })

  // The usage rows above the prompt, as a fallback while the pane isn't drawn
  // (a narrow terminal, or the pane closed).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || isPanePlaced) return next(e)
    const theirs = await next(e)
    // Another plugin's band (a form, say) gets the band to itself: the band is
    // one scrolling region, so sharing it buries one under the other. The
    // engine's own drawing comes back as { type: 'engine' }; agent-crabs' few
    // short rows stack above the usage rows instead.
    const isCrabs = theirs && theirs.part && theirs.part.plugin === 'agent-crabs'
    if (theirs && theirs.type !== 'engine' && !isCrabs) return theirs
    const els = $.ui.resolve(e)
    const mine = els.Box({ flexDirection: 'column', paddingX: 1, children: usageRows(els, e.props.bodyColumns ?? 80, e.surface !== 'terminal') })
    return theirs ? els.Box({ flexDirection: 'column', children: [theirs, mine] }) : mine
  })
}

async function openPane($) {
  const placed = await $.ui.open({ id: PANE, title: 'Usage & context', columns: 46 })
  isPaneOpen = true
  return placed
}

// Read the context window; `detail` is 'summary' (local, free) or 'full' (counted by the API).
async function takeContext($, detail) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const usage = await $.session.usage({ breakdown: detail, columns: 40 })
    const c = usage.context
    context = {
      tokens: c.tokens,
      window: c.window,
      percent: c.percent,
      breakdown: c.breakdown ?? (context ? context.breakdown : null),
      isExact: detail === 'full' && Boolean(c.breakdown),
    }
    $.ui.invalidate('ui.render')
  } catch {
    // No reading this time; the pane keeps the last one.
  } finally {
    isRefreshing = false
  }
}

// Read the live plan windows, or the status line's saved ones when there are none.
async function takeReading($) {
  try {
    nowMs = await $.clock.now()
    const usage = await $.session.usage()
    if (usage.rateLimits && usage.rateLimits.length > 0) {
      await accept($, usage.rateLimits)
      return
    }
    await takeCached($)
  } catch {
    // No reading this time; the pane keeps the last one.
  }
}

// This account's files: by default the profile is ~/.claude.json and the rest
// is in ~/.claude; with CLAUDE_CONFIG_DIR set, both are in that folder.
async function accountPaths($) {
  const join = (base, ...parts) => [base, ...parts].join(String(base).includes('\\') ? '\\' : '/')
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return { profile: join(dir, '.claude.json'), limits: join(dir, 'statusline-limits.json') }
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  if (!home) return null
  return { profile: join(home, '.claude.json'), limits: join(home, '.claude', 'statusline-limits.json') }
}

// The plan from the profile's rate tier, such as default_claude_max_5x.
async function readPlan($) {
  try {
    const paths = await accountPaths($)
    if (!paths) return
    const oauth = JSON.parse(await $.fs.read(paths.profile)).oauthAccount ?? {}
    const tier = oauth.organizationRateLimitTier ?? ''
    const max = /max_(\d+)x/.exec(tier)
    planName = max ? 'Max ' + max[1] + 'x' : tier ? 'Pro' : null
  } catch {
    // No plan name; the pane works without it.
  }
}

async function takeCached($) {
  const paths = await accountPaths($)
  if (!paths) return
  const saved = JSON.parse(await $.fs.read(paths.limits))
  const found = []
  for (const kind of ORDER) {
    const w = saved[kind]
    if (!w || typeof w.used_percentage !== 'number') continue
    const resetsAtMs = w.resets_at * 1000
    // A window whose reset has passed says nothing about the new one.
    if (resetsAtMs > nowMs) found.push({ kind, percent: w.used_percentage, resetsAtMs, isCached: true })
  }
  if (found.length > 0) {
    readings = found
    $.ui.invalidate('ui.render')
  }
}

// Take the windows a response reported: show them and save a sample for each.
async function accept($, limits) {
  const found = []
  for (const l of limits) {
    if (!WINDOWS[l.kind] || !l.resetsAt) continue
    found.push({ kind: l.kind, percent: l.percentUsed, resetsAtMs: new Date(l.resetsAt).getTime(), isCached: false })
  }
  found.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
  if (found.length === 0) return
  readings = found
  for (const r of found) await save($, r)
  await saveCached($, found)
  $.ui.invalidate('ui.render')
}

// Save live windows in the status line's cache too. The Desktop app runs no
// status line, so without this the next session's first draw shows whatever
// the terminal last saw, days old.
async function saveCached($, found) {
  try {
    const paths = await accountPaths($)
    if (!paths) return
    const saved = {}
    for (const r of found) saved[r.kind] = { used_percentage: r.percent, resets_at: Math.round(r.resetsAtMs / 1000) }
    await $.fs.write(paths.limits, JSON.stringify(saved))
  } catch {
    // The cache is a fallback; the live reading still draws.
  }
}

// Add a sample to a window's list unless the figure has not moved recently.
async function save($, r) {
  const id = windowId(r.kind, r.resetsAtMs)
  // Read again right before writing: another session may have added samples.
  const stored = await $.store.get(id)
  const list = Array.isArray(stored) ? stored : (samples.get(id) ?? [])
  let last = list[list.length - 1]
  // The window started over (a plan upgrade resets it): start the list over too.
  if (last && r.percent < last[1] - 2) {
    list.length = 0
    last = undefined
  }
  if (!last || last[1] !== r.percent || nowMs - last[0] > 10 * 60_000) {
    list.push([nowMs, r.percent])
    if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES)
    await $.store.set(id, list)
  }
  samples.set(id, list)
}

// Load the samples saved for the windows now open, and drop the old windows'.
async function loadSamples($) {
  const keys = await $.store.keys()
  const keep = Math.round((nowMs - 8 * 24 * HOUR) / HOUR)
  for (const key of keys) {
    if (!key.startsWith(KEY_PREFIX)) continue
    const hourOfReset = Number(key.slice(key.lastIndexOf(':') + 1))
    if (hourOfReset < keep) {
      await $.store.delete(key)
      continue
    }
    const stored = await $.store.get(key)
    if (Array.isArray(stored)) samples.set(key, stored)
  }
}
