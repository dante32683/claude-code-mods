import { test, expect } from 'claude-code/testing'
import { gitHazards, livePeers, gitGuardReason } from '../hooks/git-guard'

const what = (command: string, own: string[] = []) => gitHazards(command, own).map(h => h.what)

test('stash, autostash, and hard resets are caught', () => {
  expect(what('git stash')).toEqual(['git stash'])
  expect(what('git stash push -m wip')).toEqual(['git stash push'])
  expect(what('git stash pop')).toEqual(['git stash pop'])
  expect(what('git pull --rebase --autostash')).toEqual(['git pull --autostash'])
  expect(what('git rebase --autostash origin/main')).toEqual(['git rebase --autostash'])
  expect(what('git reset --hard origin/main')).toEqual(['git reset --hard'])
  expect(what('git reset --merge')).toEqual(['git reset --merge'])
  expect(what('git reset --keep HEAD~1')).toEqual(['git reset --keep'])
})

test('merges and pulls that are not fast-forwards are caught', () => {
  expect(what('git merge origin/claude/x')).toEqual(['git merge without --ff-only'])
  expect(what('git merge --no-ff topic')).toEqual(['git merge without --ff-only'])
  expect(what('git merge --abort')).toEqual(['git merge --abort'])
  expect(what('git pull')).toEqual(['git pull without --ff-only'])
  expect(what('git pull origin main')).toEqual(['git pull without --ff-only'])
})

test('checkout and restore of paths this chat did not write are caught', () => {
  expect(what('git checkout -- .')).toEqual(['git checkout of .'])
  expect(what('git checkout .')).toEqual(['git checkout of .'])
  expect(what('git checkout HEAD -- TASKS.md')).toEqual(['git checkout of TASKS.md'])
  expect(what('git restore NOW.md')).toEqual(['git restore of NOW.md'])
  expect(what('git restore --worktree --staged projects/x')).toEqual(['git restore of projects/x'])
  // A path this chat wrote (repo-peers' list) may be put back.
  expect(what('git restore projects/a/context.md', ['projects/a/context.md'])).toEqual([])
  expect(what('git checkout -- ./projects/a/context.md', ['projects/a/context.md'])).toEqual([])
  expect(what('git restore projects/a', ['projects/a/context.md'])).toEqual(['git restore of projects/a'])
})

test('safe shapes pass', () => {
  for (const ok of [
    'git stash list',
    'git stash show -p stash@{0}',
    'git reset',
    'git reset HEAD TASKS.md',
    'git reset --soft HEAD~1',
    'git merge --ff-only origin/main',
    'git pull --ff-only',
    'git pull --rebase',
    'git pull -q --ff-only origin main',
    'git checkout main',
    'git checkout -b topic',
    'git restore --staged TASKS.md',
    'git merge-base HEAD origin/main',
    'git status --short && git log --oneline -3',
    'git commit -m "never git stash or git reset --hard here" -- a.md',
    "cat > notes.md <<'EOF'\ngit stash\ngit merge x\nEOF",
    'echo done # git stash later',
  ]) {
    expect(what(ok)).toEqual([])
  }
})

test('the folder comes from git -C or a cd before it', () => {
  expect(gitHazards('git -C "C:/Users/x/proj" stash')).toEqual([{ what: 'git stash', dir: 'C:/Users/x/proj' }])
  expect(gitHazards('cd /c/Users/x/dev/mods && git status && git stash')).toEqual([{ what: 'git stash', dir: '/c/Users/x/dev/mods' }])
  expect(gitHazards('git reset --hard')).toEqual([{ what: 'git reset --hard', dir: undefined }])
})

test('only live chats in the same checkout count', () => {
  const now = 1_000_000_000
  const beats = [
    { id: 'me', checkout: 'c:/proj', working: true, updated: now },
    { id: 'busy', checkout: 'c:/proj', title: 'Busy', working: true, updated: now - 60_000 },
    { id: 'edited', checkout: 'c:/proj', working: false, files: ['a.md'], updated: now - 20 * 60_000 },
    { id: 'idle', checkout: 'c:/proj', working: false, files: [], updated: now - 60_000 },
    { id: 'old', checkout: 'c:/proj', working: true, updated: now - 40 * 60_000 },
    { id: 'ended', checkout: 'c:/proj', working: true, ended: true, updated: now },
    { id: 'tree', checkout: 'c:/proj-wt', working: true, updated: now },
  ]
  expect(livePeers(beats, 'me', 'c:/proj', now).map(b => b.id)).toEqual(['busy', 'edited'])
  const reason = gitGuardReason({ what: 'git stash' }, 'C:/proj', livePeers(beats, 'me', 'c:/proj', now))
  expect(reason).toContain('"Busy"')
  expect(reason).toContain('git worktree add')
  expect(reason).toContain('--ff-only')
  expect(reason).toContain('[git-solo]')
})

const PEERS = 'C:/T/claude-peers'
function engine(on: any, beats: object[], ran: string[]) {
  on('process.run', ($: any, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'cmd') return { value: { exitCode: 0, stdout: 'C:\\T\r\n', stderr: '' } }
    if (argv[0] === 'git') return { value: { exitCode: 0, stdout: 'C:/Users/x/proj\n', stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
  on('fs.list', () => ({ value: beats.map((b: any) => ({ name: b.id + '.json', kind: 'file', size: 10, mtimeMs: 0, isLink: false })) }))
  on('fs.read', ($: any, e: any) => ({ value: JSON.stringify(beats.find((b: any) => String(e.path).replaceAll("\\", "/").endsWith(`claude-peers/${b.id}.json`))) }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: 'C:\\Users\\x\\proj' }))
  on('env.get', () => ({ value: 'C:\\Users\\x' }))
  on('clock.now', () => ({ value: 5_000_000 }))
  on('tool.call', { tool: 'Bash' }, ($: any, e: any) => (ran.push(e.command), { result: { stdout: '', stderr: '' } }))
}

test('a stash is refused while another chat works in the checkout, and runs alone or with [git-solo]', async ($, on) => {
  const beats: object[] = [{ id: 'me', checkout: 'c:/users/x/proj', working: true, files: [], updated: 5_000_000 }]
  const ran: string[] = []
  engine(on, beats, ran)
  await ($ as any).tool.call({ tool: 'Bash', command: 'git stash' })
  expect(ran.at(-1)).not.toContain('refused')

  beats.push({ id: 'peer', checkout: 'c:/users/x/proj', title: 'Math 2', working: true, files: [], updated: 4_990_000 })
  await ($ as any).tool.call({ tool: 'Bash', command: 'git stash' })
  expect(ran.at(-1)).toContain('refused, so nothing in this command ran: git stash in C:/Users/x/proj')
  expect(ran.at(-1)).toContain('"Math 2"')

  await ($ as any).tool.call({ tool: 'Bash', command: 'git stash', description: 'Stash as the user asked [git-solo]' })
  expect(ran.at(-1)).not.toContain('refused')
  await ($ as any).tool.call({ tool: 'Bash', command: 'git pull --ff-only' })
  expect(ran.at(-1)).not.toContain('refused')
})

test('an isolation-worktree agent runs commands without the source prefix; others keep it', async ($, on) => {
  const ran: string[] = []
  let cwd = 'C:\\Users\\x\\proj\\.claude\\worktrees\\agent-a1b2c3'
  on('session.cwd', (_$: any, _e: any) => ({ value: cwd }) as any)
  on('session.id', () => ({ value: 'me' }))
  on('process.run', (_$: any, _e: any) => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as any)
  on('fs.list', (_$: any, _e: any) => ({ value: [] }) as any)
  on('tool.call', { tool: 'Bash' }, ($: any, e: any) => (ran.push(e.command), { result: { stdout: '', stderr: '' } }))
  await ($ as any).tool.call({ tool: 'Bash', command: 'pwd && git status', agentId: 'a1' })
  expect(ran.at(-1)).toBe('pwd && git status')
  // In-line fixes still apply there.
  await ($ as any).tool.call({ tool: 'Bash', command: 'git log | head -1 && echo ok', agentId: 'a1' })
  expect(ran.at(-1)).toContain('set -o pipefail')
  expect(ran.at(-1)).not.toContain('source')
  // The main loop in the same folder, and an agent elsewhere, keep the guards.
  await ($ as any).tool.call({ tool: 'Bash', command: 'pwd' })
  expect(ran.at(-1)).toContain("source '")
  cwd = 'C:\\Users\\x\\proj'
  await ($ as any).tool.call({ tool: 'Bash', command: 'pwd', agentId: 'a2' })
  expect(ran.at(-1)).toContain("source '")
})
