// bash-fixes: fixes for Claude's Bash tool on Windows Git Bash.
//
// tool.check: refuse `pwsh -Command "..."` whose double-quoted body holds a $
//             Bash would expand before PowerShell sees it, and refuse the rm
//             commands the guard below can't make safe (rm in a -c script, an
//             unguardable variable), saying what to write instead.
// tool.call:  source hooks/guards.sh first (rg keeps patterns that start
//             with /, a no-op `sed -i` fails), add the :? guard to rm targets
//             that start with a variable so an empty variable stops the
//             command instead of deleting from /, turn on pipefail where a
//             pipeline's status gates the rest (a chain or a git write),
//             run a command the Windows command line would cut off or
//             corrupt from a self-deleting temp script, and one where a git
//             write follows other top-level lines from a script run by a
//             child `bash -e`, so a failed edit or check stops a later
//             commit (the tool's own shell ignores set -e). guards.sh also
//             defines `edits` (bin/edits.py), all-or-nothing text edits.
import type { Register, EngineInterface } from 'claude-code'
import { errexitCommand, needsOffload, scriptText, sourceCommand } from './plan'
import { guardRmTargets, hasExpandedPwshDollar, needsErrexit, rmAskAdvice, withGuards, withPipefail } from './guards'

let tempDir: Promise<string | undefined> | undefined

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

export const register: Register = on => {
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const command = (e.input as { command?: unknown })?.command
    if (typeof command === 'string' && hasExpandedPwshDollar(command)) {
      return {
        decision: 'deny',
        reason:
          'Bash expands $ inside double quotes before pwsh sees it. Put the -Command body in single quotes ' +
          "('' for a literal quote inside), or pipe a quoted heredoc to pwsh -Command -.",
      }
    }
    const verdict = await next(e)
    const advice = verdict.decision === 'ask' ? rmAskAdvice(verdict.reason) : undefined
    return advice === undefined ? verdict : { decision: 'deny', reason: advice }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const base = withPipefail(guardRmTargets(e.command))
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
}
