// bash-fixes: fixes for Claude's Bash tool on Windows Git Bash.
//
// tool.check: refuse `pwsh -Command "..."` whose double-quoted body holds a $
//             Bash would expand before PowerShell sees it, and refuse the rm
//             commands the guard below can't make safe (rm in a -c script, an
//             unguardable variable), saying what to write instead.
// tool.call:  source hooks/guards.sh first (rg, adb, gh api, and Windows /switch
//             tools like powercfg keep arguments that start with /, a no-op
//             `sed -i` fails), add the :? guard to rm targets
//             that start with a variable so an empty variable stops the
//             command instead of deleting from /, turn on pipefail where a
//             pipeline's status gates the rest (a chain or a git write),
//             run a command the Windows command line would cut off or
//             corrupt from a self-deleting temp script, and one where a git
//             write follows other top-level lines from a script run by a
//             child `bash -e`, so a failed edit or check stops a later
//             commit (the tool's own shell ignores set -e). guards.sh also
//             defines `edits` (bin/edits.py), all-or-nothing text edits.
//             A Monitor, or a background Bash job, built on `tail -f` with no
//             end is refused, since it outlives the job it watches. An inline
//             python or node script that rewrites a file with replace or
//             slicing is refused in favor of edits, unless its description
//             carries [script-edit]. A job detached with a trailing & or nohup
//             is refused, since it outlives the call's hidden console and every
//             console program it starts later opens a terminal window.
//             A git command that can throw away other
//             chats' uncommitted work (stash, --autostash, reset --hard, a
//             non-fast-forward merge or pull, ...) is refused in a checkout
//             where repo-peers' heartbeats show another chat (git-guard.ts),
//             unless the description carries [git-solo].
//             In a Desktop-app session, a command that writes HKCU gets a
//             note after its result: the write landed in the app package's
//             private registry, which Windows never reads (hkcuWriteNote).
import type { Register, EngineInterface } from 'claude-code'
import { errexitCommand, needsOffload, scriptText, sourceCommand } from './plan'
import { SOLO_MARK, gitGuardReason, gitHazards, livePeers, type PeerBeat } from './git-guard'
import {
  guardRmTargets,
  hasExpandedPwshDollar,
  hkcuWriteNote,
  editsReason,
  isAgentWorktree,
  detachedJobReason,
  endlessFollow,
  scriptEditReason,
  needsErrexit,
  rmAskAdvice,
  withGuards,
  withPipefail,
} from './guards'

let tempDir: Promise<string | undefined> | undefined
let desktopApp: Promise<boolean> | undefined

// The Claude desktop app is the MSIX package whose registry traps HKCU writes;
// a terminal `claude` writes HKCU for real.
function isDesktopApp($: EngineInterface): Promise<boolean> {
  desktopApp ??= $.env
    .get('CLAUDE_CODE_ENTRYPOINT')
    .then(v => v === 'claude-desktop')
    .catch(() => false)
  return desktopApp
}

// %TEMP% as C:/... so both $.fs and Git Bash read the same path. Undefined
// off Windows, where the limit doesn't apply.
function findTempDir($: EngineInterface): Promise<string | undefined> {
  tempDir ??= $.process
    .run(['cmd', '/d', '/c', 'echo %TEMP%'])
    .then(r => {
      const dir = r.stdout.trim().replaceAll('\\', '/')
      return r.exitCode === 0 && /^[A-Za-z]:\//.test(dir) && !dir.includes("'") ? dir : undefined
    })
    .catch(() => undefined)
  return tempDir
}

const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`

const normDir = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()

// Git Bash and relative paths to C:/... for git -C.
function resolveDir(dir: string | undefined, cwd: string, home: string): string {
  if (!dir) return cwd
  const p = dir.replaceAll('\\', '/')
  if (p === '~' || p.startsWith('~/')) return home + p.slice(1)
  const drive = /^\/([A-Za-z])(\/.*)?$/.exec(p)
  if (drive) return `${drive[1]!.toUpperCase()}:${drive[2] ?? '/'}`
  return /^[A-Za-z]:\//.test(p) ? p : `${cwd}/${p}`
}

// Every heartbeat repo-peers keeps in %TEMP%/claude-peers, one per chat.
async function readBeats($: EngineInterface): Promise<PeerBeat[]> {
  const dir = await findTempDir($)
  if (dir === undefined) return []
  const beats: PeerBeat[] = []
  let entries
  try {
    entries = await $.fs.list(`${dir}/claude-peers`)
  } catch {
    return []
  }
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
    try {
      const raw = await $.fs.read(`${dir}/claude-peers/${e.name}`)
      const b = JSON.parse(typeof raw === 'string' ? raw : '') as PeerBeat
      if (b && typeof b.id === 'string' && typeof b.checkout === 'string') beats.push(b)
    } catch {}
  }
  return beats
}

// Why a git command here could throw away another chat's uncommitted work, if
// it could: a risky shape (git-guard.ts) in a checkout where another chat is
// working or has edited files. Fails open: anything it can't read lets the
// command run.
async function gitRefusal($: EngineInterface, command: string, description: unknown): Promise<string | undefined> {
  if (!/\bgit\b/.test(command) || (typeof description === 'string' && description.includes(SOLO_MARK))) return undefined
  if (gitHazards(command, ['\0']).length === 0) return undefined
  try {
    const [selfId, now, cwd, home, beats] = await Promise.all([
      $.session.id(),
      $.clock.now(),
      $.session.cwd(),
      $.env.get('USERPROFILE').then(h => (h ?? '').replaceAll('\\', '/')),
      readBeats($),
    ])
    const own = beats.find(b => b.id === selfId)?.files ?? []
    for (const hazard of gitHazards(command, own)) {
      const dir = resolveDir(hazard.dir, cwd.replaceAll('\\', '/'), home)
      const top = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
      if (top.exitCode !== 0) continue
      const checkout = normDir(top.stdout.trim())
      const peers = livePeers(beats, selfId, checkout, now)
      if (peers.length > 0) return gitGuardReason(hazard, top.stdout.trim(), peers)
    }
  } catch {}
  return undefined
}

// Commands the shell would hand the wrong text: a double-quoted pwsh body with a
// $, and edits heredocs that are unquoted, unclosed, merged, or cut short. Also
// inline scripts that rewrite a file, which edits does with a loud failure.
function refusal(command: string, description: unknown): string | undefined {
  if (hasExpandedPwshDollar(command)) {
    return (
      'A $ inside a double-quoted pwsh -Command body is expanded by the shell that reads the line first, ' +
      'so pwsh never sees it: Bash here, or the remote PowerShell when the call is inside an ssh string. ' +
      "Put the body in single quotes ('' for a literal quote inside), or pipe a quoted heredoc to " +
      "pwsh -Command - (over ssh: ssh host powershell -NoProfile -Command - <<'PS'). " +
      'A $NAME this command sets itself (NAME=... or for NAME in ...) passes, since Bash filling it in is the point.'
    )
  }
  return (
    editsReason(command) ??
    scriptEditReason(command, typeof description === 'string' ? description : undefined) ??
    detachedJobReason(command)
  )
}

export const register: Register = on => {
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const input = e.input as { command?: unknown; description?: unknown } | undefined
    const command = input?.command
    const reason =
      typeof command === 'string' ? refusal(command, input?.description) ?? (await gitRefusal($, command, input?.description)) : undefined
    if (reason !== undefined) return { decision: 'deny', reason }
    const verdict = await next(e)
    const advice = verdict.decision === 'ask' ? rmAskAdvice(verdict.reason) : undefined
    return advice === undefined ? verdict : { decision: 'deny', reason: advice }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, run) => {
    // The same refusal again: in desktop chats with bypass permissions, a deny from
    // the check above doesn't stop the command, so here it prints the reason and fails.
    const refused =
      refusal(e.command, e.description) ??
      (e.run_in_background ? endlessFollow(e.command) : undefined) ??
      (await gitRefusal($, e.command, e.description))
    if (refused !== undefined) {
      return run({ ...e, command: `printf '%s\\n' ${shellQuote(`refused, so nothing in this command ran: ${refused}`)} >&2; exit 2` })
    }
    // Checked on the command as written, before guards.sh or a script file hides its text.
    const note = (await isDesktopApp($)) ? hkcuWriteNote(e.command) : undefined
    const next: typeof run = async x => {
      const ran = await run(x)
      return note === undefined || ran.deny !== undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
    }
    const base = withPipefail(guardRmTargets(e.command))
    // An isolation-worktree agent gets the in-line fixes only: no guards.sh
    // prefix and no script file, both of which run through `source`. Its
    // `edits` comes from the plugin's bin folder instead.
    let cwd: string | undefined
    try {
      if (e.agentId !== undefined) cwd = await $.session.cwd()
    } catch {}
    if (isAgentWorktree(cwd, e.agentId)) return next({ ...e, command: base })
    const errexit = needsErrexit(base)
    const command = withGuards(base, $.plugin.root)
    if (!errexit && !needsOffload(command)) return next({ ...e, command })
    const dir = await findTempDir($)
    if (dir === undefined) return next({ ...e, command })

    const path = `${dir}/claude-long-bash-${crypto.randomUUID()}.sh`
    await $.fs.write(path, scriptText(command))
    const ran = await next({ ...e, command: errexit ? errexitCommand(path) : sourceCommand(path) })

    // The script deletes itself; this catches a parse error on its first line.
    if (!e.run_in_background && (await $.fs.exists(path))) {
      await $.process.run(['cmd', '/d', '/c', 'del', '/q', path.replaceAll('/', '\\')]).catch(() => {})
    }
    return ran
    // On a throw, next(e) runs the original command if the call hadn't started,
    // or replays the result it already produced.
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Monitor' }, ($, e, next) => {
    const reason = typeof e.command === 'string' ? endlessFollow(e.command) : undefined
    return reason === undefined ? next(e) : { deny: reason }
  }).catch(($, e, next) => next(e))
}
