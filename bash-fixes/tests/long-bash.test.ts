// The test kit's $ has no fs or process, so these cover the decisions; the
// file round trip is checked in a live session.
import { test, expect } from 'claude-code/testing'
import { escapedLength, needsOffload, scriptText, sourceCommand, LIMIT } from '../hooks/plan'

test('short plain commands stay on the command line', () => {
  expect(needsOffload('echo hi')).toBe(false)
  expect(needsOffload(`grep -n "it's" a.md | head`)).toBe(false)
})

test('a command that escapes past the limit is offloaded', () => {
  // 1,000 apostrophes are 1,000 raw chars but 7,000 escaped ones.
  const quotes = `echo '${"x'\\''".repeat(250)}'`
  expect(quotes.length).toBeLessThan(LIMIT)
  expect(escapedLength(quotes)).toBeGreaterThan(LIMIT)
  expect(needsOffload(quotes)).toBe(true)
})

test('a short command with a double backslash is offloaded', () => {
  expect(needsOffload("printf '%s' 'a\\\\b'")).toBe(true)
  expect(needsOffload("printf '%s' 'a\\b'")).toBe(false)
})

test('the script deletes itself on the first line and keeps the command whole', () => {
  const command = "cat > f <<'EOF'\nline \\\\ 'q' \"d\"\nEOF"
  const script = scriptText(command)
  expect(script).toBe('rm -f -- "${BASH_SOURCE[0]}"; ' + command)
  expect(script.split('\n').length).toBe(command.split('\n').length)
  expect(sourceCommand('C:/T/x.sh')).toBe("source 'C:/T/x.sh'")
})
