"""edits: exact-text edits to existing files, all or nothing.

Reads edits from stdin, meant for a quoted heredoc so nothing needs escaping:

    edits <<'EOF'
    === path/to/file.md
    --- old
    exact old text
    +++ new
    replacement text
    === other/file.md
    --- old all
    every copy of this
    +++ new
    EOF

Marker lines start at column 0 and are exactly `=== <path>`, `--- old`,
`--- old all` and `+++ new`. A text block is every line up to the next
marker, joined with newlines; the newline that ends its last line is not part
of the text. So a one-line block can match part of a line, a multi-line block
matches a span, and blank lines inside a block count (don't pad between
edits). An empty `+++ new` block deletes; when the old text covers whole lines,
their line break goes too, so the lines vanish instead of leaving a blank one.

`--- old` must match exactly once; `--- old all` replaces every match (at
least one). Edits in a file apply in order, each to the result of the last.
Paths are relative to the current folder or absolute (C:/... or /c/...).

Every file is read and every edit applied in memory first. If anything fails,
nothing is written: the failures are listed (file, edit number, the first line
of its old text, how many matches) and the exit code is 1 (2 for bad input or
an unreadable file). Matching ignores whether the file uses CRLF or LF, and
each file is written back with its own line endings, encoding (UTF-8, BOM
kept) and final newline or lack of one, through a temp file and os.replace.
A file with mixed line endings is matched as-is.
"""

import os
import re
import sys
import tempfile

BOM = b"\xef\xbb\xbf"


class InputError(Exception):
    pass


def parse(text):
    """Return [(path, [(old, new, replace_all), ...]), ...] in input order."""
    files = []
    block = None  # lines of the block being read
    edit = None  # [old, new, replace_all] being built

    def close_block():
        nonlocal block
        if block is not None:
            joined = "\n".join(block)
            if edit[1] is None:
                edit[0] = joined
            else:
                edit[1] = joined
        block = None

    def close_edit():
        nonlocal edit
        close_block()
        if edit is not None:
            if edit[1] is None:
                raise InputError(f"{files[-1][0]}: an edit has `--- old` but no `+++ new`")
            if edit[0] == "":
                raise InputError(f"{files[-1][0]}: an edit has empty old text")
            files[-1][1].append(tuple(edit))
        edit = None

    lines = text.replace("\r\n", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()  # the newline that ends the input
    for n, line in enumerate(lines, 1):
        if line.startswith("=== ") and line[4:].strip():
            close_edit()
            if files and not files[-1][1]:
                raise InputError(f"{files[-1][0]}: no edits")
            files.append((line[4:].strip(), []))
        elif line in ("--- old", "--- old all"):
            if not files:
                raise InputError(f"line {n}: `{line}` before any `=== <path>`")
            close_edit()
            edit = [None, None, line.endswith(" all")]
            block = []
        elif line == "+++ new":
            if edit is None or edit[1] is not None or block is None:
                raise InputError(f"line {n}: `+++ new` without a `--- old` before it")
            close_block()
            edit[1] = ""
            block = []
        elif block is not None:
            block.append(line)
        elif line.strip():
            raise InputError(f"line {n}: text outside an edit: {line[:60]}")
    close_edit()
    if not files:
        raise InputError("no edits on stdin (expected `=== <path>`, `--- old`, `+++ new`)")
    if not files[-1][1]:
        raise InputError(f"{files[-1][0]}: no edits")
    return files


def native_path(path):
    """Turn a Git Bash /c/... path into C:/... on Windows."""
    m = re.match(r"^/([A-Za-z])(/.*)?$", path)
    if os.name == "nt" and m:
        return f"{m.group(1).upper()}:{m.group(2) or '/'}"
    return path


def squash(s):
    return " ".join(s.split())


def apply_edit(text, old, new, replace_all):
    """Return (new_text, None) or (None, count) when the count is wrong."""
    count = text.count(old)
    if count == 0 or (count > 1 and not replace_all):
        return None, count
    if new == "" and not old.endswith("\n"):
        # Deleting whole lines takes their line break too. A newline added at
        # the end lets the last line match the same way; it comes off after.
        added = not text.endswith("\n")
        padded = text + "\n" if added else text
        whole = re.compile(r"(?:^|(?<=\n))" + re.escape(old) + r"\n")
        if len(whole.findall(padded)) == count:
            result = whole.sub("", padded)
            if added and result.endswith("\n"):
                result = result[:-1]
            return result, None
    return text.replace(old, new) if replace_all else text.replace(old, new, 1), None


def load(path):
    with open(path, "rb") as f:
        data = f.read()
    bom = data.startswith(BOM)
    if bom:
        data = data[len(BOM):]
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise InputError(f"{path}: not UTF-8 ({e.reason} at byte {e.start})")
    crlf = "\r\n" in text and text.count("\r\n") == text.count("\n")
    if crlf:
        text = text.replace("\r\n", "\n")
    return text, bom, crlf


def run(stdin_text, out=sys.stdout, err=sys.stderr):
    try:
        files = parse(stdin_text)
    except InputError as e:
        print(f"edits: {e}", file=err)
        return 2

    # Merge repeated paths so their edits apply in order to one copy.
    jobs = {}
    for shown, edits in files:
        real = os.path.abspath(native_path(shown))
        key = os.path.normcase(real)
        if key not in jobs:
            jobs[key] = {"shown": shown, "path": real, "edits": []}
        jobs[key]["edits"].extend(edits)

    for job in jobs.values():
        if not os.path.isfile(job["path"]):
            print(f"edits: {job['shown']}: no such file (edits never create files)", file=err)
            return 2
        try:
            job["text"], job["bom"], job["crlf"] = load(job["path"])
        except (InputError, OSError) as e:
            print(f"edits: {e}", file=err)
            return 2

    failures = []
    for job in jobs.values():
        text = job["text"]
        for i, (old, new, replace_all) in enumerate(job["edits"], 1):
            result, count = apply_edit(text, old, new, replace_all)
            if result is None:
                first = old.split("\n")[0][:60]
                want = "1 or more" if replace_all else "exactly 1"
                msg = f"  {job['shown']}: edit {i} ({first!r}): {count} matches, need {want}"
                if count == 0:
                    if "\r" in text and old in text.replace("\r\n", "\n"):
                        msg += "\n    hint: matches if line endings are ignored (the file mixes CRLF and LF)"
                    elif squash(old) and squash(old) in squash(text):
                        msg += "\n    hint: matches if whitespace is ignored (check indentation, trailing spaces, line breaks)"
                elif not replace_all:
                    msg += "\n    hint: add surrounding lines to make it unique, or use `--- old all`"
                failures.append(msg)
            else:
                text = result
        job["new"] = text

    if failures:
        print("edits: nothing written", file=err)
        print("\n".join(failures), file=err)
        return 1

    # Write every changed file to a temp file first, then swap them all in.
    staged = []
    try:
        for job in jobs.values():
            if job["new"] == job["text"]:
                continue
            text = job["new"].replace("\n", "\r\n") if job["crlf"] else job["new"]
            data = (BOM if job["bom"] else b"") + text.encode("utf-8")
            folder = os.path.dirname(job["path"])
            fd, tmp = tempfile.mkstemp(prefix=".edits-", dir=folder)
            staged.append((tmp, job["path"]))
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            try:
                os.chmod(tmp, os.stat(job["path"]).st_mode & 0o7777)
            except OSError:
                pass
    except OSError as e:
        for tmp, _ in staged:
            try:
                os.remove(tmp)
            except OSError:
                pass
        print(f"edits: nothing written: {e}", file=err)
        return 2
    for tmp, path in staged:
        os.replace(tmp, path)

    parts = []
    for job in jobs.values():
        n = len(job["edits"])
        parts.append(f"{job['shown']} ({n} edit{'s' if n != 1 else ''}{'' if job['new'] != job['text'] else ', no change'})")
    print("edits: " + ", ".join(parts), file=out)
    return 0


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="backslashreplace", newline="\n")
    if len(sys.argv) > 1:
        print(__doc__.strip(), file=sys.stdout if sys.argv[1] in ("-h", "--help") else sys.stderr)
        return 0 if sys.argv[1] in ("-h", "--help") else 2
    if sys.stdin is None or sys.stdin.isatty():
        print("edits: give the edits on stdin, e.g. edits <<'EOF' ... EOF (see edits --help)", file=sys.stderr)
        return 2
    try:
        stdin_text = sys.stdin.buffer.read().decode("utf-8")
    except UnicodeDecodeError:
        print("edits: stdin is not UTF-8", file=sys.stderr)
        return 2
    return run(stdin_text)


if __name__ == "__main__":
    sys.exit(main())
