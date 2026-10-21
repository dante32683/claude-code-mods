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

// Claude Code asks before an rm or rmdir whose target starts with a shell
// variable, since an empty one would remove / or a top-level folder, and bypass
// mode doesn't skip that ask. It passes once the variable carries the :? guard,
// which leaves the command the same when the variable is set and makes bash
// stop with an error when it's empty or unset. So add the guard: "$S"/x and
// ${S}/x become "${S:?}"/x and ${S:?}/x in the arguments of an rm or rmdir that
// starts a command, including one inside a -c script string (bash -c "rm ...",
// wsl.exe -e bash -c '... && rm ...'). Positional parameters and ${S:-...} forms
// are left alone.
const RM = /(^|[\n;&|(`]|\b(?:then|do|else)\b|-c[ \t]+["'])([ \t]*)(rm|rmdir)(?=[ \t])([^\n;&|)`]*)/g
const TARGET = /(^|[ \t])("?)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(?="?\/)/g

export function guardRmTargets(command: string): string {
  return command.replace(RM, (_m, start, space, rm, args: string) =>
    start + space + rm + args.replace(TARGET, (_t, lead, quote, braced, bare) => `${lead}${quote}\${${braced ?? bare}:?}`),
  )
}

// The rm asks the guard above can't clear: an rm inside a bash -c, sh -c, wsl
// or eval script, which Claude Code doesn't read, and a variable a guard
// doesn't protect ($HOME-style, or set in the command from a value that can be
// / or a top-level folder). Each would stop for approval even in bypass mode,
// so they're refused with what to write instead. Matches Claude Code's own
// wording (2.1.304), both its dialog line and its longer message.
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
