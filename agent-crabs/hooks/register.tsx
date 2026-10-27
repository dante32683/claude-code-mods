// agent-crabs: above the prompt, one animated Clawd per running subagent and what it
//   is doing now (reading, searching, editing, running a command, on the web). The crab
//   throws confetti when its subagent finishes and goes gray under a rain cloud if it
//   fails; finished rows leave after 20 s. Activity comes from the subagents' own tool
//   calls; whether one is still running comes from $.agent.list(), so a missed end event
//   never leaves a row stuck. /crabs-demo plays every animation with two pretend crabs.
//
//   Each pose is an interactive Svg, which draws in its own frame. Changing a frame's
//   source flashes it blank while it reloads, so a new pose loads hidden beside the one
//   showing and takes over after WARM_MS. Only those two are mounted, because the app
//   refuses a drawing over 100,000 characters.
//   A new crab's first pose warms the same way, with its first frame drawn as a plain
//   image Svg (no frame to load) until then, so the crab shows the moment its row does.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Activity, Crab } from '../types'
import { crabGlyph, crabStill, crabSvg } from './sprite'

const SHOW_DONE_MS = 20_000
const WARM_MS = 900 // a new pose loads hidden this long before it shows
const DEMO_STEP_MS = 3_000
const REST_MS = 2_500 // with no tool running this long, the subagent is thinking again
const ROWS = 4
const KEEP = 20
const LIVE = new Set(['pending', 'running', 'waiting'])
export const ACTIVITIES: Activity[] = ['think', 'read', 'search', 'edit', 'run', 'web', 'done', 'failed']
const SVGS = Object.fromEntries(ACTIVITIES.map(a => [a, crabSvg(a)])) as Record<Activity, string>
const STILLS = Object.fromEntries(ACTIVITIES.map(a => [a, crabStill(a)])) as Record<Activity, string>

// A new activity; its pose shows once it has loaded (see tick).
export function setActivity(c: Crab, activity: Activity, at: number): Crab {
  return activity === c.activity ? c : { ...c, activity, changedAt: at }
}

const crabs = atom({ plugin: 'agent-crabs', key: 'crabs' } as const, [] as Crab[])
const now = atom({ plugin: 'agent-crabs', key: 'now' } as const, 0)

export const register: Register = on => {
  let timers: Timer[] = []

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    for (const t of timers) t.cancel()
    // One tick a second while a row shows: elapsed times, the glyph crab's steps, and a
    // check against the engine's own agent list.
    timers = [$.clock.every(1000, () => void tick($).catch(() => {}))]
    await $.command.register({ name: 'crabs-demo', description: 'Play every agent-crabs animation with two pretend subagents' }).catch(() => {})
    return r
  })

  on('command.run', { command: 'crabs-demo' }, async $ => {
    const t = Date.now()
    const demo = (n: number, offset: number): Crab => ({ id: `demo-${n}-${t}`, label: `Demo crab ${n}`, activity: 'think', shown: 'think', changedAt: t, detail: 'demo: think', tools: 0, startedAt: t - offset })
    await update($, crabs, list => [demo(1, 0), demo(2, DEMO_STEP_MS / 2), ...list].slice(0, KEEP))
    await update($, now, () => t)
    return { text: `Two pretend crabs play each animation for ${DEMO_STEP_MS / 1000} s.` }
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const crab: Crab = {
        id: r.agentId,
        label: e.description || e.subagentType || 'subagent',
        activity: 'think',
        shown: 'think',
        changedAt: Date.now(),
        detail: 'starting',
        tools: 0,
        startedAt: Date.now(),
      }
      await update($, crabs, list => [crab, ...list.filter(c => c.id !== crab.id)].slice(0, KEEP)).catch(() => {})
    }
    return r
  })

  // A subagent's tool call sets what its crab is doing; the main loop's calls pass by.
  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (!id) return next(e)
    const { activity, detail } = describe(e as unknown as Record<string, unknown>)
    // Drawing must never fail a tool call, so these updates swallow their errors.
    await update($, crabs, list =>
      list.map(c =>
        c.id === id && !c.endedAt
          ? { ...setActivity(c, activity, Date.now()), detail, tools: c.tools + 1, busy: (c.busy ?? 0) + 1, lastToolAt: Date.now() }
          : c,
      ),
    ).catch(() => {})
    try {
      return await next(e)
    } finally {
      await update($, crabs, list =>
        list.map(c => (c.id === id ? { ...c, busy: Math.max(0, (c.busy ?? 1) - 1), lastToolAt: Date.now() } : c)),
      ).catch(() => {})
    }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) await finish($, e.agentId, e.reason === 'error' || e.reason === 'aborted')
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const at = await read($, now) // subscribes the band to the tick
    const shown = (await read($, crabs)).filter(c => isShown(c, at || Date.now()))
    if (e.props.hasSurvey || shown.length === 0) return rest
    const isDesktop = e.surface !== 'terminal'
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const frame = Math.floor((at || Date.now()) / 1000)
    const rows = shown.slice(0, ROWS).map(c => (
      <Box key={`crab-${c.id}`} flexDirection="row" alignItems="center" gap={1}>
        {isDesktop && Svg ? (
          <Box key={`art-${c.id}`} width={6} height={2}>
            {warming(c, at) && (
              <Box key="still">
                <Svg key="still" source={STILLS[c.shown]} alt={`crab ${c.shown} still`} width={48} height={28} />
              </Box>
            )}
            {[...new Set([c.shown, c.activity])].map(a => (
              <Box key={`pose-${a}`} display={a === c.shown && !warming(c, at) ? 'flex' : 'none'}>
                <Svg key={`sprite-${a}`} source={SVGS[a]} alt={`crab ${a}`} width={48} height={28} isInteractive />
              </Box>
            ))}
          </Box>
        ) : (
          <Text color={c.activity === 'failed' ? 'gray' : '#D77757'}>{crabGlyph(c.activity, frame)}</Text>
        )}
        <Text wrap="truncate-end">
          <Text bold dimColor={c.activity === 'failed'}>{c.label}</Text>
          <Text dimColor>{`  ${c.detail} · ${elapsed(c, at)}${c.tools ? ` · ${c.tools} tool${c.tools === 1 ? '' : 's'}` : ''}`}</Text>
        </Text>
      </Box>
    ))
    const mine = (
      <Box key="agent-crabs" flexDirection="column" paddingX={1}>
        {rows}
        {shown.length > ROWS && <Text dimColor>{`  +${shown.length - ROWS} more`}</Text>}
      </Box>
    )
    return rest ? (
      <Box flexDirection="column">
        {mine}
        {rest}
      </Box>
    ) : (
      mine
    )
  })
}

async function tick($: EngineInterface) {
  const list = await read($, crabs)
  const t = Date.now()
  if (!list.some(c => isShown(c, t - 2_000))) {
    if (list.length) await update($, crabs, () => []) // all gone: stop redrawing
    return
  }
  // A running crab whose agent the engine no longer lists as live has ended.
  if (list.some(c => !c.endedAt)) {
    const agents = await $.agent.list().catch(() => null)
    if (agents) {
      const status = new Map(agents.map(a => [a.id, a.status]))
      for (const c of list) {
        const s = status.get(c.id)
        if (!c.endedAt && s !== undefined && !LIVE.has(s)) await finish($, c.id, s !== 'completed' && s !== 'idle')
      }
    }
  }
  // Pretend crabs step through every animation, then the first finishes and the second fails.
  if (list.some(c => c.id.startsWith('demo-') && !c.endedAt)) {
    await update($, crabs, all => all.map(c => (c.id.startsWith('demo-') && !c.endedAt ? demoStep(c, t) : c)))
  }
  // A subagent with no tool running for a while is thinking about its next step.
  if (list.some(c => settle(c, t) !== c)) await update($, crabs, all => all.map(c => settle(c, t)))
  // A pose that has had time to load takes over from the one showing.
  if (list.some(c => c.activity !== c.shown)) {
    await update($, crabs, all => all.map(c => (c.activity !== c.shown && t - c.changedAt >= WARM_MS ? { ...c, shown: c.activity } : c)))
  }
  await update($, now, () => t)
}

export function demoStep(c: Crab, at: number): Crab {
  const i = Math.floor((at - c.startedAt) / DEMO_STEP_MS)
  const steps = ACTIVITIES.slice(0, 6)
  if (i < steps.length) {
    const activity = steps[i]!
    return activity === c.activity ? c : { ...setActivity(c, activity, at), detail: `demo: ${activity}`, tools: i }
  }
  const failed = c.label.endsWith('2')
  return { ...setActivity(c, failed ? 'failed' : 'done', at), detail: failed ? 'stopped' : 'done', endedAt: at }
}

export function settle(c: Crab, t: number): Crab {
  if (c.endedAt || c.busy || c.activity === 'think' || c.id.startsWith('demo-')) return c
  return t - (c.lastToolAt ?? c.changedAt) >= REST_MS ? setActivity(c, 'think', t) : c
}

async function finish($: EngineInterface, id: string, failed: boolean) {
  await update($, crabs, list =>
    list.map(c =>
      c.id === id && !c.endedAt
        ? { ...setActivity(c, failed ? 'failed' : 'done', Date.now()), detail: failed ? 'stopped' : 'done', endedAt: Date.now() }
        : c,
    ),
  )
}

// A new crab's first pose is still loading hidden.
export function warming(c: Pick<Crab, 'startedAt'>, at: number) {
  return (at || Date.now()) - c.startedAt < WARM_MS
}

export function isShown(c: Crab, at: number) {
  return !c.endedAt || at - c.endedAt < SHOW_DONE_MS
}

export function elapsed(c: Pick<Crab, 'startedAt' | 'endedAt'>, at: number) {
  const s = Math.max(0, Math.round(((c.endedAt ?? (at || Date.now())) - c.startedAt) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// What a person would say a tool call is doing, and which animation fits it.
export function describe(e: Record<string, unknown>): { activity: Activity; detail: string } {
  const tool = String(e.tool)
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const file = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
  const short = (t: string, n = 48) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)
  switch (tool) {
    case 'Read':
      return { activity: 'read', detail: `reading ${file(s('file_path'))}` }
    case 'Grep':
    case 'Glob':
      return { activity: 'search', detail: `searching ${short(s('pattern'), 32)}` }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return { activity: 'edit', detail: `editing ${file(s('file_path') || s('notebook_path'))}` }
    case 'Bash':
    case 'PowerShell':
      return { activity: 'run', detail: short(s('description') || s('command')) }
    case 'WebSearch':
      return { activity: 'web', detail: `searching the web: ${short(s('query'), 40)}` }
    case 'WebFetch': {
      const host = /^https?:\/\/([^/]+)/.exec(s('url'))?.[1] ?? 'a page'
      return { activity: 'web', detail: `reading ${host}` }
    }
  }
  if (tool.startsWith('mcp__')) return { activity: 'think', detail: `using ${tool.split('__').slice(1).join(' ').replace(/_/g, ' ')}` }
  return { activity: 'think', detail: `using ${tool}` }
}
