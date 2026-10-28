import { expect, mock, test } from 'claude-code/testing'

const HOUR = 3_600_000
const NOW = Date.parse('2026-10-02T12:00:00Z')

const category = (name: string, tokens: number, kind = 'used') => ({ name, tokens, color: 'inactive', isDeferred: kind === 'deferred', kind })

const breakdown = {
  categories: [
    category('System prompt', 8_000),
    category('System tools', 12_000),
    category('Memory files', 6_000),
    category('Messages', 120_000),
    category('Free space', 700_000, 'free'),
    category('Autocompact buffer', 40_000, 'buffer'),
    category('Deferred tools', 30_000, 'deferred'),
  ],
  totalTokens: 146_000,
  maxTokens: 400_000,
  rawMaxTokens: 400_000,
  autocompactSource: 'window',
  percentage: 15,
  gridRows: [],
  model: 'opus',
  memoryFiles: [{ path: 'C:\\Users\\x\\repo\\AGENTS.md', type: 'Project', tokens: 4_000 }],
  mcpTools: [{ name: 'mcp__a__b', serverName: 'a', tokens: 900, isLoaded: true }],
  agents: [{ agentType: 'sonnet-high', source: 'userSettings', tokens: 200 }],
  skills: { totalSkills: 1, includedSkills: 1, tokens: 300, skillFrontmatter: [{ name: 'run', source: 'built-in', tokens: 300 }] },
  autoCompactThreshold: 800_000,
  isAutoCompactEnabled: true,
  apiUsage: null,
}

const PANE = {
  plugin: 'usage-context',
  component: 'Pane',
  requestId: 'usage-context',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Usage & context', isFocused: false, bodyColumns: 46, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const BAND = {
  plugin: 'usage-context',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

function stubs(on: any, store: Map<string, unknown>, rateLimits: unknown[], band: unknown = { type: 'engine', ref: 1 }, opened: string[] = []) {
  mock.clock(on, { now: NOW })
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', ($: any, e: any) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\x' : undefined }))
  on('fs.read', ($: any, e: any) => ({
    value: String(e.path).endsWith('.claude.json') ? JSON.stringify({ oauthAccount: { organizationRateLimitTier: 'default_claude_max_5x' } }) : '{}',
  }))
  on('ui.open', ($: any, e: any) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.usage', () => ({
    value: {
      context: { tokens: 146_000, window: 1_000_000, percent: 15, breakdown },
      rateLimits,
    },
  }))
  // In the band, the engine's own (empty) drawing unless a test puts another plugin's tree there.
  on('ui.render', ($: any, e: any) => (e.component === 'AbovePrompt' ? band : { type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
}

const limits = (fiveHourPct: number) => [
  { kind: 'five_hour', percentUsed: fiveHourPct, resetsAt: new Date(NOW + 3 * HOUR).toISOString() },
  { kind: 'seven_day', percentUsed: 7, resetsAt: new Date(NOW + 4 * 24 * HOUR).toISOString() },
]

test('the pane draws usage and the context breakdown in both apps', async ($, on) => {
  stubs(on, new Map(), limits(52))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Plan usage' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ +52%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^System prompt/ })).toBeDefined()
    // The breakdown's window (as the app shows it), not the measured 1M.
    expect(await ui.find({ type: 'Text', text: '  146k / 400k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '37%' })).toBeDefined()
    // The desktop draws the bar as an SVG; the terminal as glyphs.
    // The desktop draws the plan and context bars as SVG in the app's colours; the terminal as glyphs.
    const bars = await ui.findAll({ type: 'Svg' })
    expect(bars.length).toBe(surface === 'desktop' ? 3 : 0)
    if (surface === 'desktop') {
      // Messages is the largest used category, so it takes the app's first colour.
      expect(bars[2]?.props.source).toContain('fill="#338ced"')
      const first = (await ui.findAll({ type: 'Text', text: /^■ $/ }))[0]
      expect(first?.props.color).toBe('#338ced')
    }
    expect(await ui.find({ key: 'exact' })).toBeDefined()
    // Open the memory-file list, check it, and close it again for the next app.
    await ui.press({ key: 'toggle-files' })
    expect(await ui.find({ type: 'Text', text: /AGENTS\.md/ })).toBeDefined()
    await ui.press({ key: 'toggle-files' })
    await ui.unmount()
  }
})

test('the band draws the usage rows in the terminal', async ($, on) => {
  stubs(on, new Map(), limits(52))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^ +52%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^5h $/ })).toBeDefined()
  await ui.unmount()
})

test('a fast recent pace shows full-in time and saves samples', async ($, on) => {
  const store = new Map<string, unknown>()
  const id = 'rl:main:five_hour:' + Math.round((NOW + 3 * HOUR) / HOUR)
  // 40 minutes ago the window stood at 30%; now it is 52%: 33%/h.
  store.set(id, [[NOW - 40 * 60_000, 30]])
  stubs(on, store, limits(52))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /now 3\d%\/h/})).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^full in / })).toBeDefined()
  expect((store.get(id) as unknown[]).length).toBe(2)
  await ui.unmount()
})

test('before any reading the band says it is waiting', async ($, on) => {
  stubs(on, new Map(), [])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /waiting for the first response/ })).toBeDefined()
  await ui.unmount()
})

test('the pane names the plan and shows the budget left per hour', async ($, on) => {
  stubs(on, new Map(), limits(52))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Plan usage' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Max 5x' })).toBeDefined()
  // 48% left over the 3 hours to the reset: 16%/h.
  expect(await ui.find({ type: 'Text', text: /budget 16%\/h/ })).toBeDefined()
  await ui.unmount()
})

test('a young weekly window does not project its first hours across the week', async ($, on) => {
  // 5% used two hours into the week: a straight line says 420%, but the
  // average divides by at least a day, so the week ends near 40%.
  stubs(on, new Map(), [{ kind: 'seven_day', percentUsed: 5, resetsAt: new Date(NOW + 166 * HOUR).toISOString() }])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^ends near 40%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^full in / })).toBeUndefined()
  await ui.unmount()
})

test('a window that started over mid-way (a plan upgrade) ignores the old count', async ($, on) => {
  const store = new Map<string, unknown>()
  const reset = NOW + 3 * HOUR
  const id = 'rl:main:seven_day:' + Math.round(reset / HOUR)
  // 95% a day ago on the old plan, 0% after the upgrade two hours ago, 1% now.
  store.set(id, [[NOW - 26 * HOUR, 90], [NOW - 20 * HOUR, 95], [NOW - 2 * HOUR, 0]])
  stubs(on, store, [{ kind: 'seven_day', percentUsed: 1, resetsAt: new Date(reset).toISOString() }])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // Only two hours since the drop: too little for a weekly recent rate, so the
  // average shows, and no budget with under a day left.
  expect(await ui.find({ type: 'Text', text: /now 0\.0%/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /budget/ })).toBeUndefined()
  await ui.unmount()
})

test('a live reading refreshes the saved fallback', async ($, on) => {
  const writes: Record<string, string> = {}
  stubs(on, new Map(), limits(52))
  on('fs.write', ($: any, e: any) => ((writes[e.path] = e.text), { value: undefined }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const saved = JSON.parse(writes['C:\\Users\\x\\.claude\\statusline-limits.json'] ?? '{}')
  expect(saved.five_hour).toEqual({ used_percentage: 52, resets_at: Math.round((NOW + 3 * HOUR) / 1000) })
  expect(saved.seven_day.used_percentage).toBe(7)
})

test('a drop in the figure starts the saved samples over', async ($, on) => {
  const store = new Map<string, unknown>()
  const id = 'rl:main:five_hour:' + Math.round((NOW + 3 * HOUR) / HOUR)
  store.set(id, [[NOW - 40 * 60_000, 80]])
  stubs(on, store, limits(5))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(store.get(id)).toEqual([[NOW, 5]])
})

test("another plugin's band (a form) gets the band to itself", async ($, on) => {
  // Beneath this mod: another plugin drawing its form in the band.
  stubs(on, new Map(), limits(52), { type: 'Text', props: {}, children: ['a form'] })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'a form' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ +52%$/ })).toBeUndefined()
  await ui.unmount()
})

// A model request whose response reports this usage, through the turn.step stream.
function stepStub(on: any, usage: Record<string, number>, model = 'claude-opus-5-5') {
  on('turn.step', async function* (_$: any, e: any): AsyncGenerator<any, any> {
    yield { kind: 'stop', stopReason: 'end_turn', usage: { ...usage, model } }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model } }
  })
}

async function step($: any, agentId?: string) {
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId })) {
    // drain the stream
  }
}

test('every response adds its tokens and the measured cost to this session’s hours', async ($, on) => {
  const store = new Map<string, unknown>()
  stubs(on, store, limits(52))
  on('session.id', () => ({ value: 'sess-1' }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.measure', ($: any, e: any) => ({ changed: e.changed }))
  stepStub(on, { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 8_500 })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await step($)
  await step($, 'agent-1')
  await ($ as any).session.measure({ context: { tokens: 1, window: 2 }, rateLimits: [], cost: { usd: 1.5 }, changed: ['cost'] })
  await ($ as any).turn.complete({ turnId: 't', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' })

  const rec = store.get('tok:main:sess-1') as any
  const bucket = rec.h[String(Math.floor(NOW / HOUR))]
  // Main loop and subagent alike, by model: input, output, cache read, cache write, calls.
  expect(bucket.m['opus-5-5']).toEqual([2_000, 1_000, 180_000, 17_000, 2])
  expect(bucket.usd).toBe(1.5)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Usage stats' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '200k tokens  $1.50' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^in 2k · out 1k · cache read 180k · write 17k · 2 calls$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Models this week: opus-5-5 100%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('finished 5h windows give the share of the weekly limit one window is', async ($, on) => {
  const store = new Map<string, unknown>()
  const weekReset = NOW + 4 * 24 * HOUR
  const week: [number, number][] = []
  // Three finished windows, 10, 15 and 20 hours ago: each moved 5h by 50 points and the week by 4.
  let wk = 10
  for (const hoursAgo of [20, 15, 10]) {
    const reset = NOW - hoursAgo * HOUR
    const opened = reset - 5 * HOUR
    store.set('rl:main:five_hour:' + Math.round(reset / HOUR), [[opened + 10 * 60_000, 5], [reset - 10 * 60_000, 55]])
    week.push([opened + 5 * 60_000, wk], [reset - 15 * 60_000, wk + 4])
    wk += 4
  }
  store.set('rl:main:seven_day:' + Math.round(weekReset / HOUR), week)
  stubs(on, store, limits(52))
  on('session.id', () => ({ value: 'sess-2' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // 4 weekly points per 50 five-hour points: a full window is 8% of the week, 12.5 windows.
  const saved = store.get('win:main') as any[]
  expect(saved.length).toBe(3)
  expect(saved[0]).toMatchObject({ p: 55, d5: 50, dw: 4 })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^One 5h window ≈ 8\.0% of the week, about 13 windows a week \(3 windows\)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^5h windows end near 55% on average \(3 in 30 days\)$/ })).toBeDefined()
  await ui.unmount()
})

test('a quiet session’s hours are merged into the account’s and its key removed', async ($, on) => {
  const store = new Map<string, unknown>()
  const hour = String(Math.floor((NOW - 8 * HOUR) / HOUR))
  store.set('tok:main:old', { last: NOW - 7 * HOUR, usdSeen: 3, h: { [hour]: { usd: 3, m: { 'haiku-5-5': [10, 20, 30, 40, 2] } } } })
  store.set('tok:main:busy', { last: NOW - 10 * 60_000, usdSeen: 1, h: { [hour]: { usd: 1, m: { 'haiku-5-5': [1, 1, 1, 1, 1] } } } })
  store.set('tok:.claude-work:other', { last: NOW - 9 * HOUR, usdSeen: 2, h: {} })
  stubs(on, store, limits(52))
  on('session.id', () => ({ value: 'sess-3' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(store.has('tok:main:old')).toBe(false)
  expect(store.has('tok:main:busy')).toBe(true)
  // Another account's sessions are that account's to merge.
  expect(store.has('tok:.claude-work:other')).toBe(true)
  expect((store.get('toks:main') as any)[hour].m['haiku-5-5']).toEqual([10, 20, 30, 40, 2])
  expect(store.has('merge')).toBe(false)
})

test('the band keeps the usage rows while the side pane is open', async ($, on) => {
  stubs(on, new Map(), limits(52))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The pane is the extra view: stats always open there.
  expect(await pane.find({ type: 'Text', text: 'Usage stats' })).toBeDefined()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /^ +52%$/ })).toBeDefined()
  expect(await band.find({ key: 'stats' })).toBeDefined()
  // The band has no stats view of its own; they live in the pane.
  expect(await band.find({ type: 'Text', text: 'Usage stats' })).toBeUndefined()
  await band.unmount()
  await pane.unmount()
})

test('the band’s Stats button opens the side pane and leaves the closed setting alone', async ($, on) => {
  const store = new Map<string, unknown>([['paneHidden', true]])
  const opened: string[] = []
  stubs(on, store, limits(52), undefined, opened)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  expect(opened).toEqual([])
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'stats' })
  expect(opened).toEqual(['usage-context'])
  expect(store.get('paneHidden')).toBe(true)
  expect(await band.find({ type: 'Text', text: 'Usage stats' })).toBeUndefined()
  await band.unmount()
})
