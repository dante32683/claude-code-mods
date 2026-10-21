import { expect, test } from 'claude-code/testing'
import { ACTIVITIES, demoStep, describe as describeCall, elapsed, isShown, setActivity, settle } from '../hooks/register'
import { crabSvg } from '../hooks/sprite'

const BAND = {
  plugin: 'agent-crabs',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: true, maxRows: 8, bodyColumns: 120, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

function stubs(on: any, agents: { id: string; status: string }[] = []) {
  const state = new Map<string, unknown>()
  let version = 0
  on('state.get', ($: any, e: any) => ({ value: { value: state.get(e.key), version } }))
  on('state.set', ($: any, e: any) => {
    state.set(e.key, e.value)
    return { value: { isSet: true, version: ++version } }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'haiku' }))
  on('agent.list', () => ({ value: agents.map(a => ({ ...a, description: 'x', type: 'explorer' })) }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'engine', ref: 1 }))
  return state
}

async function spawnOne($: any) {
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.agent.spawn({ prompt: 'look', description: 'Find mod examples', subagent_type: 'explorer', run_in_background: true })
}

test('a running subagent gets a crab and its current activity', async ($, on) => {
  const state = stubs(on)
  await spawnOne($)
  await ($ as any).tool.call({ tool: 'Read', file_path: 'C:\\Users\\x\\notes\\TODO.md', agentId: 'a1' })
  // The Read has returned: nothing in flight, the pose still 'read' until REST_MS passes.
  const list = [...state.values()].find(v => Array.isArray(v)) as any[]
  expect(list[0]).toMatchObject({ busy: 0, activity: 'read' })

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg: any = await desk.find({ type: 'Svg' })
  expect(svg?.props.isInteractive).toBe(true)
  expect(svg?.props.source).toContain('attributeName="visibility"')
  expect((await desk.find({ type: 'Text', text: /Find mod examples/ }))).toBeDefined()
  expect((await desk.find({ type: 'Text', text: /reading TODO\.md/ }))).toBeDefined()
  await desk.unmount()

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  expect(await term.find({ type: 'Text', text: /reading TODO\.md · \d+s · 1 tool/ })).toBeDefined()
  await term.unmount()
})

test('the main loop draws nothing extra', async ($, on) => {
  stubs(on)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await ($ as any).tool.call({ tool: 'Read', file_path: '/a.md' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

test('a finished subagent hops, a failed one goes gray', async ($, on) => {
  stubs(on)
  await spawnOne($)
  await ($ as any).turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', agentId: 'a1', reason: 'answer' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const alts = (await ui.findAll({ type: 'Svg' })).map((s: any) => s.props.alt)
  expect(alts).toContain('crab done')
  expect(await ui.find({ type: 'Text', text: /done/ })).toBeDefined()
  await ui.unmount()
})

test('activities and labels', () => {
  expect(describeCall({ tool: 'Grep', pattern: 'agent.spawn' })).toEqual({ activity: 'search', detail: 'searching agent.spawn' })
  expect(describeCall({ tool: 'Edit', file_path: 'C:\\mods\\hooks\\register.tsx' })).toEqual({ activity: 'edit', detail: 'editing register.tsx' })
  expect(describeCall({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })).toEqual({ activity: 'run', detail: 'Run the tests' })
  expect(describeCall({ tool: 'WebFetch', url: 'https://code.claude.com/docs' })).toEqual({ activity: 'web', detail: 'reading code.claude.com' })
  expect(describeCall({ tool: 'mcp__notes__search_notes' }).detail).toBe('using notes search notes')
  expect(elapsed({ startedAt: 0, endedAt: 75_000 }, 0)).toBe('1m 15s')
  expect(isShown({ id: 'a', label: '', activity: 'done', detail: '', tools: 0, startedAt: 0, endedAt: 1_000, shown: 'done', changedAt: 0 }, 30_000)).toBe(false)
  for (const a of ['think', 'read', 'search', 'edit', 'run', 'web', 'done', 'failed'] as const) {
    expect(crabSvg(a).startsWith('<svg')).toBe(true)
    expect(crabSvg(a).length).toBeLessThan(131072)
  }
})

test('a new pose loads beside the one showing, and the band stays under the size cap', async ($, on) => {
  stubs(on)
  await spawnOne($)
  await ($ as any).tool.call({ tool: 'Grep', pattern: 'x', agentId: 'a1' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const alts = (await ui.findAll({ type: 'Svg' })).map((s: any) => s.props.alt)
  expect(alts.sort()).toEqual(['crab search', 'crab think'])
  await ui.unmount()
  // Four rows mid-swap, each holding the two largest poses, fit in a 100,000-character drawing.
  const sizes = ACTIVITIES.map(a => crabSvg(a).length).sort((a, b) => b - a)
  expect(4 * (sizes[0]! + sizes[1]!)).toBeLessThan(80_000)
})

test('the demo steps through each activity, then ends', () => {
  const c = { id: 'demo-2-0', label: 'Demo crab 2', activity: 'think' as const, shown: 'think' as const, changedAt: 0, detail: '', tools: 0, startedAt: 0 }
  expect(setActivity(c, 'think', 5)).toBe(c)
  expect(setActivity(c, 'edit', 5)).toMatchObject({ activity: 'edit', shown: 'think', changedAt: 5 })
  expect(demoStep(c, 3_100).activity).toBe('read')
  expect(demoStep(c, 16_000).activity).toBe('web')
  expect(demoStep(c, 18_100)).toMatchObject({ activity: 'failed', endedAt: 18_100 })
})

test('a crab with no tool running goes back to thinking, but not mid-tool', () => {
  const c = { id: 'a1', label: 'x', activity: 'run' as const, shown: 'run' as const, changedAt: 0, detail: '', tools: 1, startedAt: 0, lastToolAt: 1_000 }
  expect(settle({ ...c, busy: 1 }, 60_000)).toMatchObject({ activity: 'run' })
  expect(settle({ ...c, busy: 0 }, 2_000)).toMatchObject({ activity: 'run' })
  expect(settle({ ...c, busy: 0 }, 4_000)).toMatchObject({ activity: 'think', changedAt: 4_000 })
  expect(settle({ ...c, busy: 0, endedAt: 2_000 }, 9_000).activity).toBe('run')
})
