import { expect, test } from 'claude-code/testing'
import { isOurNotice, parseTask } from '../hooks/register'

const job = (over: object = {}) => ({ id: 'agent-1', task: 'count the TODOs', model: 'haiku', status: 'running', answer: '', ...over })

const PANE = {
  plugin: 'aside',
  component: 'Pane',
  requestId: 'aside',
  viewport: { columns: 80, rows: 30 },
  props: { title: 'Aside', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 28 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop'] as const

type Opts = { spawns?: any[]; agents?: any[]; commands?: any[]; submitted?: string[]; deny?: string; jobs?: object[] }

function stubs(on: any, o: Opts = {}) {
  // $.state from memory, seeded with jobs: the kit can't start a real worker,
  // so tests put the job there themselves.
  const state = new Map<string, unknown>([['jobs', o.jobs ?? []]])
  let version = 0
  on('state.get', ($: any, e: any) => ({ value: { value: state.get(e.key), version } }))
  on('state.set', ($: any, e: any) => {
    state.set(e.key, e.value)
    return { value: { isSet: true, version: ++version } }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', ($: any, e: any) => {
    o.commands?.push(e)
    return { value: undefined }
  })
  on('agent.register', ($: any, e: any) => {
    o.agents?.push(e)
    return { value: { agent: 'aside:' + e.name } }
  })
  on('agent.spawn', ($: any, e: any) => {
    o.spawns?.push(e)
    return o.deny ? { deny: o.deny } : { model: 'haiku' }
  })
  on('session.messages', () => ({ value: [
    { role: 'user', text: 'please fix the parser', toolUses: [] },
    { role: 'assistant', text: 'Working on src/parse.ts now.', toolUses: [] },
    { role: 'user', text: '<command-name>/aside</command-name>', toolUses: [] },
  ] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('prompt.submit', ($: any, e: any) => {
    o.submitted?.push(e.text)
    return { text: e.text }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
const finish = ($: any, agentId: string, answer: string, reason = 'answer') =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', agentId, reason })

test('registers the command and two hidden worker types', async ($, on) => {
  const agents: any[] = []
  const commands: any[] = []
  stubs(on, { agents, commands })
  await start($)
  // Immediate: typed mid-turn it runs at once, not queued behind the turn.
  expect(commands).toMatchObject([{ name: 'aside', immediate: true }])
  expect(agents.map(a => [a.name, a.model, a.effort])).toEqual([['worker', 'haiku', 'xhigh'], ['worker-opus', 'opus', 'medium']])
  expect(await ($ as any).agent.offer({ agent: 'aside:worker' })).toMatchObject({ isOffered: false })
})

test('/aside hands the worker its task and the recent chat', async ($, on) => {
  const spawns: any[] = []
  stubs(on, { spawns })
  await start($)
  // The test kit can't start a real agent, so no agentId comes back; a live
  // `claude -p "//aside ..."` run checks that one does.
  const r: any = await $.command.run({ command: 'aside', args: 'find where the cache is cleared' } as any)
  expect(r.text).toBe("Couldn't start the side worker: no agent id")
  expect(spawns[0].subagent_type).toBe('aside:worker')
  expect(spawns[0].run_in_background).toBe(true)
  expect(spawns[0].prompt).toContain('Task:\nfind where the cache is cleared')
  expect(spawns[0].prompt).toContain('User: please fix the parser')
  expect(spawns[0].prompt).toContain('Claude: Working on src/parse.ts now.')
  expect(spawns[0].prompt).not.toContain('<command-name>')
})

test('"opus:" picks the Opus worker; an empty /aside shows usage', async ($, on) => {
  const spawns: any[] = []
  stubs(on, { spawns })
  await start($)
  await $.command.run({ command: 'aside', args: 'opus: review the plan' } as any)
  expect(spawns[0].subagent_type).toBe('aside:worker-opus')
  expect(spawns[0].prompt).toContain('Task:\nreview the plan')
  const r: any = await $.command.run({ command: 'aside', args: '  ' } as any)
  expect(r.text).toContain('Usage: /aside')
  expect(spawns.length).toBe(1)
})

test('parseTask and isOurNotice', () => {
  expect(parseTask(' OPUS:  check it ')).toEqual({ task: 'check it', model: 'opus' })
  expect(parseTask('check opus: it')).toEqual({ task: 'check opus: it', model: 'haiku' })
  expect(isOurNotice('<task-notification><task-id>agent-1</task-id></task-notification>', ['agent-1'])).toBe(true)
  expect(isOurNotice('<task-notification><task-id>bash-9</task-id></task-notification>', ['agent-1'])).toBe(false)
  // Two notices in one message: keep it, so the other one isn't lost.
  expect(isOurNotice('<task-notification>agent-1</task-notification><task-notification>bash-9</task-notification>', ['agent-1'])).toBe(false)
})

test('a refused spawn says so', async ($, on) => {
  stubs(on, { deny: 'no agents here' })
  await start($)
  const r: any = await $.command.run({ command: 'aside', args: 'x' } as any)
  expect(r.text).toBe("Couldn't start the side worker: no agents here")
})

test("a worker's completion notice is kept out of the chat; others pass", async ($, on) => {
  stubs(on, { jobs: [job()] })
  await start($)
  const ours: any = await ($.prompt.submit as any)({ text: '<task-notification><task-id>agent-1</task-id></task-notification>', origin: { kind: 'task-notification' } })
  expect(ours.drop).toContain('Aside pane')
  const other: any = await ($.prompt.submit as any)({ text: '<task-notification><task-id>bash-9</task-id></task-notification>', origin: { kind: 'task-notification' } })
  expect(other.text).toContain('bash-9')
  const typed: any = await ($.prompt.submit as any)({ text: 'agent-1 is mentioned by the user' })
  expect(typed.text).toContain('agent-1')
})

for (const surface of SURFACES) {
  test(`the pane shows the answer and sends it to chat (${surface})`, async ($, on) => {
    const submitted: string[] = []
    stubs(on, { submitted, jobs: [job()] })
    await start($)
    let ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /working/ }))?.text).toBe('haiku · working…')
    expect(await ui.find({ key: 'send-agent-1' })).toBeUndefined()
    await ui.unmount()
    await finish($, 'agent-1', 'There are **12** TODOs.')
    ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /haiku/ }))?.text).toBe('haiku · done')
    await ui.press({ key: 'send-agent-1' })
    expect(submitted.at(-1)).toBe('Side worker\'s answer to "count the TODOs":\n\nThere are **12** TODOs.')
    await ui.press({ key: 'dismiss-agent-1' })
    await ui.unmount()
    // The in-memory state stub doesn't redraw a mounted pane; mount again.
    ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /No side tasks/ })).toBeDefined()
    await ui.unmount()
  })
}

test('a failed worker shows as failed with no Send button', async ($, on) => {
  stubs(on, { jobs: [job()] })
  await start($)
  await finish($, 'agent-1', '', 'error')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /haiku/ }))?.text).toBe('haiku · failed')
  expect(await ui.find({ key: 'send-agent-1' })).toBeUndefined()
  await ui.unmount()
})
