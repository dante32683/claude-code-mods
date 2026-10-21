// On Windows the Bash tool runs `bash -c "... eval '<command>' ..."` through a
// command line that corrupts two kinds of command:
// - Past about 8,191 chars it is cut, and bash fails with "unexpected EOF while
//   looking for matching `''". The command is single-quoted (' becomes '"'"'),
//   then argv quoting turns each " into \", so quotes count extra.
// - Every \\ reaches bash as \, even inside a quoted heredoc.
// Running the command from a file skips the command line.
export const LIMIT = 6000 // leaves room for the wrapper the tool adds

const BACKSLASH = '\\'

export function escapedLength(command: string): number {
  let n = 2
  for (const ch of command) n += ch === "'" ? 7 : ch === '"' || ch === BACKSLASH ? 2 : 1
  return n
}

export function needsOffload(command: string): boolean {
  return escapedLength(command) > LIMIT || command.includes(BACKSLASH + BACKSLASH)
}

// Bash reads a sourced file whole before running it, so the script can delete
// itself first. Same line, so error line numbers match the original command.
export function scriptText(command: string): string {
  return `rm -f -- "\${BASH_SOURCE[0]}"; ${command}`
}

export function sourceCommand(path: string): string {
  return `source '${path}'`
}
