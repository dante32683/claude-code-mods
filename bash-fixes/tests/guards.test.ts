import { test, expect } from 'claude-code/testing'
import {
  guardRmTargets,
  hasExpandedPwshDollar,
  needsErrexit,
  needsPipefail,
  rmAskAdvice,
  topLevelLines,
  withGuards,
  withPipefail,
} from '../hooks/guards'

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

test('pipefail turns on where a pipeline gates what follows', () => {
  expect(withPipefail('npm test | tail -1 && git commit -m x')).toBe('set -o pipefail; npm test | tail -1 && git commit -m x')
  expect(needsPipefail('git push -q 2>&1 | tail -1')).toBe(true)
  expect(needsPipefail('git -C repo commit -qm x | tail -1; git log -1')).toBe(true)
  expect(needsPipefail('check | grep ok || echo failed')).toBe(true)
})

test('pipefail stays off for plain pipelines and chains without a pipe', () => {
  for (const c of ['rg x | head -5', 'git log --oneline | head -3', 'a && b || c', 'ls; git status | head', 'cmd |& tee log', 'set -o pipefail; a | b && c'])
    expect(needsPipefail(c)).toBe(false)
  expect(withPipefail('rg x | wc -l')).toBe('rg x | wc -l')
})

test('errexit turns on when a git write follows other top-level lines', () => {
  expect(needsErrexit("python edit.py\ngit commit -qam x")).toBe(true)
  expect(needsErrexit("cd repo\nmake check\ngit push")).toBe(true)
  expect(needsErrexit("edits <<'EOF'\n=== a.md\nEOF\ngit -C r commit -qam x")).toBe(true) // a line after the heredoc
  expect(needsErrexit('git commit -m "subject\n\nbody"')).toBe(true) // a multi-line string counts; harmless
  expect(needsErrexit('set -euo pipefail\nmake\ngit push')).toBe(true) // its own set -e does nothing in the tool's shell
})

test('errexit stays off for one-line chains, heredoc bodies, and commands without a git write', () => {
  for (const c of [
    'npm test && git commit -qam x',
    "edits <<'EOF' && git commit -qam x && git push\n=== a.md\n--- old\nx\n+++ new\ny\nEOF",
    "cat > f <<-EOF && git add f && git commit -qm f\n\tbody\n\tEOF\n",
    'python a.py \\\n  --flag && git commit -qam x',
    'npm test &&\n  git push',
    '# comment\n\ngit push',
    'cd repo\ngit status\ngit log -1',
  ])
    expect(needsErrexit(c)).toBe(false)
  expect(topLevelLines("a <<'X' && b <<Y\nx body\nX\ny body\nY\nc")).toBe(2)
  expect(topLevelLines('cat <<< "here string"\ngit push')).toBe(2)
})
