// Command checks and the guards.sh prefix. Pure functions, so tests reach them.

// A pwsh or powershell call with -c or -Command and a double-quoted body.
const PWSH_BODY = /(?:^|[\s;&|(])(?:pwsh|powershell)(?:\.exe)?\b[^\n;&|]*?\s-(?:c|command)\s+"((?:[^"\\]|\\.)*)"/gi

// A $ Bash expands inside double quotes: unescaped, before a name, {, (, or
// a special parameter. Group 1 or 2 holds the name, bare or braced.
const EXPANDED = /(?<!\\)\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\}|[{(?!$@*#0-9-])/g

// Shell variables the command sets itself (S=..., export S=..., for S in ...).
// Their $S in a pwsh body is meant for Bash to fill in, such as a path.
const ASSIGNED =
  /(?:^|[\s;&|(])(?:(?:export|local|declare|readonly)\s+(?:-\w+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)=|\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g

// An `edits` heredoc with an unquoted delimiter: Bash then expands $,
// backticks and backslashes in the edit text before edits sees it. Only
// command lines count: heredoc bodies are skipped, and quoted strings and
// comments are blanked first, so text that merely mentions `edits <<X` passes.
// `edits` must start a command; redirects may come before the `<<`. A word
// followed by a quote after blanking (E"DITS") was partly quoted, which Bash
// treats as quoted.
const UNQUOTED_EDITS =
  /(?:^|[;&|(`])[ \t]*\\?edits(?:[ \t]+\d*[<>]&?[^\s<>]+)*[ \t]*(?<!<)<<-?[ \t]*[A-Za-z_][A-Za-z0-9_]*(?![\w'"])/
const EDITS_HEREDOC = /(?<!<)<<(?!<)-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g
const EDITS_ANY =
  /(?:^|[;&|(`])[ \t]*\\?edits(?:[ \t]+\d*[<>]&?[^\s<>]+)*[ \t]*(?<!<)<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1(?![\w'"])/

export type EditsHeredocProblem = { kind: 'unquoted' } | { kind: 'unclosed' | 'repeated' | 'merged'; delimiter: string }

// What would make Bash hand edits the wrong text: an unquoted delimiter (Bash
// expands the body), one no line closes (edits gets the rest of the command),
// or one a later command-level line repeats (the body held that line, so the
// heredoc ended early and the rest runs as commands).
export function editsHeredocProblem(command: string): EditsHeredocProblem | undefined {
  const lines = command.split('\n')
  const closed = new Set<string>()
  for (let i = 0; i < lines.length; ) {
    const own = lines[i]!.replace(/^\t+/, '')
    if (closed.has(own)) return { kind: 'repeated', delimiter: own }
    // Blank quoted strings except a heredoc's own quoted delimiter, then comments.
    const bare = lines[i]!
      .replace(/(<<-?[ \t]*)?('[^']*'|"(?:[^"\\]|\\.)*")/g, (_m, lead: string | undefined, q: string) =>
        lead ? lead + q : "''",
      )
      .replace(/(^|[ \t])#.*$/, '$1')
    if (UNQUOTED_EDITS.test(bare)) return { kind: 'unquoted' }
    const edits = EDITS_ANY.exec(bare)
    const editsAt = edits ? edits.index + edits[0].lastIndexOf('<<') : -1
    i++
    for (const m of bare.matchAll(EDITS_HEREDOC)) {
      while (i < lines.length && lines[i]!.replace(/^\t+/, '') !== m[2]) {
        // Another edits call with this delimiter inside the body: the first one's end line is missing.
        if (m.index === editsAt && EDITS_ANY.exec(lines[i]!)?.[2] === m[2]) return { kind: 'merged', delimiter: m[2]! }
        i++
      }
      if (m.index === editsAt) {
        if (i >= lines.length) return { kind: 'unclosed', delimiter: m[2]! }
        closed.add(m[2]!)
      }
      i++
    }
  }
  return undefined
}

// Why an edits heredoc in this command would hand edits the wrong text, if it would.
export function editsReason(command: string): string | undefined {
  const edits = editsHeredocProblem(command)
  if (edits === undefined) return undefined
  if (edits.kind === 'unquoted') {
    return (
      "Quote the edits heredoc delimiter, as in edits <<'EDITS': unquoted, Bash expands $, backticks and " +
      'backslashes in the edit text before edits sees it.'
    )
  }
  const d = edits.delimiter
  if (edits.kind === 'unclosed') {
    return (
      `The edits heredoc never closes: no line is exactly ${d}, so Bash would hand edits the ` +
      `rest of the command as edit text. End the edit text with a line that is exactly ${d}.`
    )
  }
  if (edits.kind === 'merged') {
    return (
      `An edits heredoc has no ${d} line before the next edits <<'${d}', so Bash would feed both ` +
      `calls to the first edits as one input. End each with a line that is exactly ${d}.`
    )
  }
  return (
    `A line of the edit text is exactly ${d}, which ends the heredoc early: edits would apply ` +
    'the text above it and Bash would run the rest as commands. Pick a delimiter no content line equals, ' +
    "such as edits <<'END_EDITS'."
  )
}

// An inline script (python or node from a heredoc, -c or -e) that reads a file,
// changes its text (replace, re.sub, or index/find for slicing) and writes it
// back to the same path. edits does that job and fails loudly: str.replace
// changes nothing when its text is missing, so a missed edit passes silently,
// and C or shell text in a Python string has its backslashes read as escapes.
// Models still reach for these scripts for big or multi-site edits, often to
// avoid retyping a block that a --- from / --- until range covers. The marker
// [script-edit] in the Bash description lets through what edits can't do.
// The whole command is scanned, so text that only quotes such a script can
// trip it too; the marker covers that rare case.
const INLINE_SCRIPT = /(?:^|[\s;&|(`/\\])(?:python[\d.]*|py|node)(?:\.exe)?(?=[ \t])[^\n]*?(?:<<|[ \t]-[ce][ \t])/m
const TRANSFORM = /\.replace\(|\bre\.subn?\(|\.r?(?:index|find)\(/
const OPEN = /\b(?:io\.|codecs\.)?open\(\s*([^,()]+?)\s*(?:,([^()]*))?\)/g
const PATH_METHOD = /([\w.]+(?:\[[^\]\n]*\])?(?:\([^()\n]*\))?)\.(read|write)_(?:text|bytes)\(/g
const NODE_FS = /\b(read|write)FileSync\(\s*([^,()]+?)\s*[,)]/g
export const SCRIPT_EDIT_MARKER = '[script-edit]'

// The mode of an open() call from its arguments after the path: the second
// positional argument or mode=, else 'r'. encoding='latin-1' is not a mode.
export function openMode(rest: string | undefined): string {
  const args = (rest ?? '').split(',').map(a => a.trim())
  for (const [i, a] of args.entries()) {
    const named = /^mode\s*=\s*(['"])(.*?)\1$/.exec(a)
    if (named) return named[2]!
    const literal = /^(['"])(.*?)\1$/.exec(a)
    if (i === 0 && literal) return literal[2]!
  }
  return 'r'
}

export function rewritesFileInScript(command: string): boolean {
  if (!INLINE_SCRIPT.test(command) || !TRANSFORM.test(command)) return false
  const reads = new Set<string>()
  const writes = new Set<string>()
  const path = (p: string) => p.trim().replaceAll('"', "'")
  for (const m of command.matchAll(OPEN)) {
    const mode = openMode(m[2])
    if (/[wax+]/.test(mode)) writes.add(path(m[1]!))
    if (!/[wax]/.test(mode) || mode.includes('+')) reads.add(path(m[1]!))
  }
  for (const m of command.matchAll(PATH_METHOD)) (m[2] === 'read' ? reads : writes).add(path(m[1]!))
  for (const m of command.matchAll(NODE_FS)) (m[1] === 'read' ? reads : writes).add(path(m[2]!))
  return [...writes].some(w => reads.has(w))
}

// Why this command should use edits instead of a script, unless the description opts out.
export function scriptEditReason(command: string, description: string | undefined): string | undefined {
  if (description?.includes(SCRIPT_EDIT_MARKER) || !rewritesFileInScript(command)) return undefined
  return (
    'This script reads a file, changes its text with replace or slicing, and writes it back. Use edits ' +
    'instead: str.replace skips a missing match silently, while edits writes nothing unless every edit ' +
    'applies, and it passes backslashes through as written. Several `--- old` blocks, across files, go in ' +
    'one call; `--- from <first line>` with `--- until <line after the block>` replaces a whole block ' +
    'without retyping it; chain a check with `&& gcc ...` or similar (edits --help). If edits truly ' +
    `can't do this (a file that isn't UTF-8, a regex over many files), put ${SCRIPT_EDIT_MARKER} in the ` +
    'command description and run it again.'
  )
}

export function hasUnquotedEditsHeredoc(command: string): boolean {
  return editsHeredocProblem(command)?.kind === 'unquoted'
}

// A double-quoted pwsh body on a command line with a $ Bash would fill in,
// other than a variable the command sets itself. Heredoc bodies are data
// (edit text, a file's contents), so pwsh calls quoted there pass.
export function hasExpandedPwshDollar(command: string): boolean {
  const text = withoutHeredocBodies(command)
  const own = new Set([...text.matchAll(ASSIGNED)].map(a => a[1] ?? a[2]))
  for (const m of text.matchAll(PWSH_BODY)) {
    for (const d of (m[1] ?? '').matchAll(EXPANDED)) {
      const name = d[1] ?? d[2]
      if (name === undefined || !own.has(name)) return true
    }
  }
  return false
}

// The command with each heredoc's body lines left out.
export function withoutHeredocBodies(command: string): string {
  const kept: string[] = []
  const heredocs: { word: string; tabs: boolean }[] = []
  for (const line of command.split('\n')) {
    const doc = heredocs[0]
    if (doc !== undefined) {
      if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.word) heredocs.shift()
      continue
    }
    kept.push(line)
    for (const m of line.matchAll(HEREDOC)) heredocs.push({ word: m[3]!, tabs: m[1] === '-' })
  }
  return kept.join('\n')
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

// An isolation-worktree subagent's folder, where Claude Code refuses any Bash
// command that runs text through `source` (it can't verify the text stays in
// the worktree), so the guards prefix and the script offload would block
// every command there.
const AGENT_WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]agent-[^\\/]+(?:[\\/]|$)/i

export function isAgentWorktree(cwd: string | undefined, agentId: string | undefined): boolean {
  return agentId !== undefined && cwd !== undefined && AGENT_WORKTREE.test(cwd)
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

// A watch built on `tail -f` never ends by itself: after the log stops growing,
// tail keeps waiting, so a Monitor or background Bash job outlives the work it
// watched (on Windows its tail can outlive the job's shell too, which keeps a
// chat from archiving). `--pid` or `timeout` gives it an end.
const FOLLOW = /\btail\b[^|;&\n]*\s(?:-[A-Za-z0-9]*[fF][A-Za-z0-9]*|--follow(?:=\w+)?)(?=\s|$)/
const HAS_END = /--pid\b|\btimeout\s+-?\w/

export function endlessFollow(command: string): string | undefined {
  if (!FOLLOW.test(command) || HAS_END.test(command)) return undefined
  return (
    '`tail -f` never exits, so this watch would keep running after the job ends. Wait with a loop that ' +
    "stops when the job is done, for example `until grep -q 'EXIT=' log; do sleep 5; done; grep -E " +
    "'error|EXIT=' log`, or bound the tail with `timeout 600 tail -f ...` or `tail --pid=<pid> -f ...`."
  )
}

// HKCU writes from the Claude desktop app's processes, elevated ones too, land
// in its MSIX package's private registry: they read back fine from here, but
// Windows, Explorer-launched apps, and services never see them (seen
// 2026-11-02: a Run value, a tray-icon pin, and a Lenovo hotkey setting had no
// effect). HKCU\Environment and HKLM writes were real. The note warns without
// blocking, since a command can mention HKCU for other reasons. Heredoc bodies
// are data (a .cmd or .ps1 being written), and a command that hands work to
// explorer.exe is already taking the way out, so neither counts.
const HKCU_REF = /\bHKCU:?[\\/]+(?!Environment\b)|\bHKEY_CURRENT_USER\b(?![\\/]+Environment\b)|\b(?:Registry|RegistryHive)\]::CurrentUser\b(?!\.(?:Open|Create)SubKey\(\s*['"]Environment['"])|\bwinreg\.HKEY_CURRENT_USER\b/i
const REGISTRY_WRITE =
  /\breg(?:\.exe)?\s+(?:add|delete|copy|restore|load)\b|\b(?:Set|New|Remove|Rename|Clear|Copy|Move)-ItemProperty\b|\b(?:New|Remove|Set|Copy|Move|Rename)-Item\b|\.(?:SetValue|CreateSubKey|DeleteValue|DeleteSubKey(?:Tree)?)\s*\(|\b(?:winreg\.)?(?:SetValueEx|CreateKey(?:Ex)?|DeleteValue|DeleteKey(?:Ex)?)\s*\(/i
const EXPLORER = /(?:^|[\s;&|(])explorer(?:\.exe)?\s/i

export function hkcuWriteNote(command: string): string | undefined {
  const text = withoutHeredocBodies(command)
  if (!HKCU_REF.test(text) || !REGISTRY_WRITE.test(text) || EXPLORER.test(text)) return undefined
  return (
    'bash-fixes: this command writes to HKCU. From the Claude desktop app (an MSIX package), HKCU writes, ' +
    "elevated ones too, land in the package's private registry: they read back fine from this shell, but " +
    'Windows, Explorer-launched apps, and services never see them (HKLM and HKCU\\Environment writes are real). ' +
    'To write HKCU for real, put the commands in a .cmd (or a .cmd that runs pwsh -File on a .ps1) and run ' +
    'explorer.exe on it; it runs unelevated, outside the package. Check the result from an Explorer-launched ' +
    'process too.'
  )
}
