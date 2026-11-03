import { test, expect } from 'claude-code/testing'
import {
  guardRmTargets,
  hasExpandedPwshDollar,
  hkcuWriteNote,
  editsHeredocProblem,
  editsReason,
  endlessFollow,
  hasUnquotedEditsHeredoc,
  needsErrexit,
  needsPipefail,
  rmAskAdvice,
  openMode,
  rewritesFileInScript,
  scriptEditReason,
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

test('a variable the command sets itself passes; others are still caught', () => {
  expect(hasExpandedPwshDollar('S="C:/tmp" && pwsh -NoProfile -Command "Get-Item \'$S/a.ttf\'"')).toBe(false)
  expect(hasExpandedPwshDollar('export DIR=/x; pwsh -Command "ls ${DIR}"')).toBe(false)
  expect(hasExpandedPwshDollar('for f in *.ttf; do pwsh -Command "Get-Item $f"; done')).toBe(false)
  expect(hasExpandedPwshDollar('S=1 && pwsh -Command "\\$g = 2; $S + \\$g"')).toBe(false)
  // Set elsewhere, a PowerShell variable without its backslash, or a subexpression.
  expect(hasExpandedPwshDollar('pwsh -Command "Get-Item \'$S/a.ttf\'"')).toBe(true)
  expect(hasExpandedPwshDollar('S=1 && pwsh -Command "$g = 2; $S + $g"')).toBe(true)
  expect(hasExpandedPwshDollar('S=1 && pwsh -Command "$(Get-Date)"')).toBe(true)
})

test('pwsh calls quoted in a heredoc body pass', () => {
  expect(hasExpandedPwshDollar("edits <<'EDITS'\n=== t.ts\n+++ new\npwsh -Command \"$x\"\nEDITS")).toBe(false)
  expect(hasExpandedPwshDollar("cat > a.md <<'EOF'\npwsh -c \"$env:TEMP\"\nEOF\npwsh -Command 'Get-Date'")).toBe(false)
  // The command line after the heredoc is still checked.
  expect(hasExpandedPwshDollar("cat > a.md <<'EOF'\ntext\nEOF\npwsh -Command \"$env:TEMP\"")).toBe(true)
})

test('an unquoted edits heredoc is caught', () => {
  expect(hasUnquotedEditsHeredoc('edits <<EDITS\n=== a\nEDITS')).toBe(true)
  expect(hasUnquotedEditsHeredoc('cd x && edits << EOF\n=== a\nEOF')).toBe(true)
  expect(hasUnquotedEditsHeredoc("edits <<'EDITS'\n=== a\nEDITS")).toBe(false)
  expect(hasUnquotedEditsHeredoc('edits <<"EDITS"\n=== a\nEDITS')).toBe(false)
  expect(hasUnquotedEditsHeredoc('edits --retry f && cat <<EOF\nx\nEOF')).toBe(false)
  expect(hasUnquotedEditsHeredoc('python edits.py <<EOF\nx\nEOF')).toBe(false)
  // Mentions in heredoc bodies, quotes and comments pass.
  expect(hasUnquotedEditsHeredoc("edits <<'EDITS'\n=== a\n--- old\ncd x && edits << EOF\n+++ new\ny\nEDITS")).toBe(false)
  expect(hasUnquotedEditsHeredoc("cat > doc.md <<'EOF'\nedits <<EDITS\nEOF")).toBe(false)
  expect(hasUnquotedEditsHeredoc('git commit -m "refuse edits <<EDITS"')).toBe(false)
  expect(hasUnquotedEditsHeredoc('# edits <<EOF is wrong')).toBe(false)
  expect(hasUnquotedEditsHeredoc('echo use edits <<X')).toBe(false)
  expect(hasUnquotedEditsHeredoc('edits <<E"DITS"\nx\nEDITS')).toBe(false)
  // Unquoted forms that still expand are caught.
  expect(hasUnquotedEditsHeredoc('x=`edits <<X\na\nX`')).toBe(true)
  expect(hasUnquotedEditsHeredoc('edits 2>&1 <<EDITS\na\nEDITS')).toBe(true)
  expect(hasUnquotedEditsHeredoc('\\edits <<EDITS\na\nEDITS')).toBe(true)
  expect(hasUnquotedEditsHeredoc('out=$(edits <<X\na\nX)')).toBe(true)
  expect(hasUnquotedEditsHeredoc("cat <<'EOF'\nx\nEOF\nedits <<EDITS\na\nEDITS")).toBe(true)
})

test('an edits heredoc that ends early or never ends is caught', () => {
  const doc = "edits <<'EDITS'\n=== a\n--- old\nx\n+++ new\nEDITS\ny\nEDITS"
  expect(editsHeredocProblem(doc)).toEqual({ kind: 'repeated', delimiter: 'EDITS' })
  expect(editsHeredocProblem("edits <<'EDITS'\n=== a\nEOF\necho done")).toEqual({ kind: 'unclosed', delimiter: 'EDITS' })
  expect(editsHeredocProblem("edits <<'EDITS'\n=== a\nedits <<'EDITS'\n=== b\nEDITS")).toEqual({ kind: 'merged', delimiter: 'EDITS' })
  // A doc that shows an edits call with another delimiter is fine.
  expect(editsHeredocProblem("edits <<'END'\n=== a\n+++ new\nedits <<'EDITS'\nEND")).toBeUndefined()
  // Fine: one call, two calls with the same delimiter, other heredocs after.
  expect(editsHeredocProblem("edits <<'EDITS' && make\n=== a\nEDITS")).toBeUndefined()
  expect(editsHeredocProblem("edits <<'EDITS'\n=== a\nEDITS\nedits <<'EDITS'\n=== b\nEDITS")).toBeUndefined()
  expect(editsHeredocProblem("edits <<'EDITS'\n=== a\nEDITS\ncat <<'EOF'\nEDITS\nEOF")).toBeUndefined()
  expect(editsHeredocProblem("cat <<'EOF'\nedits <<'EDITS'\nEOF")).toBeUndefined()
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

test('the edits refusal reason is shared by the check and the call backstop', () => {
  expect(editsReason("edits <<EDITS; echo done\n=== a\nEDITS")).toContain("Quote the edits heredoc delimiter")
  expect(editsReason("edits <<'EDITS'\n=== a\nEDITS")).toBeUndefined()
})

test('a tail -f watch with no end is refused', () => {
  for (const c of ["tail -n +1 -f log | grep --line-buffered -E 'EXIT='", 'tail -F gate.log', 'tail --follow=name x.log | grep x', 'tail -n0 -qF a b'])
    expect(endlessFollow(c)).toContain('never exits')
})

// The shape from the chat that prompted the guard (2026-10-28).
const SLICE_SCRIPT = [
  "cd src && python - <<'EOF'",
  "p='em_core.c'",
  "t=open(p,encoding='latin-1').read()",
  "old=t[t.index('static int parse('):t.index('void em_digits(')]",
  "t=t.replace(old,'''new body''')",
  "open(p,'w',encoding='latin-1',newline='\\n').write(t)",
  'EOF',
  'gcc -std=c89 -c em_core.c',
].join('\n')

test('an inline script that rewrites a file in place is refused', () => {
  expect(rewritesFileInScript(SLICE_SCRIPT)).toBe(true)
  for (const c of [
    "python3 - <<'EOF'\nfrom pathlib import Path\np=Path('a.md')\ns=p.read_text()\np.write_text(s.replace('x','y'))\nEOF",
    "python -c \"import re;s=open('a.c').read();open('a.c','w').write(re.sub('x','y',s))\"",
    "python <<'EOF'\nwith open(f) as h: s=h.read()\nwith open(f, mode='w') as h: h.write(s.replace('a','b'))\nEOF",
    "node -e \"const fs=require('fs');const s=fs.readFileSync(p,'utf8');fs.writeFileSync(p,s.replace('a','b'))\"",
    "py -3 - <<'EOF'\nfor f in files:\n    t=open(f).read()\n    open(f,'w').write(t.replace('a','b'))\nEOF",
    "python - <<'EOF'\nt=open(\"a.md\").read()\nopen('a.md','w').write(t.replace('a','b'))\nEOF",
  ])
    expect(rewritesFileInScript(c)).toBe(true)
  expect(scriptEditReason(SLICE_SCRIPT, 'Fix parsing')).toContain('--- from')
})

test('scripts that read, write elsewhere, or opt out pass', () => {
  for (const c of [
    "python - <<'EOF'\nt=open('a.c').read()\nprint(t.index('parse'))\nEOF", // reads only
    "python - <<'EOF'\nt=open('tmpl.md').read()\nopen('out.md','w').write(t.replace('X','1'))\nEOF", // another file
    "python - <<'EOF'\nimport json\nd=json.load(open(p))\nd['a']=1\njson.dump(d,open(p,'w'))\nEOF", // no text change
    'python scripts/fix.py a.c', // a saved script isn't read
    "cat > notes.md <<'EOF'\nt=open(p).read(); open(p,'w').write(t.replace('a','b'))\nEOF", // no interpreter runs it
    "edits <<'EDITS'\n=== a.md\n--- old\nx\n+++ new\ny\nEDITS",
  ])
    expect(rewritesFileInScript(c)).toBe(false)
  expect(scriptEditReason(SLICE_SCRIPT, 'Re-encode the cp1252 file [script-edit]')).toBeUndefined()
  expect(scriptEditReason(SLICE_SCRIPT, undefined)).toContain('[script-edit]')
})

test('open modes come from the argument after the path or mode=', () => {
  expect(openMode(" encoding='latin-1'")).toBe('r')
  expect(openMode(" 'w', encoding='utf-8'")).toBe('w')
  expect(openMode(' encoding="utf-8", mode="a"')).toBe('a')
  expect(openMode(undefined)).toBe('r')
})

test('tail with an end, or without follow, passes', () => {
  for (const c of ['timeout 600 tail -f log', 'tail --pid=123 -f log', 'tail -n 20 log', "until grep -q 'EXIT=' log; do sleep 5; done", 'tail -n +5 file | head -f2'])
    expect(endlessFollow(c)).toBeUndefined()
})

test('HKCU writes get the package-registry note', () => {
  expect(hkcuWriteNote('reg add "HKCU\\Software\\X" /v A /d 1 /f')).toContain('explorer.exe')
  expect(hkcuWriteNote("pwsh -NoProfile -Command 'Set-ItemProperty HKCU:\\Software\\X A 1'")).toBeDefined()
  // The path in a variable, as $k = "HKCU:\..."; New-Item $k; Set-ItemProperty $k ...
  expect(hkcuWriteNote("pwsh -Command '$k = \"HKCU:\\Software\\X\"; New-Item $k -Force; Set-ItemProperty $k A 1'")).toBeDefined()
  expect(hkcuWriteNote("pwsh -Command '[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(\"Software\\X\").SetValue(\"A\", 1)'")).toBeDefined()
  expect(hkcuWriteNote('python -c "import winreg; k = winreg.CreateKey(winreg.HKEY_CURRENT_USER, r\'Software\\X\')"')).toBeDefined()
  expect(hkcuWriteNote('reg delete "HKEY_CURRENT_USER\\Software\\X" /f')).toBeDefined()
})

test('HKCU reads, HKCU\\Environment, HKLM, Explorer hand-offs, and heredoc bodies pass', () => {
  expect(hkcuWriteNote('reg query "HKCU\\Software\\X"')).toBeUndefined()
  expect(hkcuWriteNote("pwsh -Command 'Get-ItemProperty HKCU:\\Software\\X'")).toBeUndefined()
  expect(hkcuWriteNote('reg add "HKCU\\Environment" /v Path /d x /f')).toBeUndefined()
  expect(hkcuWriteNote("pwsh -Command '[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(\"Environment\", $true).SetValue(\"Path\", $p)'")).toBeUndefined()
  expect(hkcuWriteNote('reg add "HKLM\\SOFTWARE\\X" /v A /d 1 /f')).toBeUndefined()
  expect(hkcuWriteNote("printf 'reg add HKCU\\\\Software\\\\X /v A /d 1 /f\\r\\n' > x.cmd && explorer.exe x.cmd")).toBeUndefined()
  expect(hkcuWriteNote("cat > fix.ps1 <<'EOF'\nSet-ItemProperty HKCU:\\Software\\X A 1\nEOF")).toBeUndefined()
  expect(hkcuWriteNote('rg -n "HKCU" notes.md && New-Item -ItemType Directory x')).toBeUndefined()
  // A known false positive, harmless since the note never blocks: an HKCU path that is only searched for.
  expect(hkcuWriteNote("rg -n 'HKCU:\\Software' notes.md && New-Item -ItemType Directory x")).toBeDefined()
})
