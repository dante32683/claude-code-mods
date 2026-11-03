"""edits: exact-text edits to existing files, all or nothing.

Reads edits from stdin, meant for a quoted heredoc so nothing needs escaping.
Quote the delimiter (<<'EDITS', or the shell expands $ and backticks) and
pick one no content line equals (EDITS rather than EOF): a content line equal
to it ends the heredoc early and the shell runs the rest.

    edits <<'EDITS'
    === path/to/file.md
    --- old
    exact old text
    +++ new
    replacement text
    === other/file.md
    --- old all
    every copy of this
    +++ new
    EDITS

A range edit replaces whole lines between two anchors, so a long block never
needs retyping:

    edits <<'EDITS'
    === src/app.c
    --- from
    static int interval(
    --- until
    static int reduce_core(
    +++ new
    replacement lines
    EDITS

Text edits. `--- old` text is an exact substring (part of a line or several
lines) and must match exactly once, overlapping matches included. Old text
that starts with indentation must start where its line does, so a wrong
indent misses instead of matching inside a deeper one; new text that starts
with indentation, replacing old text that starts after a line's indentation,
replaces that indentation too. When the old text covers only part of a line,
the summary shows the whole changed line (also when only trailing spaces are
left out); old text over several lines must
start and end at line edges. An edit whose new text is already there (old
text plus what it adds) is refused as applied already, and an `all` whose
matches are whole words in some places and parts of longer words in others
is refused. `--- old
all` replaces every copy, at least one; the summary gives the count and
shows each changed line (up to six), so check for matches nobody meant.
Edits in a file apply in order, each to the result of the last; an edit
whose old and new text are the same is refused.

Range edits. `--- from` must match exactly once in the file; its whole line
is the first line replaced. `--- to` ends the range on the line where its
match ends (that line is replaced too); `--- until` ends it just before the
line where its match starts (that line stays, and so do blank lines just
above it unless the range is deleted, so trailing blank lines in its new
text are dropped). Either must match exactly once from
where the `--- from` match starts on, so `--- from` and `--- to` with the same
text replace just that line; a different anchor matching inside the `--- from`
anchor (```` ``` ```` in ```` ```sh ````) is skipped when exactly one match follows
it. Anchors are substrings that only find lines;
text sharing a line with an anchor is replaced with it, and edits notes
that. An anchor may span several lines when one isn't unique. After
writing, edits prints each range's new lines with two lines of
context on each side (over eight new lines, only the first and last three).

Blocks. Marker lines start at column 0 and are exactly `=== <path>`,
`--- old`, `--- old all`, `--- from`, `--- to`, `--- until` and `+++ new`. A
block is every line up to the next marker, joined with newlines. A block
can't start or end with a blank line: blank lines at its edges read as
padding between edits, which would silently join or split lines. To change
blank lines, include a content line next to them. The one exception: an old
block may end with blank lines, which then match every blank line through
the end of the file; the final newline stays. A range deleted through the
end of the file takes the blank lines above it too. In a `--- until` range, new text must not end
with the kept `--- until` line. A new block with no
content lines deletes; a deleted match that fills its lines (give or take
indentation and trailing spaces) takes them and their line break. One
backslash is dropped from any line starting with backslashes and then `---`,
`+++` or `===`, so escape any such content line (`\\=== Title` is the text
`=== Title`, `\\\\---` is `\\---`); other backslashes are kept.

Files. Paths are relative to the current folder or absolute (C:/..., /c/...,
~/..., and other Git Bash paths through cygpath); symlinks and junctions are
followed, so the real file is edited. Every edit is applied in memory first;
then all changed files are written or none are. Matching ignores CRLF vs LF,
and each file keeps its line endings, encoding (UTF-8, BOM kept), mode, and
final newline or lack of one (WSL files are written in place to keep their
Linux mode). Read-only, locked, hard-linked and non-UTF-8 files, and files
another program changed meanwhile, are refused. A lock in the state folder
keeps two edits runs from writing one file at once. Exit codes: 0 done, 1 an
edit didn't match, 2 bad input or a file problem, 3 partly written (some
files couldn't be put back; it prints an undo and must not be retried).

Recovery, so a mistake never means resending everything:
- On a failure the input is kept in a file. Fix it in place (`sed -i` on
  the line numbers the errors give), then run `edits --retry <file>`, which
  reruns it from the original folder and deletes it on success. When a miss
  has no near match, the error names the file line most like the first
  input line the file lacks.
- A run with a range or `--- old all` edit keeps the changed files' old
  contents; `edits --undo <folder>` puts them back, but only if nothing
  changed them since.
Kept inputs and undo copies live in %TEMP%/edits (EDITS_STATE overrides) for
a day.
"""

import difflib
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
from typing import NamedTuple

BOM = b"\xef\xbb\xbf"
MARKERS = ("--- old", "--- old all", "--- from", "--- to", "--- until", "+++ new")
NEAR_MARKER = re.compile(r"(---|\+\+\+)\s*(old(\s+all)?|new|from|to|until)\s*")
BIG = 2_000_000  # characters; slower hints are skipped above this


class InputError(Exception):
    pass


class Text(NamedTuple):
    """Replace `old` (exactly once, or every copy when `all`)."""

    old: str
    new: str
    all: bool
    line: int = 0  # input line of its `--- old`
    eof: bool = False  # old ends with blank lines, so it only matches at the end of the file


class Range(NamedTuple):
    """Replace whole lines: from the line where `start` begins through the line
    where `end` ends (until=False), or up to the line where `end` begins
    (until=True, that line kept)."""

    start: str
    end: str
    until: bool
    new: str
    line: int = 0  # input line of its `--- from`
    end_line: int = 0  # input line of its `--- to` or `--- until`


def is_marker(line):
    return line in MARKERS or (line.startswith("=== ") and bool(line[4:].strip()))


def unescape(line):
    """A backslash before a line starting with ---, +++ or === is dropped, so
    escaping any such line is safe and `\\\\---` is the text `\\---`."""
    return line[1:] if re.match(r"\\+(---|\+\+\+|===)", line) else line


def parse(text):
    """Return [(path, [Text or Range, ...]), ...] in input order."""
    files = []
    padding = []  # blank lines at block edges, reported together at the end
    tail_blanks = []  # old blocks ending in blank lines, fine only at the end of the file
    block = None  # lines of the block being read
    edit = None  # dict of the edit being built
    field = None  # which part of it the block fills
    file_line = 0  # input line of the last `=== <path>`
    block_start = 0  # input line where the current block begins

    def close_block():
        nonlocal block
        if block is not None:
            edit[field] = block
            edit[field + "@"] = block_start
        block = None

    def check(lines, what, where, start):
        if not any(line.strip() for line in lines):
            raise InputError(f"line {start - 1}: the {what} block has no content lines")
        # Collected, so one run reports every padded block.
        if lines[0].strip() == "":
            padding.append(f"input line {start} (start of the {what} block)")
        if lines[-1].strip() == "":
            padding.append(f"input line {start + len(lines) - 1} (end of the {what} block)")

    def close_edit():
        nonlocal edit
        close_block()
        if edit is not None:
            where = f"line {edit['line']}"
            if "new" not in edit:
                if edit["range"] and "end" not in edit:
                    raise InputError(f"{where}: `--- from` has no `--- to` or `--- until` after it")
                msg = f"{where}: this edit has no `+++ new`"
                if not any(line.strip() for line in edit.get(field, []) if field != "new"):
                    msg += f"; if line {edit['line']} is content, start it with a backslash"
                raise InputError(msg)
            new_lines = edit["new"] if any(line.strip() for line in edit["new"]) else []
            if edit["range"] and edit.get("until"):
                # The separator above the `until` line is kept, so trailing blank lines here add nothing.
                while new_lines and not new_lines[-1].strip():
                    new_lines.pop()
            if new_lines:
                check(new_lines, "`+++ new`", where, edit["new@"])
            new = "\n".join(new_lines)
            if edit["range"]:
                check(edit["from"], "`--- from`", where, edit["from@"])
                check(edit["end"], "`--- until`" if edit["until"] else "`--- to`", where, edit["end@"])
                files[-1][1].append(Range("\n".join(edit["from"]), "\n".join(edit["end"]), edit["until"], new,
                                          edit["line"], edit["end@"] - 1))
            else:
                # Blank lines ending an old block can only be meant to reach the end of the file.
                old_lines = edit["old"]
                body = len(old_lines)
                while body and not old_lines[body - 1].strip():
                    body -= 1
                check(old_lines[:body] if body else old_lines, "`--- old`", where, edit["old@"])
                if 0 < body < len(old_lines):
                    tail_blanks.append(f"input line {edit['old@'] + body} (end of the `--- old` block; fine only"
                                       " where the blank lines run to the end of the file)")
                files[-1][1].append(Text("\n".join(old_lines[:body] or old_lines), new, edit["all"], edit["line"],
                                         0 < body < len(old_lines)))
        edit = None

    text = text.lstrip("\ufeff")
    lines = text.replace("\r\n", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()  # the newline that ends the input
    for n, line in enumerate(lines, 1):
        if not is_marker(line) and NEAR_MARKER.fullmatch(line):
            raise InputError(
                f"line {n}: {line!r} looks like a marker but isn't exact (column 0, one space, nothing after);"
                " if it's content, start it with a backslash"
            )
        if line.startswith("=== ") and line[4:].strip():
            if edit is not None and field != "new":
                raise InputError(
                    f"line {n}: {line!r} starts a new file before the edit on line {edit['line']} has its"
                    " `+++ new`; if it's content, start it with a backslash, here and wherever it appears in"
                    " the `+++ new` text"
                )
            if edit is not None and edit.get("escaped") and not any(b.strip() for b in block):
                # Old text that escapes markers is about markers; an empty new block
                # right before `===` usually means the new text forgot its escapes.
                raise InputError(
                    f"line {n}: `{line}` right after `+++ new` would start a new file; if it's content, write it"
                    f" as `{chr(92) + line}` and escape marker lines after it too (to delete the old text"
                    " instead, put this edit last)"
                )
            close_edit()
            if files and not files[-1][1]:
                raise InputError(no_edits(files[-1][0], file_line))
            path = line[4:].strip()
            if len(path) > 1 and path[0] == path[-1] and path[0] in "\"'":
                path = path[1:-1]
            files.append((path, []))
            file_line = n
        elif line in ("--- old", "--- old all", "--- from"):
            if not files:
                raise InputError(f"line {n}: `{line}` before any `=== <path>`")
            close_edit()
            if line == "--- from":
                edit = {"range": True, "line": n}
                field = "from"
            else:
                edit = {"range": False, "all": line.endswith(" all"), "line": n}
                field = "old"
            block, block_start = [], n + 1
        elif line in ("--- to", "--- until"):
            if edit is None or not edit["range"] or field != "from":
                raise InputError(f"line {n}: `{line}` without a `--- from` before it")
            close_block()
            edit["until"] = line == "--- until"
            field, block, block_start = "end", [], n + 1
        elif line == "+++ new":
            if field == "from":
                raise InputError(f"line {n}: `+++ new` after `--- from` needs a `--- to` or `--- until` first")
            if edit is None or field not in ("old", "end"):
                raise InputError(f"line {n}: `+++ new` without a `--- old` or a range before it")
            close_block()
            field, block, block_start = "new", [], n + 1
        elif block is not None:
            plain = unescape(line)
            if plain != line and field != "new":
                edit["escaped"] = True
            block.append(plain)
        elif line.strip():
            if files and not files[-1][1] and edit is None:
                msg = (f"line {n}: {line[:60]!r} comes before any `--- old`; put `--- old` (or `--- from`) on"
                       " the line above the text to replace")
                if len(files) > 1:
                    msg += f", or if line {file_line} is content, start it with a backslash"
                raise InputError(msg)
            msg = f"line {n}: text outside an edit: {line[:60]!r}"
            if file_line:
                msg += f" (line {file_line} started a new file; if it's content, start it with a backslash)"
            raise InputError(msg)
    close_edit()
    if padding:
        # Listed too, so fixing every line named here leaves no blank-line miss for the next run.
        padding += tail_blanks
        padding.sort(key=lambda p: int(p.split()[2]))
        which = padding[0] if len(padding) == 1 else ", ".join(padding[:-1]) + " and " + padding[-1]
        raise InputError(
            f"blank at a block's edge: {which}. Blank lines there read as padding: remove them, or include"
            " the next content line"
        )
    if not files:
        raise InputError("no edits on stdin (expected `=== <path>`, `--- old`, `+++ new`)")
    if not files[-1][1]:
        raise InputError(no_edits(files[-1][0], file_line))
    return files


def no_edits(path, line):
    return f"line {line}: `=== {path}` has no edits under it; if it's content, start it with a backslash"


def native_path(path):
    """Turn a Git Bash path into a Windows one: /c/... directly, others
    (/tmp, /usr, ...) through cygpath, and refuse when that can't."""
    if os.name != "nt" or not path.startswith("/") or path.startswith("//"):
        return path
    m = re.match(r"^/([A-Za-z])(/.*)?$", path)
    if m:
        return f"{m.group(1).upper()}:{m.group(2) or '/'}"
    try:
        r = subprocess.run(["cygpath", "-w", path], capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    raise InputError(f"{path}: can't map this Git Bash path; use C:/... or a relative path")


def count(text, needle, start=0):
    """Matches of needle in text from start, overlapping ones included."""
    n, i = 0, text.find(needle, start)
    while i >= 0:
        n += 1
        i = text.find(needle, i + 1)
    return n


def line_numbers(text, needle, limit=6, start=0):
    out, i = [], text.find(needle, start)
    while i >= 0 and len(out) < limit:
        out.append(text.count("\n", 0, i) + 1)
        i = text.find(needle, i + 1)
    return out


def listing(numbers, total):
    more = ", ..." if total > len(numbers) else ""
    return ", ".join(map(str, numbers)) + more


def squash(s):
    return " ".join(s.split())


def fold(s):
    """Text with accents, curly quotes and dashes made plain, for hints."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.translate(str.maketrans("\u2018\u2019\u201c\u201d\u2013\u2014\u2212\u00a0", "''\"\"--- "))


def visible(s):
    """s in quotes, with tabs, non-breaking spaces and other invisible
    characters written as escapes; backslashes stay as they are."""
    return "'" + "".join(c if c.isprintable() and c != "\u00a0" else repr(c)[1:-1] for c in s) + "'"


def show(line, width=100):
    return visible(line if len(line) <= width else line[: width - 3] + "...")


def pair(a, b, width=100):
    """Two lines that differ, cut around the first difference when long."""
    if max(len(a), len(b)) <= width:
        return visible(a), visible(b)
    d = next((k for k, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
    lo = max(0, d - width // 3)

    def cut(s):
        return ("..." if lo else "") + s[lo:lo + width] + ("..." if len(s) > lo + width else "")

    return visible(cut(a)), visible(cut(b))


def nospace(s):
    return re.sub(r"\s+", "", s)


def locate(text, needle, norm, first_input_line):
    """Name the first needle line that no file line holds as it should (the
    first may end a file line, the last may start one, the rest equal one)
    but some file line holds once both are normalized."""
    file_lines = [fl.rstrip("\r") for fl in text.split("\n")]
    whole = set(file_lines)
    needle_lines = needle.split("\n")
    for i, line in enumerate(needle_lines):
        if not line.strip():
            continue
        if len(needle_lines) == 1:
            ok = any(positions(fl, line) for fl in file_lines)
        elif i == 0:
            ok = any(fl.endswith(line) and len(fl) - len(line) in positions(fl, line) for fl in file_lines)
        elif i == len(needle_lines) - 1:
            ok = any(fl.startswith(line) for fl in file_lines)
        else:
            ok = line in whole
        if ok:
            continue
        # A file line equal to this one once normalized beats one that only contains it.
        same = [k for k, fl in enumerate(file_lines, 1) if norm(line) and norm(fl) == norm(line)]
        holds = [k for k, fl in enumerate(file_lines, 1) if norm(line) and norm(line) in norm(fl)]
        for k in same[:1] or holds[:1]:
            mine, theirs = pair(line, file_lines[k - 1])
            return f": input line {first_input_line + i} is {mine}, file line {k} is {theirs}"
        return ""
    return ""


def hint(text, needle, first_input_line=0):
    """Why a needle with no exact match might still be meant to match."""
    if "\r" in text and needle in text.replace("\r\n", "\n"):
        return "\n    hint: only line endings differ (the file mixes CRLF and LF); use a range or a one-line old"
    if "\n" in needle.strip("\n") and noblank(needle) in noblank(text):
        return ("\n    hint: only blank lines differ: the file has a blank line where the old text has none, or the"
                " other way; copy the file's lines, blank ones included" + diverge(text, needle, first_input_line))
    if squash(needle) and squash(needle) in squash(text):
        where = locate(text, needle, squash, first_input_line)
        return f"\n    hint: only whitespace differs (indentation, tabs, trailing or non-breaking spaces); copy the file's text{where}"
    if len(text) >= BIG:
        return ""
    if nospace(needle) and nospace(needle) in nospace(text):
        where = locate(text, needle, nospace, first_input_line)
        return f"\n    hint: only a space inside a line differs; copy the file's text{where}"
    if fold(needle) in fold(text):
        where = locate(text, needle, fold, first_input_line)
        return f"\n    hint: only accents, curly quotes or dashes differ; copy the file's text{where}"
    return ""


def noblank(s):
    """The text without its blank lines."""
    return re.sub(r"\n(?:[ \t]*\r?\n)+", "\n", s)


def closest(text, needle, first_input_line):
    """For a needle with no near match: the first of its lines the file
    lacks, and the file line most like it."""
    file_lines = [fl.rstrip("\r") for fl in text.split("\n")]
    if len(file_lines) > 20_000:
        return ""
    stripped = [fl.strip() for fl in file_lines]
    for i, line in enumerate(needle.split("\n")):
        s = line.strip()
        if not s or any(s in fl for fl in stripped):
            continue
        best = difflib.get_close_matches(s, stripped, n=1, cutoff=0.6)
        if not best:
            # Part of a long line: the file line holding most of it, in runs of 3+ characters.
            score, k = max(((cover(s, fl), k) for k, fl in enumerate(stripped, 1) if fl), default=(0, 0))
            if score < 0.7:
                return ""
            return (f"\n    input line {first_input_line + i} is {show(s)}; the file line holding the most of it is"
                    f" {k}: {show(stripped[k - 1])} (it may not be the one you meant)")
        k = stripped.index(best[0]) + 1
        mine, theirs = pair(line, file_lines[k - 1])
        return (f"\n    input line {first_input_line + i} is {mine}; the most similar file line is {k}:"
                f" {theirs} (it may not be the one you meant)")
    return ""


def cover(s, line):
    """How much of s appears in line, counting matching runs of 3 or more characters."""
    blocks = difflib.SequenceMatcher(None, s, line, autojunk=False).get_matching_blocks()
    return sum(b.size for b in blocks if b.size >= 3) / len(s)


def looks_ran(text, old, new):
    """Where the new text already is, when that suggests the edit ran before:
    the new text is distinctive, wasn't part of the old text (a kept anchor
    line was in the file all along), and no line the edit removes is still there."""
    if len(new.strip()) < 4 or new in old:
        return []
    at = positions(text, new)
    if not at:
        return []
    removed = [ln.strip() for ln in old.split("\n") if len(ln.strip()) >= 8 and ln.strip() not in new]
    if any(ln in text for ln in removed):
        return []
    return at


def why(text, needle, first_input_line):
    """Hints for a needle with no match, if the file isn't too big for them."""
    if len(text) >= BIG:
        return hint(text, needle, first_input_line)
    return hint(text, needle, first_input_line) or diverge(text, needle, first_input_line) or closest(text, needle, first_input_line)


def diverge(text, old, first_input_line):
    """For a multi-line old text with no match: where its longest matching
    start is in the file, and the first line that differs."""
    lines = old.split("\n")
    best, at = 0, -1
    for k in range(1, len(lines)):
        found = text.find("\n".join(lines[:k]) + "\n")
        if found < 0:
            break
        best, at = k, found
    if not best:
        return ""
    head = "\n".join(lines[:best]) + "\n"
    file_line = text.count("\n", 0, at) + 1
    rest = text[at + len(head):]
    has = rest.split("\n", 1)[0].rstrip("\r") if rest else "(end of file)"
    which = "line 1 of the old text matches" if best == 1 else f"lines 1-{best} of the old text match"
    mine, theirs = pair(lines[best], has)
    return (
        f"\n    {which} file line {file_line}; then input line {first_input_line + best} has"
        f" {mine}, the file has {theirs}"
    )


def positions(text, old):
    """Where old matches, overlapping matches included. Old text that starts
    with indentation must start where its line does, so a wrong indent can't
    match inside a deeper one."""
    found, i = [], text.find(old)
    indented = old[:1] in (" ", "\t")
    while i >= 0:
        ls = text.rfind("\n", 0, i) + 1
        if not (indented and i > ls and not text[ls:i].strip()):
            found.append(i)
        i = text.find(old, i + 1)
    return found


def is_word(c):
    return c.isalnum() or c == "_"


def shape_problem(text, edit):
    """Matches a small model rarely means: old text over several lines whose
    first or last line covers only part of a file line, and an `all` whose
    matches are whole words in some places and parts of longer words in others."""
    old, new, found = edit.old, edit.new, positions(text, edit.old)
    if new == old:
        return "the old and new text are the same, so this edit would change nothing; check the new text"
    if not edit.all:
        # Rerunning an edit that adds text around its old text would add it twice.
        for p in found:
            grown = len(new) - len(old)
            if grown > 0 and ((new.startswith(old) and text.startswith(new, p))
                              or (new.endswith(old) and p >= grown and text.startswith(new, p - grown))):
                return ("the file already has the new text here, so this edit looks applied already;"
                        " drop it, or give old text that only matches before the change")
    if "\n" in old:
        for p in found:
            ls = text.rfind("\n", 0, p) + 1
            end = p + len(old)
            le = text.find("\n", end)
            le = len(text) if le < 0 else le
            line = text.count("\n", 0, p) + 1
            if text[ls:p].strip():
                return (f"the old text spans lines, but starts partway through file line {line}, after"
                        f" {show(text[ls:p].strip())}; start it at the beginning of that line")
            if text[end:le].strip():
                return (f"the old text spans lines, but ends partway through file line"
                        f" {line + old.count(chr(10))}, before {show(text[end:le].strip())}; end it at the end"
                        " of that line")
    if edit.all and old and (is_word(old[0]) or is_word(old[-1])):
        inside = [p for p in found
                  if (is_word(old[0]) and p > 0 and is_word(text[p - 1]))
                  or (is_word(old[-1]) and p + len(old) < len(text) and is_word(text[p + len(old)]))]
        if inside and len(inside) < len(found):
            shown = "; ".join(f"line {text.count(chr(10), 0, p) + 1}: {show(text_line(text, p).strip(), 60)}"
                              for p in inside[:3])
            return (f"{len(inside)} of the {len(found)} matches sit inside longer words ({shown}); add context"
                    " so the old text matches only what should change, or edit those separately")
    return ""


def text_line(text, p):
    ls = text.rfind("\n", 0, p) + 1
    le = text.find("\n", p)
    return text[ls:len(text) if le < 0 else le]


def apply_edit(text, old, new, replace_all, eof=False):
    """Return (new_text, replacements, lines, merged) or (None, count, lines,
    []) when the count is wrong. lines: where each change sits in new_text (on
    a failure, where the matches are); merged: lines of new_text where the
    change sits beside text the old text didn't cover."""
    found = positions(text, old)
    if eof:
        found = [p for p in found if not text[p + len(old):].strip()]
    n = len(found)
    if n == 0 or (n > 1 and not replace_all):
        return None, n, [text.count("\n", 0, p) + 1 for p in found[:6]], []
    out, i, done, lines, nl, merged = [], 0, 0, [], 0, []
    for at in found:
        if at < i:
            continue  # overlaps the last replacement
        if done and not replace_all:
            break
        end = at + len(old)
        if eof:
            # Old text that ended in blank lines takes every blank line after it and
            # leaves the file's final newline.
            end = len(text)
            if new and text.endswith("\n"):
                new += "\n"
        ls = text.rfind("\n", 0, at) + 1
        le = text.find("\n", end)
        le = len(text) if le < 0 else le
        if new[:1] in (" ", "\t") and old[:1] not in (" ", "\t") and at > ls and not text[ls:at].strip():
            at = ls  # the new text brings its own indentation, so it replaces the line's
        if "\n" in new and not text[end:le].strip():
            end = le  # trailing spaces of a replaced line don't move to the new text's last line
        head, tail = text[ls:at].strip(), text[end:le].strip()
        whole_lines = False
        if not new:
            # Deleting a match that fills its lines (give or take indentation and
            # trailing spaces) removes the lines, with their line break.
            if ls >= i and not head and not tail:
                whole_lines = True
                at = ls
                if le < len(text):
                    end = le + 1
                else:
                    end = le  # the last line, with no break after it: drop the one before it
                    if ls > 0 and ls - 1 >= i:
                        at = ls - 2 if ls - 2 >= i and text[ls - 2:ls] == "\r\n" else ls - 1
                    elif ls > 0:  # an earlier match already took that break; take the one before
                        kept = "".join(out)
                        cut = 2 if kept.endswith("\r\n") else 1 if kept.endswith("\n") else 0
                        out, nl = [kept[: len(kept) - cut]], nl - (1 if cut else 0)
        nl += text.count("\n", i, at)
        lines.append(nl + 1)
        if not whole_lines:
            if head:
                merged.append(nl + 1)
            # Trailing spaces the old text left out stay on the line, so show it too.
            if (tail or text[end:le].rstrip("\r")) and (nl + 1 + new.count("\n")) not in merged:
                merged.append(nl + 1 + new.count("\n"))
        out += [text[i:at], new]
        nl += new.count("\n")
        i, done = end, done + 1
    out.append(text[i:])
    return "".join(out), done, lines, merged


def apply_range(text, r):
    """Return (new_text, (first_line, old_count, new_count), region, note) or
    (None, problem, None, None); note names text the whole-line rule took
    from the anchors' lines."""
    if "\r" in text and "\n" not in text:
        return None, "the file ends its lines with a lone CR; ranges need LF or CRLF lines", None, None
    word = "until" if r.until else "to"
    n = count(text, r.start)
    if n != 1:
        problem = f"`--- from` has {n} matches, need exactly 1"
        if n == 0:
            problem += why(text, r.start, r.line + 1)
        else:
            problem += f" (lines {listing(line_numbers(text, r.start), n)})\n    hint: add lines to the anchor to make it unique"
        if count(text, r.end) == 0:
            problem += f"\n  and `--- {word}` has no match anywhere in the file" + why(text, r.end, r.end_line + 1)
        return None, problem, None, None
    a = text.index(r.start)
    after = a + len(r.start)
    start = a
    n = count(text, r.end, a)
    if n > 1 and count(text, r.end, after) == 1:
        start, n = after, 1  # the other match sits inside the `--- from` anchor (```sh, then ```)
    if n != 1:
        problem = f"`--- {word}` matches {n} times from the `--- from` line down, need exactly 1"
        if n == 0:
            before = count(text[:after], r.end)
            problem += f"\n    hint: it matches {before} time(s) above `--- from`; swap them?" if before else why(text, r.end, r.end_line + 1)
        else:
            found = line_numbers(text, r.end, start=a)
            problem += f" (lines {listing(found, n)})"
            if found[0] == text.count("\n", 0, a) + 1:
                problem += f"\n    hint: one is on the `--- from` line itself; make the `--- {word}` anchor longer"
            elif r.until:
                problem += "\n    hint: add lines to the anchor to make it unique"
            else:
                problem += "\n    hint: anchor `--- until` on the line after the range, or add lines to make it unique"
        return None, problem, None, None
    b = text.index(r.end, start)
    lo = text.rfind("\n", 0, a) + 1  # start of the `from` line
    taken = []
    if text[lo:a].strip():
        taken.append(f"the `--- from` line also held {show(text[lo:a].strip())} before the anchor")
    if r.until:
        if b < after or "\n" not in text[after - 1:b]:
            return None, "`--- until` matches on the last line of `--- from`; it must start a later line", None, None
        hi = text.rfind("\n", 0, b) + 1  # start of the `until` line, which stays
        kept = [ln.strip() for ln in text[hi:].split("\n")[: r.end.count("\n") + 1]]
        tail = [ln.strip() for ln in r.new.split("\n")]
        if r.new and (tail[-1] == kept[0] or tail[-len(kept):] == kept):
            return None, ("the new text ends with the `--- until` line, which the range keeps, so it would"
                          " appear twice; leave it out of the new text"), None, None
        if r.new:
            # Blank lines just above the `until` line separate it from the range: keep them.
            while True:
                p = text.rfind("\n", 0, hi - 1) + 1
                if p <= lo or text[p:hi - 1].strip() != "":
                    break
                hi = p
    else:
        e = b + len(r.end)
        if e < after:
            return None, "`--- to` ends inside the `--- from` anchor; it must end on its last line or later", None, None
        nl = e - 1 if r.end.endswith("\n") else text.find("\n", e)
        hi = len(text) if nl < 0 else nl + 1
        if text[e:hi].strip():
            taken.append(f"the `--- to` line also held {show(text[e:hi].strip())} after the anchor")
    region = text[lo:hi]
    if r.new:
        repl = r.new + "\n" if region.endswith("\n") else r.new
        result = text[:lo] + repl + text[hi:]
    elif region.endswith("\n") or lo == 0:
        result = text[:lo] + text[hi:]
        if hi == len(text):
            # Deleting through the end of the file: the blank lines that separated it go too.
            result = re.sub(r"\n(?:[ \t]*\n)+\Z", "\n", result)
    else:
        result = text[:lo - 1]  # deleting through the last line: drop the break before it
    first = text.count("\n", 0, lo) + 1
    old_count = region.count("\n") + (0 if region.endswith("\n") else 1)
    new_count = r.new.count("\n") + 1 if r.new else 0
    return result, (first, old_count, new_count), region, "; ".join(taken)


def indent_kinds(s):
    """How lines start their indentation; continuation lines (after a line
    ending in a backslash) don't count, since they often align with spaces."""
    kinds, after_backslash = set(), False
    for line in s.split("\n"):
        line = line.rstrip("\r")
        if line.strip() and line[0] in " \t" and not after_backslash:
            kinds.add("tabs" if line[0] == "\t" else "spaces")
        after_backslash = line.endswith("\\")
    return kinds


def is_makefile(path):
    name = os.path.basename(path).lower()
    return name.startswith(("makefile", "gnumakefile")) or name.endswith(".mk")


def indent_warning(file_text, new):
    """A note when new text indents with spaces in a file indented only with
    tabs, or the other way round."""
    was, now = indent_kinds(file_text), indent_kinds(new)
    if len(was) == 1 and now - was:
        return f"new text indents with {', '.join(sorted(now - was))}; the file uses {next(iter(was))}"
    return ""


def span(first, count):
    if count == 1:
        return f"line {first}"
    return f"lines {first}-{first + count - 1}"


def show_range(shown, text, info, note="", context=2, full=8, ends=3):
    """The changed lines with their surroundings, numbered as of this edit."""
    first, old_count, new_count = info
    lines = text.split("\n")
    if lines and lines[-1] == "" and text.endswith("\n"):
        lines.pop()

    def row(n, mark):
        body = lines[n - 1].rstrip("\r")
        if len(body) > 160:
            body = body[:157] + "..."
        return f"{mark} {n:>5}  {body}"

    old = span(first, old_count)
    if new_count:
        head = (f"{shown}: replaced {old} ({old_count}) with {new_count} new line{'s' if new_count != 1 else ''},"
                f" now {span(first, new_count)}{note}")
    else:
        head = f"{shown}: deleted {old} ({old_count}){note}"
    out = [head]
    out += [row(n, " ") for n in range(max(1, first - context), min(first, len(lines) + 1))]
    last = first + new_count - 1
    if new_count == 0:
        out.append(f"> {'':>5}  ({old_count} line{'s' if old_count != 1 else ''} deleted here)")
    elif new_count <= full:
        out += [row(n, ">") for n in range(first, last + 1)]
    else:
        out += [row(n, ">") for n in range(first, first + ends)]
        out.append(f"> {'':>5}  ... {new_count - 2 * ends} more")
        out += [row(n, ">") for n in range(last - ends + 1, last + 1)]
    out += [row(n, " ") for n in range(last + 1, min(len(lines), last + context) + 1)]
    return "\n".join(out)


def load(path, shown):
    with open(path, "rb") as f:
        raw = f.read()
    data = raw[len(BOM):] if raw.startswith(BOM) else raw
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise InputError(f"{shown}: not UTF-8 ({e.reason} at byte {e.start})")
    crlf = "\r\n" in text and text.count("\r\n") == text.count("\n")
    if crlf:
        text = text.replace("\r\n", "\n")
    return text, raw.startswith(BOM), crlf, raw


def slash(path):
    return path.replace("\\", "/")


def quote(path):
    return shlex.quote(slash(path))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def state_folder():
    return os.environ.get("EDITS_STATE") or os.path.join(tempfile.gettempdir(), "edits")


def state_dir():
    """Where kept inputs and undo copies go; its own entries older than a day
    are pruned, nothing else."""
    folder = state_folder()
    os.makedirs(folder, exist_ok=True)
    cutoff = time.time() - 86400
    for name in os.listdir(folder):
        if not re.fullmatch(r"input-[^/\\]+\.txt(\.cwd)?|undo-[^/\\]+", name):
            continue
        path = os.path.join(folder, name)
        try:
            if os.path.getmtime(path) < cutoff:
                shutil.rmtree(path) if os.path.isdir(path) else os.remove(path)
        except OSError:
            pass
    return folder


class Refused(Exception):
    pass


def in_place(path):
    """WSL files: os.replace there resets the Linux mode, so write in place."""
    return slash(path).lower().startswith(("//wsl$/", "//wsl.localhost/"))


def stage(path, data):
    """A temp file beside path holding data, with path's mode; None for a
    file written in place."""
    if in_place(path):
        return None
    fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(path) + ".", suffix=".edits-tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        try:
            os.chmod(tmp, os.stat(path).st_mode & 0o7777)
        except OSError:
            pass
    except OSError:
        os.remove(tmp)
        raise
    return tmp


def swap(tmp, path, expected, data, shown):
    """Put data at path (from tmp, or in place) if path still holds expected.
    Retries briefly while the file is locked (indexers, antivirus, sync tools),
    checking it again before every try so a concurrent change is never lost."""
    for attempt in range(10):
        try:
            if tmp is None:
                with open(path, "r+b") as f:
                    if f.read() != expected:
                        raise Refused(f"{shown} changed while editing; run again")
                    f.seek(0)
                    f.write(data)
                    f.truncate()
                return
            with open(path, "rb") as f:
                if f.read() != expected:
                    raise Refused(f"{shown} changed while editing; run again")
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 9:
                raise Refused(f"{shown} is locked by another program or access is denied")
            time.sleep(0.05)


def lock(writes):
    """Hold a lock per target, in the state folder, while targets are checked
    and replaced, so two edits runs never both pass the check and lose one's
    change. Each lock holds a token so only its owner removes it; one older
    than ten seconds is taken as stale."""
    folder = os.path.join(state_dir(), "locks")
    os.makedirs(folder, exist_ok=True)
    token = os.urandom(8).hex()
    names = sorted({(hashlib.sha1(os.path.normcase(p).encode()).hexdigest(), shown) for p, _, _, shown in writes})
    held = []
    try:
        for digest, shown in names:
            name = os.path.join(folder, digest)
            deadline = time.time() + 5
            while True:
                try:
                    fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    with os.fdopen(fd, "w") as f:
                        f.write(token)
                    held.append(name)
                    break
                except (FileExistsError, PermissionError):  # Windows: a lock being deleted
                    try:
                        if time.time() - os.path.getmtime(name) > 10:
                            os.remove(name)
                            continue
                    except OSError:
                        pass
                    if time.time() > deadline:
                        raise Refused(f"{shown} is being written by another edits run; run again")
                    time.sleep(0.02)
    except (OSError, Refused):
        unlock(held, token)
        raise
    return held, token


def unlock(held, token):
    for name in held:
        try:
            with open(name, encoding="utf-8") as f:
                mine = f.read() == token
            if mine:
                os.remove(name)
        except OSError:
            pass


def commit(writes):
    """Write [(path, data, original, shown), ...] all or none. Return
    (problem, stuck): problem is None when all went well; stuck lists files
    that were written and couldn't be put back."""
    try:
        held, token = lock(writes)
    except (OSError, Refused) as e:
        return (str(e) if isinstance(e, Refused) else f"{e.strerror or e} ({slash(e.filename or '')})"), []
    try:
        return commit_locked(writes)
    finally:
        unlock(held, token)


def commit_locked(writes):
    staged, done = [], []
    try:
        for path, data, _, _ in writes:
            staged.append(stage(path, data))
        for (path, data, original, shown), tmp in zip(writes, staged):
            swap(tmp, path, original, data, shown)
            done.append((path, data, original, shown))
        return None, []
    except (OSError, Refused) as e:
        stuck = []
        for path, data, original, shown in reversed(done):
            tmp = None
            try:
                tmp = stage(path, original)
                swap(tmp, path, data, original, shown)
            except (OSError, Refused):
                stuck.append((path, shown))
                if tmp:
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass
        for tmp in staged:
            if tmp:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        return (str(e) if isinstance(e, Refused) else f"{e.strerror or e} ({slash(e.filename or '')})"), stuck


def save_undo(changed):
    """Keep each changed file's old bytes; return the folder `--undo` takes."""
    folder = tempfile.mkdtemp(prefix="undo-", dir=state_dir())
    manifest = []
    for k, job in enumerate(changed):
        with open(os.path.join(folder, f"{k}.bak"), "wb") as f:
            f.write(job["raw"])
        manifest.append({"path": job["path"], "backup": f"{k}.bak", "after": sha(job["data"])})
    with open(os.path.join(folder, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f)
    return folder


def undo(folder, out=sys.stdout, err=sys.stderr):
    """Put back the files an earlier run changed, if nothing touched them since."""
    try:
        folder = os.path.abspath(native_path(folder))
        if not os.path.basename(folder).startswith("undo-"):
            raise ValueError
        with open(os.path.join(folder, "manifest.json"), encoding="utf-8") as f:
            manifest = json.load(f)
        for m in manifest:
            if not (isinstance(m, dict) and re.fullmatch(r"\d+\.bak", str(m.get("backup")))
                    and isinstance(m.get("path"), str) and isinstance(m.get("after"), str)):
                raise ValueError
    except (OSError, ValueError, TypeError, InputError):
        print(f"edits: no undo at {slash(folder)} (it was used already, or the path is wrong)", file=err)
        return 2
    writes, problems = [], []
    for m in manifest:
        try:
            with open(os.path.join(folder, m["backup"]), "rb") as f:
                backup = f.read()
        except OSError:
            print(f"edits: undo folder {slash(folder)} is damaged; nothing undone", file=err)
            return 2
        shown = slash(m["path"])
        try:
            with open(m["path"], "rb") as f:
                current = f.read()
        except OSError:
            problems.append(f"{shown} is missing")
            continue
        if current == backup:
            continue  # already back, e.g. after an undo that stopped partway
        if sha(current) != m["after"]:
            problems.append(f"{shown} changed since that edit")
        elif not os.access(m["path"], os.W_OK):
            problems.append(f"{shown} is read-only")
        else:
            writes.append((m["path"], backup, current, shown))
    if problems:
        print("edits: nothing undone: " + "; ".join(problems), file=err)
        return 1
    failed, stuck = commit(writes)
    if failed:
        names = ", ".join(shown for _, shown in stuck)
        print(f"edits: {'partly undone (' + names + ' restored)' if stuck else 'nothing undone'}: {failed}", file=err)
        return 3 if stuck else 2
    shutil.rmtree(folder, ignore_errors=True)
    print(f"edits: undone ({len(writes)} file{'s' if len(writes) != 1 else ''})", file=out)
    return 0


def run(stdin_text, out=sys.stdout, err=sys.stderr, retry=None):
    """Apply the edits. On a failure the input is kept in a file, so a fix
    there and `--retry` replace resending it; `retry` is that file."""
    code = apply_all(stdin_text, out, err)
    if code == 3:
        return code  # partly written: rerunning would apply edits twice
    if code == 0:
        if retry and is_kept(retry):
            for path in (retry, retry + ".cwd"):
                try:
                    os.remove(path)
                except OSError:
                    pass
        return 0
    if retry:
        print(f"edits: fix it and run again: edits --retry {quote(retry)}", file=err)
    elif stdin_text.strip():
        try:
            fd, path = tempfile.mkstemp(prefix="input-", suffix=".txt", dir=state_dir())
            with os.fdopen(fd, "wb") as f:
                f.write(stdin_text.encode("utf-8"))
            # The shell's folder may differ at retry time; relative paths need this one.
            with open(path + ".cwd", "w", encoding="utf-8") as f:
                f.write(os.getcwd())
        except OSError as e:
            print(f"edits: input not kept: {e}", file=err)
            return code
        print(f"edits: input kept (line numbers match); fix it if needed, then: edits --retry {quote(path)}", file=err)
    return code


def is_kept(path):
    """Is this a kept input (so --retry may delete it)? Its name and the
    .cwd beside it say so, wherever EDITS_STATE points now."""
    return re.fullmatch(r"input-.+\.txt", os.path.basename(path)) is not None and os.path.isfile(path + ".cwd")


def apply_all(stdin_text, out, err):
    try:
        files = parse(stdin_text)
        located = [(shown, os.path.realpath(os.path.abspath(native_path(os.path.expanduser(shown)))), edits)
                   for shown, edits in files]
    except InputError as e:
        print(f"edits: nothing written: {e}", file=err)
        return 2

    # Merge spellings of one file (realpath gives NTFS's own case and follows
    # links) so their edits apply in order to one copy.
    jobs = {}
    for shown, real, edits in located:
        if real not in jobs:
            jobs[real] = {"shown": shown, "path": real, "edits": []}
        jobs[real]["edits"].extend(edits)

    for job in jobs.values():
        shown = job["shown"]
        if os.path.isdir(job["path"]):
            print(f"edits: {shown}: is a folder", file=err)
            return 2
        if not os.path.isfile(job["path"]):
            where = "" if os.path.isabs(native_path(os.path.expanduser(shown))) else f" in {slash(os.getcwd())}"
            print(f"edits: nothing written: {shown}: no such file{where} (edits never create files); if"
                  f" `=== {shown}` is content, start it with a backslash", file=err)
            return 2
        try:
            if os.stat(job["path"]).st_nlink > 1:
                print(f"edits: {shown} has hard links, which a rewrite would split; edit it another way", file=err)
                return 2
            job["text"], job["bom"], job["crlf"], job["raw"] = load(job["path"], shown)
        except (InputError, OSError) as e:
            print(f"edits: {e}", file=err)
            return 2

    failures, warnings = [], []
    pending = []  # range echoes: (job, edit index, echo as applied)
    keep_undo = False
    for job in jobs.values():
        text = job["text"]
        job["replaced"], job["echo"], job["all_at"], job["merged_at"] = 0, {}, -1, -1
        for k, edit in enumerate(job["edits"]):
            if isinstance(edit, Range):
                where = f"  {job['shown']}, `--- from` on input line {edit.line}"
                result, info, region, note = apply_range(text, edit)
                if result is None:
                    if count(job["text"], edit.start) and not count(text, edit.start):
                        info += "\n    hint: an earlier edit in this batch changed it"
                    failures.append(f"{where}: {info}")
                    continue
                pending.append((job, k, show_range(job["shown"], result, info)))
                if note:
                    warnings.append(f"edits: note: {job['shown']}, input line {edit.line}: {note}; it was replaced too")
                keep_undo = True
            else:
                marker = "`--- old all`" if edit.all else "`--- old`"
                first, last = edit.line + 1, edit.line + 1 + edit.old.count("\n")
                span_text = f"line {first}" if first == last else f"lines {first}-{last}"
                where = f"  {job['shown']}, {marker} text on input {span_text}"
                result, n, lines, merged = apply_edit(text, edit.old, edit.new, edit.all, edit.eof)
                if result is None:
                    want = "1 or more" if edit.all else "exactly 1"
                    msg = f"{where}: {n} matches, need {want}"
                    if n == 0 and edit.eof and positions(text, edit.old):
                        blank = edit.line + 2 + edit.old.count("\n")
                        msg += (f"\n    hint: the old text matches, but it ends with a blank line (input line {blank}), which is allowed"
                                " only where the blank lines run to the end of the file; include the next content"
                                " line in both old and new text (or drop the blank line)")
                    elif n == 0:
                        done_at = looks_ran(text, edit.old, edit.new)
                        if positions(job["text"], edit.old):
                            msg += "\n    hint: an earlier edit in this batch changed it"
                        elif done_at:
                            msg += (f"\n    hint: the new text is already at line {text.count(chr(10), 0, done_at[0]) + 1},"
                                    " so this edit may have run already")
                        else:
                            msg += why(text, edit.old, edit.line + 1)
                    else:
                        msg += f" (lines {listing(lines, n)})"
                        for ln in lines[:4]:
                            msg += f"\n    line {ln}: {show(text.split(chr(10))[ln - 1].rstrip(chr(13)).strip(), 80)}"
                        if len(positions(job["text"], edit.old)) == 1:
                            msg += "\n    hint: an earlier edit in this batch added a copy"
                        else:
                            msg += f"\n    hint: add surrounding lines to make it unique, or use `--- old all` if all {n} should change"
                    failures.append(msg)
                    continue
                problem = not edit.eof and shape_problem(text, edit)
                if problem:
                    failures.append(f"{where}: {problem}")
                    continue
                if edit.all:
                    job["replaced"] += n
                    split = result.split("\n")
                    for ln in lines:
                        job["echo"][ln] = split[ln - 1].rstrip("\r") if edit.new else "(deleted here)"
                    job["all_at"] = k
                    keep_undo = True
                elif merged and result != text:
                    # Text the old text didn't cover shares a line with the change: show the line.
                    split = result.split("\n")
                    for ln in merged:
                        line = split[ln - 1].rstrip("\r")
                        job["echo"][ln] = line.strip() + (" (its trailing spaces stay)" if line != line.rstrip() else "")
                    job["merged_at"] = k
            note = indent_warning(job["text"], edit.new)
            if note and "with spaces; the file uses tabs" in note and is_makefile(job["path"]):
                new_at = (edit.end_line + edit.end.count("\n") + 2 if isinstance(edit, Range)
                          else edit.line + edit.old.count("\n") + 3)
                failures.append(f"  {job['shown']}, `+++ new` text from input line {new_at}: Makefile recipe"
                                " lines need a tab, not spaces")
                continue
            if note:
                warnings.append(f"edits: warning: {job['shown']}, input line {edit.line}: {note}")
            text = result
        job["new"] = text

    if failures:
        print("edits: nothing written", file=err)
        print("\n".join(failures), file=err)
        return 1

    writes = []
    for job in jobs.values():
        if job["new"] == job["text"]:
            continue
        try:
            open(job["path"], "ab").close()  # real write access, ACLs and read-only included
        except OSError:
            print(f"edits: nothing written: {job['shown']} is read-only or access is denied", file=err)
            return 2
        text = job["new"].replace("\n", "\r\n") if job["crlf"] else job["new"]
        job["data"] = (BOM if job["bom"] else b"") + text.encode("utf-8")
        writes.append((job["path"], job["data"], job["raw"], job["shown"]))
    failed, stuck = commit(writes)
    if stuck:
        names = ", ".join(shown for _, shown in stuck)
        print(f"edits: partly written: {names} got the new text and couldn't be put back after: {failed}."
              " Don't retry; check those files.", file=err)
        try:
            folder = save_undo([job for job in jobs.values() if any(job["path"] == p for p, _ in stuck)])
            print(f"edits: undo with: edits --undo {quote(folder)}", file=err)
        except OSError:
            pass
        return 3
    if failed:
        print(f"edits: nothing written: {failed}", file=err)
        return 2

    parts = []
    for job in jobs.values():
        n = len(job["edits"])
        extra = ""
        if job["all_at"] >= 0:
            extra = f", `all` replaced {job['replaced']}"
        if max(job["all_at"], job["merged_at"]) not in (-1, n - 1):
            extra += ", lines numbered before later edits"
        if job["new"] == job["text"]:
            same = ", no change"
        else:
            same = ""
        parts.append(f"{job['shown']} ({n} edit{'s' if n != 1 else ''}{extra}{same})")
    print("edits: " + ", ".join(parts), file=out)
    for job in jobs.values():
        # Each line an `all` edit changed, so a match nobody meant shows up, and
        # each line where a change sits beside text the old text didn't cover.
        changed = sorted(job["echo"].items())
        for ln, line in changed[:6]:
            line = line.strip()
            print(f"  {job['shown']}:{ln}: {line if len(line) <= 100 else line[:97] + '...'}", file=out)
        if len(changed) > 6:
            print(f"  ... and {len(changed) - 6} more", file=out)
    for job, k, echo in pending:
        if k < len(job["edits"]) - 1:
            head, _, rest = echo.partition("\n")
            echo = f"{head} (line numbers before this run's later edits)\n{rest}"
        print(echo, file=out)
    for warning in warnings:
        print(warning, file=out)
    if keep_undo and writes:
        # A range or `all` can change lines the caller never saw, so keep a way back.
        try:
            folder = save_undo([job for job in jobs.values() if "data" in job])
            print(f"edits: undo with: edits --undo {quote(folder)}", file=out)
        except OSError as e:
            print(f"edits: no undo saved: {e}", file=out)
    return 0


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="backslashreplace", newline="\n")
    args = sys.argv[1:]
    if args in (["-h"], ["--help"]):
        print(__doc__.strip())
        return 0
    if len(args) == 2 and args[0] == "--undo":
        return undo(args[1])
    if len(args) == 2 and args[0] == "--retry":
        try:
            retry = os.path.abspath(native_path(args[1]))
            with open(retry, "rb") as f:
                text = f.read().decode("utf-8")
        except FileNotFoundError:
            print(f"edits: {args[1]} not found (a successful retry deletes its input)", file=sys.stderr)
            return 2
        except (OSError, UnicodeDecodeError, InputError) as e:
            print(f"edits: can't read {args[1]}: {e}", file=sys.stderr)
            return 2
        # Relative paths in a kept input mean the folder it first ran in; never guess
        # another. Any other file runs here, as `edits < file` would, and is kept.
        if not os.path.isfile(retry + ".cwd"):
            return run(text)
        try:
            with open(retry + ".cwd", encoding="utf-8") as f:
                folder = f.read().strip()
            os.chdir(folder)
        except OSError:
            print(
                f"edits: can't retry: the folder it first ran in is unknown or gone; run it there with"
                f" edits < {quote(retry)}",
                file=sys.stderr,
            )
            return 2
        return run(text, retry=retry)
    if args:
        print("edits: usage: edits <<'EDITS' ... EDITS, edits --retry FILE, edits --undo FOLDER, edits --help", file=sys.stderr)
        return 2
    if sys.stdin is None or sys.stdin.isatty():
        print("edits: give the edits on stdin, e.g. edits <<'EDITS' ... EDITS (see edits --help)", file=sys.stderr)
        return 2
    try:
        stdin_text = sys.stdin.buffer.read().decode("utf-8")
    except UnicodeDecodeError:
        print("edits: stdin is not UTF-8", file=sys.stderr)
        return 2
    return run(stdin_text)


if __name__ == "__main__":
    sys.exit(main())
