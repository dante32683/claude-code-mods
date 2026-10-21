import { test, expect } from 'claude-code/testing'
import { guardRmTargets, hasExpandedPwshDollar, rmAskAdvice, withGuards } from '../hooks/guards'

test('a double-quoted pwsh body with $ is caught', () => {
  expect(hasExpandedPwshDollar('pwsh -NoProfile -Command "1,2 | % { $_ * 10 }"')).toBe(true)
  expect(hasExpandedPwshDollar('cd x && pwsh -NoProfile -Command "Get-Item $env:TEMP"')).toBe(true)
  expect(hasExpandedPwshDollar('powershell.exe -c "$(Get-Date)"')).toBe(true)
})

test('safe pwsh calls pass', () => {
  expect(hasExpandedPwshDollar("pwsh -NoProfile -Command '1,2 | % { $_ * 10 }'")).toBe(false)
  expect(hasExpandedPwshDollar('pwsh -NoProfile -Command "1,2 | % { \\$_ * 10 }"')).toBe(false)
  expect(hasExpandedPwshDollar('pwsh -NoProfile -Command "Get-Date"')).toBe(false)
  expect(hasExpandedPwshDollar('echo "$HOME" && pwsh -Command \'Get-Date\'')).toBe(false)
})

test('commands get the guards sourced first', () => {
  expect(withGuards('rg x', 'C:\\plugins\\bash-fixes')).toBe(
    "source 'C:/plugins/bash-fixes/hooks/guards.sh' 2>/dev/null; rg x",
  )
})

test('rm and rmdir targets that start with a variable get the :? guard', () => {
  expect(guardRmTargets('S="C:/x" && rm -f "$S"/*.png && python a.py')).toBe(
    'S="C:/x" && rm -f "${S:?}"/*.png && python a.py',
  )
  expect(guardRmTargets('rm -rf $OUT/build ${TMPD}/a "$D/b"')).toBe('rm -rf ${OUT:?}/build ${TMPD:?}/a "${D:?}/b"')
  expect(guardRmTargets('cd x; rmdir "${DIR}"/empty')).toBe('cd x; rmdir "${DIR:?}"/empty')
  expect(guardRmTargets('if true; then rm -f "$S"/a; fi')).toBe('if true; then rm -f "${S:?}"/a; fi')
  expect(guardRmTargets('echo hi | (rm -- "$S"/x)')).toBe('echo hi | (rm -- "${S:?}"/x)')
  expect(guardRmTargets('a\n  rm "$S"/x\nb "$S"/y')).toBe('a\n  rm "${S:?}"/x\nb "$S"/y')
  expect(guardRmTargets('D=/mnt/c/x; wsl.exe -e bash -c "cd \'/mnt/c\' && rm -f $D/*.png && ls $D"')).toBe(
    'D=/mnt/c/x; wsl.exe -e bash -c "cd \'/mnt/c\' && rm -f ${D:?}/*.png && ls $D"',
  )
  expect(guardRmTargets('bash -c "rm -rf $S/x"')).toBe('bash -c "rm -rf ${S:?}/x"')
  expect(guardRmTargets("sh -c 'rm -rf \"$S\"/x'")).toBe("sh -c 'rm -rf \"${S:?}\"/x'")
})

test('other words and commands stay as written', () => {
  for (const command of [
    'rm -f "$S"', // no / after the variable: the check doesn't fire
    'rm -f "${S:?}"/x',
    'rm -f "${S:-/tmp}"/x',
    'rm -f "$1"/x',
    "rm -f '$S'/x",
    'cp "$S"/a b && echo "$S"/b',
    'find . -exec rm {} \;',
    'git rm "$S"/x', // rm is an argument to git, not a command
    'firm "$S"/x',
    'echo "rm $S/x"', // rm inside a plain string
    'bash -c "ls $S/x && echo ok"', // a -c script without rm
  ]) {
    expect(guardRmTargets(command)).toBe(command)
  }
})

test('rm asks the guard cannot clear get advice', () => {
  // The dialog line and the longer message Claude Code 2.1.304 gives.
  for (const reason of [
    'This shell -c script runs rm and could not be checked',
    'This command passes a shell -c script that runs rm, and Claude Code could not check the script for dangerous removals. Approve only if you have read the script.',
    'Dangerous rm operation in a shell -c script: its target is built from a variable or command output known only when it runs',
  ]) {
    expect(rmAskAdvice(reason)).toContain('own Git Bash command')
  }
  const home = rmAskAdvice(
    "Dangerous rm operation detected in `rm -rf \"$HOME\"/x`. The target '\"$HOME\"/x' is a shell variable expansion: when $HOME is unset or empty it becomes `/`. This requires explicit approval and cannot be auto-allowed by permission rules.\n\nmore",
  )
  expect(home).toContain('literal absolute path')
  expect(home).not.toContain('more')
  expect(home).not.toContain('requires explicit approval')
})

test('other asks pass through', () => {
  expect(rmAskAdvice(undefined)).toBeUndefined()
  expect(rmAskAdvice('A permission rule denies a command in this shell -c script')).toBeUndefined()
  expect(rmAskAdvice("Dangerous rm operation detected: '/'")).toBeUndefined()
  expect(rmAskAdvice("Dangerous rm operation detected in `rm -rf /`. The target '/' is the filesystem root.")).toBeUndefined()
  expect(rmAskAdvice('Command contains a git push')).toBeUndefined()
})
