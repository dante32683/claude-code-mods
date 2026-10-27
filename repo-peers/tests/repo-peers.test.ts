import { expect, mock, test } from 'claude-code/testing'

const DIR = 'C:/Temp/claude-peers'
const REPO = 'c:/users/x/project/.git'
const ROOT = 'c:/users/x/project'
const NOW = 1e12
const MIN = 60_000

function stubs(on: any, files: Map<string, string>, git: string | null = `C:/Users/x/project/.git\nC:/Users/x/project\nmain\n`) {
  const key = (p: string) => p.replaceAll('\\', '/')
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const fail = { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
  on('process.run', ($: any, e: any) => (e.argv[0] === 'cmd' ? ok('C:\\Temp\r\n') : git === null ? fail : ok(git)))
  on('fs.write', ($: any, e: any) => {
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', ($: any, e: any) => ({ value: files.get(key(e.path)) ?? '' }))
  on('fs.list', ($: any, e: any) => {
    const d = key(e.path) + '/'
    const names = [...files.keys()].filter(k => k.startsWith(d)).map(k => k.slice(d.length))
    return { value: names.map(name => ({ name, kind: 'file', size: 1, mtimeMs: NOW, isLink: false })) }
  })
  for (const ev of ['classic.UserPromptSubmit', 'classic.PostToolUse', 'classic.Stop', 'classic.SessionEnd']) on(ev, () => ({ value: {} }))
}

const peer = (over: object = {}) =>
  JSON.stringify({ id: 'peer1', repo: REPO, checkout: ROOT, branch: 'main', title: 'MCP result fixes', firstPrompt: 'fix the mcps', files: ['tasks.md'], working: true, updated: NOW - 2 * MIN, ended: false, ...over })

const prompt = ($: any, text = 'hi') => $.classic.UserPromptSubmit({ session_id: 'me1', cwd: 'C:\\Users\\x\\Project', prompt: text, session_title: 'My chat' })
const edit = ($: any, file: string) => $.classic.PostToolUse({ session_id: 'me1', cwd: 'C:\\Users\\x\\Project', tool_name: 'Edit', tool_input: { file_path: file }, tool_response: {}, tool_use_id: 't' })

test('no peers: no note, and this chat writes its heartbeat', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files = new Map<string, string>()
  stubs(on, files)
  const r: any = await prompt($)
  expect(r.additionalContext).toBeUndefined()
  const beat = JSON.parse(files.get(`${DIR}/me1.json`)!)
  expect(beat).toMatchObject({ repo: REPO, checkout: ROOT, branch: 'main', title: 'My chat', working: true })
})

test('a working peer in the same checkout is named once, then again when files overlap', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map([[`${DIR}/peer1.json`, peer()]])
  stubs(on, files)
  const r1: any = await prompt($)
  expect(r1.additionalContext[0]).toContain('"MCP result fixes": same checkout (main), working now (updated 2 min ago)')
  expect(r1.additionalContext[0]).toContain('edited: tasks.md')
  expect(r1.additionalContext[0]).toContain('send_message')
  const r2: any = await prompt($)
  expect(r2.additionalContext).toBeUndefined()
  await edit($, 'C:\\Users\\x\\Project\\TASKS.md')
  expect(JSON.parse(files.get(`${DIR}/me1.json`)!).files).toEqual(['tasks.md'])
  await clock.advance(MIN)
  const r3: any = await prompt($)
  expect(r3.additionalContext[0]).toContain('edited the same files as this chat: tasks.md')
})

test('a turn end marks this chat idle, and a session end marks it ended', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files = new Map<string, string>()
  stubs(on, files)
  await prompt($)
  await $.classic.Stop({ session_id: 'me1', cwd: ROOT, stop_hook_active: false })
  expect(JSON.parse(files.get(`${DIR}/me1.json`)!).working).toBe(false)
  await $.classic.SessionEnd({ session_id: 'me1', cwd: ROOT, reason: 'other' })
  expect(JSON.parse(files.get(`${DIR}/me1.json`)!).ended).toBe(true)
})

for (const [name, over] of [
  ['another repo', { repo: 'c:/users/x/other/.git' }],
  ['an ended chat', { ended: true }],
  ['a chat idle over 30 minutes', { updated: NOW - 31 * MIN, working: false }],
] as const) {
  test(`ignores ${name}`, async ($, on) => {
    mock.clock(on, { now: NOW })
    stubs(on, new Map([[`${DIR}/peer1.json`, peer(over)]]))
    const r: any = await prompt($)
    expect(r.additionalContext).toBeUndefined()
  })
}

test('a peer in another worktree of the repo is named with its path', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on, new Map([[`${DIR}/peer1.json`, peer({ checkout: 'c:/users/x/project-wt', branch: 'feature', working: false, updated: NOW - 10 * MIN })]]))
  const r: any = await prompt($)
  expect(r.additionalContext[0]).toContain('worktree c:/users/x/project-wt (feature), idle since 10 min ago')
})

test('outside a git repo it stays quiet and writes nothing', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files = new Map<string, string>()
  stubs(on, files, null)
  const r: any = await prompt($)
  expect(r.additionalContext).toBeUndefined()
  expect(files.size).toBe(0)
})

test('any tool call refreshes the heartbeat, at most every 2 minutes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, string>()
  stubs(on, files)
  await prompt($)
  const bash = () => $.classic.PostToolUse({ session_id: 'me1', cwd: ROOT, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {}, tool_use_id: 't' })
  await clock.advance(MIN)
  await bash()
  expect(JSON.parse(files.get(`${DIR}/me1.json`)!).updated).toBe(NOW)
  await clock.advance(2 * MIN)
  await bash()
  expect(JSON.parse(files.get(`${DIR}/me1.json`)!).updated).toBe(NOW + 3 * MIN)
})

const bashCall = ($: any) => $.classic.PostToolUse({ session_id: 'me1', cwd: 'C:\\Users\\x\\Project', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {}, tool_use_id: 't' })

test('a peer that starts working mid-turn is named on the next tool call after a minute', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map([[`${DIR}/peer1.json`, peer({ working: false, updated: NOW - MIN })]])
  stubs(on, files)
  const r1: any = await prompt($)
  expect(r1.additionalContext[0]).toContain('idle since just now')
  // The peer starts a turn; checks within a minute of the last one don't look.
  await clock.advance(30_000)
  files.set(`${DIR}/peer1.json`, peer({ working: true, updated: NOW + 30_000 }))
  const early: any = await bashCall($)
  expect(early.additionalContext).toBeUndefined()
  await clock.advance(MIN)
  const r2: any = await bashCall($)
  expect(r2.additionalContext[0]).toContain('while this turn ran, another Claude chat started working')
  expect(r2.additionalContext[0]).toContain('"MCP result fixes": same checkout (main), working now')
  // Still working: not named again.
  await clock.advance(2 * MIN)
  const r3: any = await bashCall($)
  expect(r3.additionalContext).toBeUndefined()
})

test('a peer that keeps starting turns is named for starting at most every 15 minutes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map([[`${DIR}/peer1.json`, peer()]])
  stubs(on, files)
  const r1: any = await prompt($) // named as working
  expect(r1.additionalContext[0]).toContain('working now')
  const flip = async (working: boolean) => {
    await clock.advance(2 * MIN)
    files.set(`${DIR}/peer1.json`, peer({ working, updated: NOW }))
    return (await bashCall($)) as any
  }
  await flip(false)
  expect((await flip(true)).additionalContext).toBeUndefined() // 4 min after being named
  await clock.advance(12 * MIN)
  await flip(false)
  expect((await flip(true)).additionalContext[0]).toContain('started working')
})

test('a peer that started while this chat was idle is named at the next prompt', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map([[`${DIR}/peer1.json`, peer({ working: false, updated: NOW - MIN })]])
  stubs(on, files)
  await prompt($)
  await $.classic.Stop({ session_id: 'me1', cwd: 'C:\\Users\\x\\Project', stop_hook_active: false })
  await clock.advance(5 * MIN)
  files.set(`${DIR}/peer1.json`, peer({ working: true, updated: NOW + 5 * MIN }))
  const r: any = await prompt($)
  expect(r.additionalContext[0]).toContain('"MCP result fixes": same checkout (main), working now')
})
