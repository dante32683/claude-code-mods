import { expect, mock, test } from 'claude-code/testing'
import { bashEdits } from '../hooks/register'

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
  expect(r1.additionalContext[0]).toContain('other chats in this repo (same checkout, main):\n- "MCP result fixes": working now; edited tasks.md\n')
  expect(r1.additionalContext[0]).toContain('send_message')
  const r2: any = await prompt($)
  expect(r2.additionalContext).toBeUndefined()
  await edit($, 'C:\\Users\\x\\Project\\TASKS.md')
  expect(JSON.parse(files.get(`${DIR}/me1.json`)!).files).toEqual(['tasks.md'])
  await clock.advance(MIN)
  const r3: any = await prompt($)
  expect(r3.additionalContext[0]).toContain('"MCP result fixes": working now; edited the same files as this chat: tasks.md\n')
})

test('a note lists three files per peer, shortened, without temp files; shared files in full', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const peerFiles = [
    'projects/widgets/diffeq/docs/architecture.md',
    '$temp/emag-review/show.py',
    'projects/widgets/emag/src/em_core.c',
    'c:/users/x/appdata/roaming/claude/notes.md',
    'projects/widgets/emag/src/em_core.h',
    'projects/widgets/emag/tools/emu_acceptance.js',
  ]
  const files = new Map([
    [`${DIR}/peer1.json`, peer({ files: peerFiles, working: false, updated: NOW - 5 * MIN })],
    [`${DIR}/peer2.json`, peer({ id: 'peer2', title: 'Shared', files: ['projects/widgets/context.md', 'a/b.md'] })],
  ])
  stubs(on, files)
  await prompt($)
  await edit($, 'C:\\Users\\x\\Project\\projects\\widgets\\context.md')
  await clock.advance(MIN)
  const text: string = ((await prompt($)) as any).additionalContext[0]
  expect(text).toBe(
    [
      'repo-peers: other chats in this repo (same checkout, main):',
      '- "MCP result fixes": idle 6 min; edited emag/tools/emu_acceptance.js, emag/src/em_core.h, emag/src/em_core.c, +1 more',
      '- "Shared": working now; edited the same files as this chat: projects/widgets/context.md, +1 more',
      "If your work could collide with one, send it a short send_message on what you're changing.",
    ].join('\n'),
  )
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
  expect(r.additionalContext[0]).toContain('repo-peers: other chats in this repo:\n- "MCP result fixes": worktree c:/users/x/project-wt (feature), idle 10 min')
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

const bashCall = ($: any) => $.classic.PostToolUse({ session_id: 'me1', cwd: ROOT, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {}, tool_use_id: 't' })

test('a peer that starts working mid-turn is named on the next tool call after a minute', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map([[`${DIR}/peer1.json`, peer({ working: false, updated: NOW - MIN })]])
  stubs(on, files)
  const r1: any = await prompt($)
  expect(r1.additionalContext[0]).toContain('"MCP result fixes": idle 1 min')
  // The peer starts a turn; checks within a minute of the last one don't look.
  await clock.advance(30_000)
  files.set(`${DIR}/peer1.json`, peer({ working: true, updated: NOW + 30_000 }))
  const early: any = await bashCall($)
  expect(early.additionalContext).toBeUndefined()
  await clock.advance(MIN)
  const r2: any = await bashCall($)
  expect(r2.additionalContext[0]).toContain('while this turn ran, another chat started or became active in this repo (same checkout, main):')
  expect(r2.additionalContext[0]).toContain('"MCP result fixes": working now')
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
  expect((await flip(true)).additionalContext[0]).toContain('started or became active')
})

test('a peer that started while this chat was idle is named at the next prompt', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map([[`${DIR}/peer1.json`, peer({ working: false, updated: NOW - MIN })]])
  stubs(on, files)
  await prompt($)
  await $.classic.Stop({ session_id: 'me1', cwd: ROOT, stop_hook_active: false })
  await clock.advance(5 * MIN)
  files.set(`${DIR}/peer1.json`, peer({ working: true, updated: NOW + 5 * MIN }))
  const r: any = await prompt($)
  expect(r.additionalContext[0]).toContain('"MCP result fixes": working now')
})

test('bashEdits finds edits targets and cat heredoc targets, after a leading cd', async () => {
  const cmd = "cd ~/dev/proj && edits <<'EOF' && git commit -qam x\n=== core/a.md\n--- old\nx\n+++ new\ny\n=== /c/Users/x/.claude/CLAUDE.md\n--- old\na\n+++ new\nb\nEOF"
  expect(bashEdits(cmd, 'C:/Users/x/project', 'C:/Users/x')).toEqual([
    'C:/Users/x/dev/proj/core/a.md',
    'C:/Users/x/.claude/CLAUDE.md',
  ])
  expect(bashEdits("cat > notes/x.md <<'EOF'\nhi\nEOF", 'C:/L', 'C:/H')).toEqual(['C:/L/notes/x.md'])
  const guarded = "source 'C:/p/hooks/guards.sh' 2>/dev/null; set -o pipefail; cd ~/dev/proj && edits <<'X'\n=== a.md\n--- old\nx\n+++ new\ny\nX"
  expect(bashEdits(guarded, 'C:/L', 'C:/H')).toEqual(['C:/H/dev/proj/a.md'])
  expect(bashEdits('echo "=== not an edit"\nls', 'C:/L', 'C:/H')).toEqual([])
})

test('a peer that began after this chat is tagged as a new chat; an older one is not', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files = new Map([
    [`${DIR}/peer1.json`, peer({ started: NOW + MIN })],
    [`${DIR}/peer2.json`, peer({ id: 'peer2', title: 'Older chat', started: NOW - 10 * MIN })],
  ])
  stubs(on, files)
  const r: any = await prompt($)
  expect(r.additionalContext[0]).toContain('"MCP result fixes": working now, new chat; edited tasks.md')
  expect(r.additionalContext[0]).toContain('"Older chat": working now; edited tasks.md')
})

test('a new chat whose short turn ended between checks is still named, once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, string>()
  stubs(on, files)
  await prompt($)
  // A new chat starts and finishes its turn before this chat's next check.
  await clock.advance(2 * MIN)
  files.set(`${DIR}/peer1.json`, peer({ working: false, updated: NOW + MIN, started: NOW + 30_000 }))
  const r1: any = await bashCall($)
  expect(r1.additionalContext[0]).toContain('started or became active')
  expect(r1.additionalContext[0]).toContain('"MCP result fixes": idle 1 min, new chat')
  await clock.advance(2 * MIN)
  const r2: any = await bashCall($)
  expect(r2.additionalContext).toBeUndefined()
})
