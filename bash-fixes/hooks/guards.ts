// Command checks and the guards.sh prefix. Pure functions, so tests reach them.

// A pwsh or powershell call with -c or -Command and a double-quoted body.
const PWSH_BODY = /(?:^|[\s;&|(])(?:pwsh|powershell)(?:\.exe)?\b[^\n;&|]*?\s-(?:c|command)\s+"((?:[^"\\]|\\.)*)"/gi

// A $ Bash expands inside double quotes: unescaped, before a name, {, (, or
// a special parameter.
const EXPANDED = /(?<!\\)\$[A-Za-z_{(?!$@*#0-9-]/

export function hasExpandedPwshDollar(command: string): boolean {
  for (const m of command.matchAll(PWSH_BODY)) {
    if (EXPANDED.test(m[1] ?? '')) return true
  }
  return false
}

// An rm or rmdir whose target starts with a shell variable is risky: when the
// variable is empty, "$S"/x turns into /x. Bash's :? guard makes the command
// stop with an error instead when the variable is empty or unset, and changes
// nothing when it's set. So add it: "$S"/x and ${S}/x become "${S:?}"/x and
// ${S:?}/x in the arguments of an rm or rmdir that starts a command, including
// one inside a -c script string (bash -c "rm ...", wsl.exe -e bash -c '... &&
// rm ...'). Claude Code's empty-variable rm check accepts the guarded form.
// Positional parameters and ${S:-...} forms are left alone.
const RM = /(^|[\n;&|(`]|\b(?:then|do|else)\b|-c[ \t]+["'])([ \t]*)(rm|rmdir)(?=[ \t])([^\n;&|)`]*)/g
const TARGET = /(^|[ \t])("?)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(?="?\/)/g

export function guardRmTargets(command: string): string {
  return command.replace(RM, (_m, start, space, rm, args: string) =>
    start + space + rm + args.replace(TARGET, (_t, lead, quote, braced, bare) => `${lead}${quote}\${${braced ?? bare}:?}`),
  )
}

// The rm commands the guard above can't make safe: an rm inside a bash -c,
// sh -c, wsl or eval script, which Claude Code can't inspect, and a variable a
// guard doesn't protect ($HOME-style, or set in the command from a value that
// can be / or a top-level folder). Claude Code flags these for review; the hook
// refuses them instead and says how to rewrite the command with a literal path.
// Matches Claude Code's own wording (2.1.304), both its dialog line and its
// longer message.
const SHELL_C_RM = /shell -c script (?:that )?runs rm|Dangerous rm(?:dir)? operation in a shell -c script/
const UNGUARDED_RM = /^Dangerous rm(?:dir)? operation[\s\S]*(?:is a shell variable expansion|This command sets \$|on possibly-empty variable path)/

export function rmAskAdvice(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  if (SHELL_C_RM.test(reason)) {
    return (
      'Claude Code cannot check an rm inside a bash -c, sh -c, wsl or eval script, so it would stop for approval. ' +
      'Run the rm as its own Git Bash command on the Windows path, e.g. D="C:/.../dir" && rm -f "$D"/*.png ' +
      '(the $D target is guarded automatically), then run the rest in WSL or the -c script.'
    )
  }
  if (UNGUARDED_RM.test(reason)) {
    const why = reason.split('\n')[0]!.replace(/ This requires explicit approval[^.]*\./, '')
    return `This rm would stop for approval: ${why} Write the target as a literal absolute path.`
  }
  return undefined
}

export function withGuards(command: string, root: string): string {
  const script = root.replaceAll('\\', '/') + '/hooks/guards.sh'
  return `source '${script}' 2>/dev/null; ${command}`
}

// Git Bash runs without pipefail, so `check | tail -1 && git commit` commits
// after a failed check, and `git push 2>&1 | tail -1` reports success when
// the push failed. Turn pipefail on when a pipeline's status is consumed: a
// `&&` or `||` after a pipe, or a git command that changes the repository or a
// remote anywhere in a command with a pipe. A pipe into `head` can then fail
// on SIGPIPE; that stops the chain visibly, which is the safe way to be wrong.
const PIPE = /(?<![|])\|(?![|&])/
const CHAIN_AFTER_PIPE = /(?<![|])\|(?![|&])[\s\S]*(?:&&|\|\|)/
const GIT_WRITE = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push|merge|rebase|pull|tag|reset|cherry-pick|am)\b/

export function needsPipefail(command: string): boolean {
  if (!PIPE.test(command) || /\bpipefail\b/.test(command)) return false
  return CHAIN_AFTER_PIPE.test(command) || GIT_WRITE.test(command)
}

export function withPipefail(command: string): string {
  return needsPipefail(command) ? `set -o pipefail; ${command}` : command
}

// Lines separated by newlines run one after another whatever the earlier ones
// returned, so a failed edit or check on line 1 still lets `git commit` on
// line 2 run. When a command with a git write has more than one top-level
// line, it runs in a child `bash -e` (register.ts) so the first failing line
// stops it. A `set -e` in the command itself does nothing: Claude Code runs
// it inside `eval '...' && ...`, and bash ignores errexit in an && list
// (checked 2026-10-27). A top-level line
// is a non-blank, non-comment line outside a heredoc body; a heredoc's body
// and closing word don't count, and a line ending in \, |, && or || runs on
// into the next. So `edits <<'EOF' && git commit ...` with only body lines
// after it stays one line and gets nothing; anything after the heredoc's
// closing word is a new line. Quoted strings that span lines count as extra
// lines too; errexit there costs nothing, the safe way to be wrong.
const HEREDOC = /(?<!<)<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g
const RUNS_ON = /(?:\\|\||&&)[ \t]*$/

export function topLevelLines(command: string): number {
  let count = 0
  let runsOn = false
  const heredocs: { word: string; tabs: boolean }[] = []
  for (const line of command.split('\n')) {
    const doc = heredocs[0]
    if (doc !== undefined) {
      if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.word) heredocs.shift()
      continue
    }
    const text = line.trim()
    if (!runsOn && text !== '' && !text.startsWith('#')) count++
    runsOn = RUNS_ON.test(line)
    for (const m of line.matchAll(HEREDOC)) heredocs.push({ word: m[3]!, tabs: m[1] === '-' })
  }
  return count
}

export function needsErrexit(command: string): boolean {
  return GIT_WRITE.test(command) && topLevelLines(command) > 1
}
