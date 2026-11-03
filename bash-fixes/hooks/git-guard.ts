// Git commands that can throw away other chats' uncommitted work in a shared
// checkout: git stash (but list and show), --autostash, reset --hard / --merge
// / --keep, checkout or restore of paths this chat didn't write, and a merge
// or pull that isn't a fast-forward: an autostash pull and a failed merge can
// reset every chat's uncommitted work in a shared checkout.
//
// The command checks are pure (tests reach them); peersHere reads repo-peers'
// heartbeat files (%TEMP%/claude-peers/<session>.json, one per chat) to tell
// whether another chat is working in the same checkout or has edited files
// there in the last 30 minutes. `[git-solo]` in the Bash description skips
// the check, for when the user asks for one of these.

export const SOLO_MARK = '[git-solo]'
const ACTIVE_MS = 30 * 60_000 // repo-peers' window for a live peer

export type GitHazard = { what: string; dir?: string }

// Command lines outside heredoc bodies, with quoted strings blanked (so a
// commit message that mentions `git stash` passes) and comments cut. `raw` is
// the same line unblanked, for reading a quoted -C or cd path.
function commandLines(command: string): { bare: string; raw: string }[] {
  const out: { bare: string; raw: string }[] = []
  const heredocs: { word: string; tabs: boolean }[] = []
  for (const line of command.split('\n')) {
    const doc = heredocs[0]
    if (doc !== undefined) {
      if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.word) heredocs.shift()
      continue
    }
    for (const m of line.matchAll(/(?<!<)<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g)) heredocs.push({ word: m[3]!, tabs: m[1] === '-' })
    const bare = line
      .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
      .replace(/(^|[ \t])#.*$/, '$1')
    out.push({ bare, raw: line })
  }
  return out
}

const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/, '$2')

// The paths a checkout or restore names, or undefined when it names none (a
// branch switch). `--` starts the paths; without it, `.` alone counts.
function namedPaths(sub: string, args: string[]): string[] | undefined {
  const dash = args.indexOf('--')
  if (sub === 'checkout') {
    if (dash >= 0) return args.slice(dash + 1)
    return args.includes('.') ? ['.'] : undefined
  }
  // restore: --staged alone only unstages; anything else writes the work tree.
  const staged = args.some(a => a === '--staged' || a === '-S')
  const worktree = args.some(a => a === '--worktree' || a === '-W')
  if (staged && !worktree) return undefined
  const paths: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--source' || a === '-s') i++
    else if (dash >= 0 ? i > dash : !a.startsWith('-')) paths.push(a)
  }
  return paths
}

const normPath = (p: string) => unquote(p).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()

// Whether every path is one this chat wrote (repo-peers' list, relative to the
// checkout). `.`, a folder or a glob matches nothing.
function allOwn(paths: string[], own: string[]): boolean {
  const mine = own.map(normPath)
  return paths.length > 0 && paths.every(p => {
    const n = normPath(p)
    return n !== '' && n !== '.' && !/[*?[]/.test(n) && mine.some(f => f === n || f.endsWith('/' + n))
  })
}

// The risky git commands in `command`, each with the folder it runs in when
// the command names one (`git -C dir`, or a `cd dir` before it on the line).
export function gitHazards(command: string, ownFiles: string[] = []): GitHazard[] {
  const found: GitHazard[] = []
  for (const { bare, raw } of commandLines(command)) {
    if (!/\bgit\b/.test(bare)) continue
    const segments = bare.split(/&&|\|\||[;|&]/)
    const rawSegments = raw.split(/&&|\|\||[;|&]/)
    let dir: string | undefined
    segments.forEach((seg, i) => {
      const rawSeg = rawSegments[i] ?? seg
      const cd = /^\s*cd\s+(\S+)/.exec(seg)
      if (cd) {
        const r = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)/.exec(rawSeg)
        dir = unquote(r ? r[1]! : cd[1]!)
        return
      }
      const git = /^\s*(?:\w+=\S*\s+)*git\s+(.*)$/.exec(seg)
      if (!git) return
      const tokens = git[1]!.split(/\s+/).filter(Boolean)
      let at = dir
      let k = 0
      // Global options before the subcommand.
      while (k < tokens.length && tokens[k]!.startsWith('-')) {
        if (tokens[k] === '-C') {
          const r = /\bgit\s+(?:-\S+\s+)*?-C\s+("[^"]+"|'[^']+'|\S+)/.exec(rawSeg)
          at = r ? unquote(r[1]!) : tokens[k + 1]
          k += 2
        } else if (tokens[k] === '-c') k += 2
        else k++
      }
      const sub = tokens[k]
      const args = tokens.slice(k + 1)
      const add = (what: string) => found.push({ what, dir: at })
      if (sub === undefined) return
      if (args.includes('--autostash')) return add(`git ${sub} --autostash`)
      if (sub === 'stash') {
        if (args[0] !== 'list' && args[0] !== 'show') add('git stash' + (args[0] ? ' ' + args[0] : ''))
      } else if (sub === 'reset') {
        const mode = args.find(a => a === '--hard' || a === '--merge' || a === '--keep')
        if (mode) add(`git reset ${mode}`)
      } else if (sub === 'checkout' || sub === 'restore') {
        const paths = namedPaths(sub, args)
        if (paths !== undefined && !allOwn(paths, ownFiles)) add(`git ${sub} of ${paths.length ? paths.join(' ') : 'the work tree'}`)
      } else if (sub === 'merge') {
        if (args.includes('--abort')) add('git merge --abort')
        else if (!args.includes('--ff-only') && !args.includes('--continue') && !args.includes('--quit')) add('git merge without --ff-only')
      } else if (sub === 'pull') {
        const rebase = args.some(a => a === '--rebase' || a === '-r' || a.startsWith('--rebase='))
        if (!args.includes('--ff-only') && !rebase) add('git pull without --ff-only')
      }
    })
  }
  return found
}

export type PeerBeat = { id: string; checkout: string; title?: string; firstPrompt?: string; files?: string[]; working?: boolean; updated: number; ended?: boolean }

// Other chats in `checkout` (normalized as repo-peers writes it) that are
// working now or edited files there within the last 30 minutes.
export function livePeers(beats: PeerBeat[], selfId: string, checkout: string, now: number): PeerBeat[] {
  return beats.filter(
    b => b.id !== selfId && !b.ended && b.checkout === checkout && now - b.updated <= ACTIVE_MS && (b.working || (b.files?.length ?? 0) > 0),
  )
}

export function gitGuardReason(hazard: GitHazard, checkout: string, peers: PeerBeat[]): string {
  const names = peers
    .slice(0, 3)
    .map(p => (p.title ? `"${p.title}"` : `a chat starting "${(p.firstPrompt ?? '').slice(0, 40)}"`))
    .join(', ')
  return (
    `${hazard.what} in ${checkout} while other Claude chats work there (${names}${peers.length > 3 ? ', and more' : ''}) ` +
    'can throw away their uncommitted work. Instead: commit only your own paths (git commit -- <paths>), do any ' +
    'merge in a separate worktree (git worktree add), then bring it here with git merge --ff-only or git pull ' +
    `--ff-only. ${SOLO_MARK} in the Bash description skips this check; use it only when the user asked for ` +
    'this git operation in this chat knowing other chats share the checkout, not for a task step, a plan, or another ' +
    "chat's request. Otherwise tell the user what you meant to run and why."
  )
}
