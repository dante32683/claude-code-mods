"""Tests for bin/edits.py. Run from the bash-fixes folder:

    python -m unittest discover -s tests -p "test_*.py"
"""

import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "bin", "edits.py")
sys.path.insert(0, os.path.join(HERE, "..", "bin"))

import edits  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name.replace("\\", "/")
        self.state = tempfile.TemporaryDirectory()
        self.old_state = os.environ.get("EDITS_STATE")
        os.environ["EDITS_STATE"] = self.state.name

    def tearDown(self):
        if self.old_state is None:
            del os.environ["EDITS_STATE"]
        else:
            os.environ["EDITS_STATE"] = self.old_state
        self.state.cleanup()
        self.tmp.cleanup()

    def put(self, name, data):
        path = f"{self.dir}/{name}"
        with open(path, "wb") as f:
            f.write(data)
        return path

    def get(self, path):
        with open(path, "rb") as f:
            return f.read()

    def run_edits(self, text):
        out, err = io.StringIO(), io.StringIO()
        code = edits.run(text, out, err)
        return code, out.getvalue(), err.getvalue()


class Parse(unittest.TestCase):
    def test_blocks_drop_their_final_newline(self):
        files = edits.parse("=== a.md\n--- old\none\ntwo\n+++ new\nthree\n=== b.md\n--- old all\nx\n+++ new\n")
        self.assertEqual(
            files, [("a.md", [edits.Text("one\ntwo", "three", False, 2)]), ("b.md", [edits.Text("x", "", True, 8)])]
        )

    def test_blank_lines_inside_a_block_count(self):
        files = edits.parse("=== a\n--- old\nx\n\ny\n+++ new\nz\n")
        self.assertEqual(files[0][1], [edits.Text("x\n\ny", "z", False, 2)])

    def test_blank_lines_at_a_block_edge_are_refused_as_padding(self):
        for text in [
            "=== a\n--- old\n\nx\n+++ new\ny\n",  # old starts blank
            "=== a\n--- old\nx\n+++ new\ny\n\n=== b\n--- old\nz\n+++ new\nw\n",  # new ends blank
            "=== a\n--- old\nx\n+++ new\n\ny\n",  # new starts blank
            "=== a\n--- from\nx\n\n--- to\ny\n+++ new\nz\n",  # anchor ends blank
        ]:
            with self.assertRaises(edits.InputError, msg=repr(text)) as cm:
                edits.parse(text)
            self.assertIn("blank at a block's edge: input line", str(cm.exception))
        with self.assertRaises(edits.InputError):
            edits.parse("=== a\n--- old\n\n\n\n+++ new\n")  # old of only blank lines
        # A new block with no content lines deletes.
        self.assertEqual(edits.parse("=== a\n--- old\nx\n+++ new\n\n")[0][1][0].new, "")

    def test_escaped_and_near_markers(self):
        files = edits.parse("=== a\n--- old\n\\=== Title\n+++ new\n\\--- old\n")
        self.assertEqual(files[0][1][0][:2], ("=== Title", "--- old"))
        for text in ["=== a\n--- old\nx\n+++ new \ny\n", "=== a\n--- old\nx\n+++new\ny\n", "=== a\n---  old\nx\n+++ new\ny\n"]:
            with self.assertRaises(edits.InputError, msg=repr(text)) as cm:
                edits.parse(text)
            self.assertIn("looks like a marker", str(cm.exception))
        # Indented marker text is ordinary content; an escaped near-marker loses its backslash.
        files = edits.parse("=== a\n--- old\nx\n+++ new\n    --- old\n\\+++ new \n")
        self.assertEqual(files[0][1][0].new, "    --- old\n+++ new ")

    def test_file_header_inside_an_unfinished_edit(self):
        with self.assertRaises(edits.InputError) as cm:
            edits.parse("=== a\n--- old\nx\n=== Results ===\n+++ new\ny\n")
        self.assertIn("line 4: '=== Results ===' starts a new file before the edit on line 2", str(cm.exception))
        with self.assertRaises(edits.InputError) as cm:
            edits.parse("=== a\n--- old\nx\n+++ new\ny\n=== Results ===\nmore\n")
        self.assertIn("or if line 6 is content, start it with a backslash", str(cm.exception))

    def test_bom_and_quoted_paths(self):
        self.assertEqual(edits.parse("﻿=== 'a b.md'\n--- old\nx\n+++ new\ny\n")[0][0], "a b.md")

    def test_bad_input(self):
        for text in [
            "",
            "--- old\nx\n+++ new\ny\n",  # no file
            "=== a\n",  # no edits
            "=== a\n--- old\nx\n",  # no +++ new
            "=== a\n+++ new\ny\n",  # no --- old
            "=== a\n--- old\n+++ new\ny\n",  # empty old
            "stray\n=== a\n--- old\nx\n+++ new\ny\n",
        ]:
            with self.assertRaises(edits.InputError, msg=repr(text)):
                edits.parse(text)

    def test_range_edits(self):
        files = edits.parse("=== a\n--- from\nx\n--- to\ny\n+++ new\nz\n--- from\np\nq\n--- until\nr\n+++ new\n")
        self.assertEqual(
            files[0][1], [edits.Range("x", "y", False, "z", 2, 4), edits.Range("p\nq", "r", True, "", 8, 11)]
        )

    def test_bad_range_input(self):
        for text in [
            "=== a\n--- from\nx\n+++ new\ny\n",  # no to or until
            "=== a\n--- to\nx\n+++ new\ny\n",  # no from
            "=== a\n--- old\nx\n--- to\ny\n+++ new\nz\n",  # to after old
            "=== a\n--- from\nx\n--- to\ny\n--- until\nz\n+++ new\n",  # two ends
            "=== a\n--- from\n--- to\ny\n+++ new\nz\n",  # empty from
            "=== a\n--- from\nx\n--- until\n+++ new\nz\n",  # empty until
            "=== a\n--- from\nx\n--- to\ny\n",  # no +++ new
        ]:
            with self.assertRaises(edits.InputError, msg=repr(text)):
                edits.parse(text)

    def test_git_bash_drive_paths(self):
        if os.name == "nt":
            self.assertEqual(edits.native_path("/c/Users/x.md"), "C:/Users/x.md")
        self.assertEqual(edits.native_path("C:/Users/x.md"), "C:/Users/x.md")
        self.assertEqual(edits.native_path("rel/x.md"), "rel/x.md")


class Apply(Base):
    def test_single_match_mid_line(self):
        p = self.put("a.md", b"alpha beta gamma\n")
        code, out, _ = self.run_edits(f"=== {p}\n--- old\nbeta\n+++ new\nBETA\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"alpha BETA gamma\n")
        self.assertIn("(1 edit)", out)

    def test_multi_line_span_and_edits_in_order(self):
        p = self.put("a.md", b"one\ntwo\nthree\nfour\n")
        code, out, _ = self.run_edits(
            f"=== {p}\n--- old\ntwo\nthree\n+++ new\n2\n3\n--- old\n2\n3\nfour\n+++ new\nend\n"
        )
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"one\nend\n")
        self.assertIn("(2 edits)", out)

    def test_multiple_matches_fail_unless_all(self):
        p = self.put("a.md", b"x y x\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old\nx\n+++ new\nz\n")
        self.assertEqual(code, 1)
        self.assertIn("2 matches", err)
        self.assertEqual(self.get(p), b"x y x\n")
        code, _, _ = self.run_edits(f"=== {p}\n--- old all\nx\n+++ new\nz\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"z y z\n")

    def test_all_or_nothing_across_files(self):
        a = self.put("a.md", b"keep\n")
        b = self.put("b.md", b"keep\n")
        code, out, err = self.run_edits(
            f"=== {a}\n--- old\nkeep\n+++ new\nchanged\n=== {b}\n--- old\nmissing line\n+++ new\nx\n"
        )
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("nothing written", err)
        self.assertIn("b.md, `--- old` text on input line 8: 0 matches", err)
        self.assertEqual(self.get(a), b"keep\n")
        self.assertEqual(self.get(b), b"keep\n")
        self.assertEqual(sorted(os.listdir(self.dir)), ["a.md", "b.md"])  # no temp files left
        self.assertIn("edits: input kept", err)

    def test_missing_file_writes_nothing(self):
        a = self.put("a.md", b"keep\n")
        code, _, err = self.run_edits(
            f"=== {a}\n--- old\nkeep\n+++ new\nx\n=== {self.dir}/nope.md\n--- old\na\n+++ new\nb\n"
        )
        self.assertEqual(code, 2)
        self.assertIn("no such file", err)
        self.assertEqual(self.get(a), b"keep\n")

    def test_crlf_kept(self):
        p = self.put("a.md", b"one\r\ntwo\r\nthree\r\n")
        code, _, _ = self.run_edits(f"=== {p}\n--- old\none\ntwo\n+++ new\n1\n2\n2b\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"1\r\n2\r\n2b\r\nthree\r\n")

    def test_lf_kept_with_crlf_input(self):
        p = self.put("a.md", b"one\ntwo\n")
        code, _, _ = self.run_edits(f"=== {p}\r\n--- old\r\none\r\ntwo\r\n+++ new\r\n1\r\n2\r\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"1\n2\n")

    def test_bom_and_utf8_kept(self):
        p = self.put("a.md", edits.BOM + "caf\u00e9 \u2192 x\r\n".encode())
        code, _, _ = self.run_edits(f"=== {p}\n--- old\nx\n+++ new\n\u00fc\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), edits.BOM + "caf\u00e9 \u2192 \u00fc\r\n".encode())

    def test_no_trailing_newline_kept(self):
        p = self.put("a.md", b"one\ntwo")
        code, _, _ = self.run_edits(f"=== {p}\n--- old\ntwo\n+++ new\nTWO\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"one\nTWO")

    def test_delete_whole_lines(self):
        p = self.put("a.md", b"a\nb\nc\nd\n")
        code, _, _ = self.run_edits(f"=== {p}\n--- old\nb\nc\n+++ new\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"a\nd\n")

    def test_delete_last_line_without_newline(self):
        p = self.put("a.md", b"a\r\nb")
        code, _, _ = self.run_edits(f"=== {p}\n--- old\nb\n+++ new\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"a")

    def test_delete_mid_line_fragment(self):
        p = self.put("a.md", b"keep this, drop this\n")
        code, _, _ = self.run_edits(f"=== {p}\n--- old\n, drop this\n+++ new\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"keep this\n")

    def test_whitespace_hint(self):
        p = self.put("a.md", b"def f():\n    return  1\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old\ndef f():\n  return 1\n+++ new\nx\n")
        self.assertEqual(code, 1)
        self.assertIn("0 matches", err)
        self.assertIn("only whitespace differs", err)

    def test_mixed_line_endings_hint(self):
        p = self.put("a.md", b"a\r\nb\nc\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old\na\nb\n+++ new\nx\n")
        self.assertEqual(code, 1)
        self.assertIn("only line endings differ", err)
        self.assertEqual(self.get(p), b"a\r\nb\nc\n")

    def test_repeated_path_and_relative_path(self):
        self.put("a.md", b"one two\n")
        cwd = os.getcwd()
        os.chdir(self.dir)
        try:
            code, out, _ = self.run_edits(
                "=== a.md\n--- old\none\n+++ new\n1\n=== ./a.md\n--- old\n1 two\n+++ new\nok\n"
            )
        finally:
            os.chdir(cwd)
        self.assertEqual(code, 0)
        self.assertEqual(out, "edits: a.md (2 edits, lines numbered before later edits)\n  a.md:1: 1 two\n")
        self.assertEqual(self.get(f"{self.dir}/a.md"), b"ok\n")


class Ranges(Base):
    LINES = b"".join(b"line %d\n" % i for i in range(1, 11))

    def test_until_keeps_its_line(self):
        p = self.put("a.c", self.LINES)
        code, out, _ = self.run_edits(f"=== {p}\n--- from\nline 3\n--- until\nline 6\n+++ new\nA\nB\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"line 1\nline 2\nA\nB\nline 6\nline 7\nline 8\nline 9\nline 10\n")
        self.assertIn(": replaced lines 3-5 (3) with 2 new lines, now lines 3-4", out)
        self.assertIn("edits: undo with: edits --undo ", out)
        self.assertIn(">     3  A\n>     4  B\n      5  line 6\n      6  line 7\n", out)
        self.assertIn("      1  line 1\n      2  line 2\n>     3  A", out)

    def test_to_replaces_its_line_and_anchors_find_whole_lines(self):
        p = self.put("a.c", b"int f(void)\n{\n    return 1;\n} /* f */\nint g;\n")
        code, _, _ = self.run_edits(f"=== {p}\n--- from\nf(void\n--- to\n/* f\n+++ new\nint f(void) {{ return 2; }}\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"int f(void) { return 2; }\nint g;\n")

    def test_end_must_be_unique_after_from(self):
        p = self.put("a.c", b"}\nint f(void)\n{\n    if (x) {\n    }\n}\nint g;\n")
        code, _, err = self.run_edits(f"=== {p}\n--- from\nint f(\n--- to\n}}\n+++ new\nx\n")
        self.assertEqual(code, 1)
        self.assertIn("`--- to` matches 2 times from the `--- from` line down", err)
        self.assertIn("anchor `--- until`", err)
        code, _, _ = self.run_edits(f"=== {p}\n--- from\nint f(\n--- until\nint g;\n+++ new\nint f;\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"}\nint f;\nint g;\n")

    def test_from_counts_and_hints(self):
        p = self.put("a.c", self.LINES)
        code, _, err = self.run_edits(f"=== {p}\n--- from\nline 1\n--- to\nline 3\n+++ new\nx\n")
        self.assertEqual(code, 1)
        self.assertIn("`--- from` has 2 matches", err)
        code, _, err = self.run_edits(f"=== {p}\n--- from\nline  4\n--- to\nline 5\n+++ new\nx\n")
        self.assertIn("`--- from` has 0 matches", err)
        self.assertIn("only whitespace differs", err)
        self.assertEqual(self.get(p), self.LINES)

    def test_until_on_the_from_line_fails(self):
        p = self.put("a.c", b"a b\nc\n")
        code, _, err = self.run_edits(f"=== {p}\n--- from\na\n--- until\nb\n+++ new\nx\n")
        self.assertEqual(code, 1)
        self.assertIn("must start a later line", err)

    def test_delete_and_crlf(self):
        p = self.put("a.c", self.LINES.replace(b"\n", b"\r\n"))
        code, out, _ = self.run_edits(f"=== {p}\n--- from\nline 2\n--- to\nline 4\n+++ new\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"line 1\r\n" + b"".join(b"line %d\r\n" % i for i in range(5, 11)))
        self.assertIn(": deleted lines 2-4 (3)", out)
        self.assertIn("      1  line 1\n>        (3 lines deleted here)\n      2  line 5\n", out)

    def test_through_the_last_line_without_newline(self):
        p = self.put("a.c", b"a\nb\nc")
        code, _, _ = self.run_edits(f"=== {p}\n--- from\nb\n--- to\nc\n+++ new\nB\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"a\nB")
        code, _, _ = self.run_edits(f"=== {p}\n--- from\nB\n--- to\nB\n+++ new\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"a")

    def test_long_replacement_shows_its_ends(self):
        p = self.put("a.c", b"top\nold\nbottom\n")
        new = "\n".join(f"n{i}" for i in range(1, 21))
        code, out, _ = self.run_edits(f"=== {p}\n--- from\nold\n--- to\nold\n+++ new\n{new}\n")
        self.assertEqual(code, 0)
        self.assertIn(">     4  n3\n>        ... 14 more\n>    19  n18\n", out)
        self.assertIn(">    21  n20\n     22  bottom\n", out)

    def test_mixed_with_text_edits_and_all_or_nothing(self):
        p = self.put("a.c", self.LINES)
        code, _, err = self.run_edits(
            f"=== {p}\n--- old\nline 1\n+++ new\nfirst\n--- from\nline 2\n--- to\nline 99\n+++ new\nx\n"
        )
        self.assertEqual(code, 1)
        self.assertIn("`--- from` on input line 6: `--- to` matches 0 times", err)
        self.assertEqual(self.get(p), self.LINES)


class Findings(Base):
    """Regressions for the 2026-10-27 stress tests."""

    def test_overlapping_matches_are_not_unique(self):
        p = self.put("a", b"end\nend\nend\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old\nend\nend\n+++ new\nX\nY\n")
        self.assertEqual(code, 1)
        self.assertIn("2 matches", err)
        code, _, err = self.run_edits(f"=== {p}\n--- from\nend\nend\n--- to\nend\n+++ new\nX\n")
        self.assertIn("`--- from` has 2 matches", err)

    def test_whole_line_delete_and_mixed_endings(self):
        p = self.put("a", b"a\n\nb\n\nc\n")
        self.assertEqual(self.run_edits(f"=== {p}\n--- old\nb\n\nc\n+++ new\nc\n")[0], 0)
        self.assertEqual(self.get(p), b"a\n\nc\n")
        p = self.put("m", b"a\r\nb\r\nc\n")
        self.assertEqual(self.run_edits(f"=== {p}\n--- old\nb\n+++ new\n")[0], 0)
        self.assertEqual(self.get(p), b"a\r\nc\n")
        p = self.put("w", b"x\na-x\nx\n")
        self.assertEqual(self.run_edits(f"=== {p}\n--- old all\nx\n+++ new\n")[0], 0)
        self.assertEqual(self.get(p), b"a-\n")

    def test_all_reports_its_count_and_lines_and_saves_an_undo(self):
        p = self.put("a", b"stats = stats + 1\nx\nstats\n")
        _, out, _ = self.run_edits(f"=== {p}\n--- old all\nstats\n+++ new\nS\n")
        self.assertIn("`all` replaced 3)", out)
        self.assertIn(f"{p}:1: S = S + 1\n", out)
        self.assertIn(f"{p}:3: S\n", out)
        self.assertIn("edits --undo ", out)

    def test_aliases_and_symlinks_edit_the_real_file(self):
        os.mkdir(f"{self.dir}/real")
        target = self.put("real/f.txt", b"one\ntwo\n")
        try:
            os.symlink(f"{self.dir}/real", f"{self.dir}/jn", target_is_directory=True)
            os.symlink(target, f"{self.dir}/link.txt")
        except OSError:
            self.skipTest("symlinks not allowed here")
        code, _, _ = self.run_edits(
            f"=== {self.dir}/real/f.txt\n--- old\none\n+++ new\nONE\n=== {self.dir}/jn/f.txt\n--- old\ntwo\n+++ new\nTWO\n"
        )
        self.assertEqual(code, 0)
        self.assertEqual(self.get(target), b"ONE\nTWO\n")
        self.assertEqual(self.run_edits(f"=== {self.dir}/link.txt\n--- old\nONE\n+++ new\n1\n")[0], 0)
        self.assertTrue(os.path.islink(f"{self.dir}/link.txt"))
        self.assertEqual(self.get(target), b"1\nTWO\n")

    def test_read_only_file_writes_nothing(self):
        a = self.put("a", b"a\n")
        b = self.put("b", b"b\n")
        os.chmod(b, 0o444)
        try:
            code, _, err = self.run_edits(f"=== {a}\n--- old\na\n+++ new\nA\n=== {b}\n--- old\nb\n+++ new\nB\n")
        finally:
            os.chmod(b, 0o666)
        self.assertEqual(code, 2)
        self.assertIn("read-only", err)
        self.assertEqual((self.get(a), self.get(b)), (b"a\n", b"b\n"))
        self.assertEqual(sorted(os.listdir(self.dir)), ["a", "b"])

    def test_commit_rolls_back_when_a_file_changed_meanwhile(self):
        a = self.put("a", b"a\n")
        b = self.put("b", b"b\n")
        failed, stuck = edits.commit([(a, b"A\n", b"a\n", "a"), (b, b"B\n", b"stale\n", "b")])
        self.assertIn("changed while editing", failed)
        self.assertEqual(stuck, [])
        self.assertEqual((self.get(a), self.get(b)), (b"a\n", b"b\n"))
        self.assertEqual(sorted(os.listdir(self.dir)), ["a", "b"])

    def test_range_edge_cases(self):
        p = self.put("a", b"L1\nL2\nL3\nL4\nL5\n")
        code, _, err = self.run_edits(f"=== {p}\n--- from\nL2\nL3\nL4\n--- to\nL2\n+++ new\nx\n")
        self.assertIn("ends inside the `--- from` anchor", err)
        code, _, err = self.run_edits(f"=== {p}\n--- from\nL4\n--- until\nL2\n+++ new\nx\n")
        self.assertIn("above `--- from`; swap them?", err)
        code, _, err = self.run_edits(f"=== {p}\n--- from\nLX\n--- to\nLY\n+++ new\nx\n")
        self.assertIn("`--- to` has no match anywhere", err)
        q = self.put("cr", b"one\rtwo\r")
        self.assertIn("lone CR", self.run_edits(f"=== {q}\n--- from\none\n--- to\none\n+++ new\nx\n")[2])
        self.assertEqual(self.get(q), b"one\rtwo\r")

    def test_echo_flags_later_edits(self):
        p = self.put("a", b"".join(b"line %d\n" % i for i in range(1, 11)))
        code, out, _ = self.run_edits(
            f"=== {p}\n--- from\nline 5\n--- to\nline 5\n+++ new\nFIVE\n--- old\nline 1\nline 2\n+++ new\none\n"
        )
        self.assertEqual(code, 0)
        self.assertIn(": replaced line 5 (1) with 1 new line, now line 5 (line numbers before this run's later edits)", out)

    def test_until_keeps_the_blank_lines_above_it_unless_deleting(self):
        src = b"int f(void)\n{\n}\n\nint g(void)\n{\n}\n"
        p = self.put("a.c", src)
        self.assertEqual(self.run_edits(f"=== {p}\n--- from\nint f\n--- until\nint g\n+++ new\nint f(int x)\n{{\n}}\n")[0], 0)
        self.assertEqual(self.get(p), b"int f(int x)\n{\n}\n\nint g(void)\n{\n}\n")
        q = self.put("b.md", b"# A\na\n\n# B\nb\n\n# C\nc\n")
        self.assertEqual(self.run_edits(f"=== {q}\n--- from\n# B\n--- until\n# C\n+++ new\n")[0], 0)
        self.assertEqual(self.get(q), b"# A\na\n\n# C\nc\n")

    def test_more_hints(self):
        p = self.put("a.c", b"if (x)\n\treturn  1;\nint y;\nint y;\n")
        _, _, err = self.run_edits(f"=== {p}\n--- old\nif (x)\n    return 1;\n+++ new\nz\n")
        self.assertIn("input line 4 is '    return 1;', file line 2 is '\\treturn  1;'", err)
        _, _, err = self.run_edits(f"=== {p}\n--- old\nint y;\n+++ new\nz\n")
        self.assertIn("2 matches, need exactly 1 (lines 3, 4)", err)
        _, _, err = self.run_edits(f"=== {p}\n--- old\nif (x)\n+++ new\nif (y)\n--- old\nif (x)\n+++ new\nif (z)\n")
        self.assertIn("an earlier edit in this batch changed it", err)
        _, _, err = self.run_edits(f"=== {p}\n--- old all\nnope\n+++ new\nz\n")
        self.assertIn("`--- old all` text on input line 3", err)

    def test_indentation_warning(self):
        p = self.put("build.txt", b"all:\n\tcc a.c\n")
        code, out, _ = self.run_edits(f"=== {p}\n--- old\nall:\n\tcc a.c\n+++ new\nall:\n    cc b.c\n")
        self.assertEqual(code, 0)
        self.assertIn("warning: ", out)
        self.assertIn("indents with spaces; the file uses tabs", out)
        # In a Makefile, spaces where recipes need tabs are refused.
        p = self.put("Makefile", b"all:\n\tcc a.c\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old\nall:\n\tcc a.c\n+++ new\nall:\n    cc b.c\n")
        self.assertEqual(code, 1)
        self.assertIn("Makefile recipe lines need a tab", err)
        self.assertEqual(self.get(p), b"all:\n\tcc a.c\n")

    def test_swap_checks_before_every_try(self):
        p = self.put("a", b"theirs\n")
        tmp = self.put("t", b"mine\n")
        with self.assertRaises(edits.Refused):
            edits.swap(tmp, p, b"original\n", b"mine\n", "a")
        self.assertEqual(self.get(p), b"theirs\n")

    def test_git_bash_paths_map_or_refuse(self):
        if os.name != "nt" or shutil.which("cygpath") is None:
            self.skipTest("Windows with cygpath only")
        self.assertNotIn("C:\\tmp", edits.native_path("/tmp/x.txt"))
        self.assertTrue(edits.native_path("/tmp/x.txt").endswith("x.txt"))

    def test_miss_messages_point_at_the_difference(self):
        p = self.put("a.c", b"int f(void)\n{\n    return -3;\n}\n")
        _, _, err = self.run_edits(f"=== {p}\n--- old\nint f(void)\n{{\n    return -1;\n}}\n+++ new\nx\n")
        self.assertIn("lines 1-2 of the old text match file line 1; then input line 5 has '    return -1;', the file has '    return -3;'", err)
        q = self.put("u", "café “ok” — done\n".encode())
        _, _, err = self.run_edits(f"=== {q}\n--- old\ncafe \"ok\" - done\n+++ new\nx\n")
        self.assertIn("accents, curly quotes or dashes", err)

    def test_paths(self):
        os.mkdir(f"{self.dir}/d")
        _, _, err = self.run_edits(f"=== {self.dir}/d\n--- old\nx\n+++ new\ny\n")
        self.assertIn("is a folder", err)


class RoundThree(Base):
    """Regressions for the third round of stress tests."""

    def test_any_escaped_dash_plus_or_equals_line_loses_one_backslash(self):
        p = self.put("f", b"---\ntitle: a\n---\n")
        self.assertEqual(self.run_edits(f"=== {p}\n--- old\n\\---\ntitle: a\n+++ new\n\\---\ntitle: b\n")[0], 0)
        self.assertEqual(self.get(p), b"---\ntitle: b\n---\n")
        self.assertEqual(edits.parse("=== a\n--- old\nx\n+++ new\n\\\\---\n")[0][1][0].new, "\\---")

    def test_until_keeps_a_whitespace_only_separator_and_drops_padding(self):
        p = self.put("f.py", b"def a():\n    pass\n    \ndef b():\n")
        code, _, _ = self.run_edits(f"=== {p}\n--- from\ndef a\n--- until\ndef b\n+++ new\ndef a():\n    return 1\n\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"def a():\n    return 1\n    \ndef b():\n")

    def test_range_notes_text_taken_from_anchor_lines(self):
        p = self.put("f.py", b"result = compute(\n    a,\n    b)\n")
        code, out, _ = self.run_edits(f"=== {p}\n--- from\ncompute(\n--- to\nb)\n+++ new\nfast(a, b)\n")
        self.assertEqual(code, 0)
        self.assertIn("also held 'result =' before the anchor; it was replaced too", out)

    def test_whole_line_delete_edges(self):
        p = self.put("f", b"a\nx\nx")
        self.assertEqual(self.run_edits(f"=== {p}\n--- old all\nx\n+++ new\n")[0], 0)
        self.assertEqual(self.get(p), b"a")
        q = self.put("g", b"if x:\n    foo()\n    bar()\nz  \ny\n")
        self.assertEqual(self.run_edits(f"=== {q}\n--- old\nfoo()\n+++ new\n--- old\nz\n+++ new\n")[0], 0)
        self.assertEqual(self.get(q), b"if x:\n    bar()\ny\n")

    def test_message_locations(self):
        p = self.put("f", b"1\n2\nstart\nb\nfoo  bar\nc\n## Setup\nx\n## Next\n## Last\n")
        _, _, err = self.run_edits(f"=== {p}\n--- from\nstart\n--- to\nfoo bar\n+++ new\nz\n")
        self.assertIn("input line 5 is 'foo bar', file line 5 is 'foo  bar'", err)
        _, _, err = self.run_edits(f"=== {p}\n--- from\n## Setup\n--- until\n## \n+++ new\nz\n")
        self.assertIn("one is on the `--- from` line itself", err)
        _, _, err = self.run_edits(f"=== {p}\n--- old\nstart\n+++ new\nstart\nstart\n--- old\nstart\n+++ new\nz\n")
        self.assertIn("an earlier edit in this batch added a copy", err)
        _, _, err = self.run_edits(f"=== {p}\n--- old\nb\n+++ new\nc\n=== Usage\n--- old\nx\n+++ new\ny\n")
        self.assertIn("if `=== Usage` is content, start it with a backslash", err)

    def test_indentation_warning_ignores_continuations(self):
        p = self.put("Makefile", b"all:\n\tcc a.c\n")
        _, out, _ = self.run_edits(f"=== {p}\n--- old\n\tcc a.c\n+++ new\n\tcc a.c \\\n          -lm\n")
        self.assertNotIn("warning", out)

    def test_hard_links_are_refused(self):
        a = self.put("a", b"x\n")
        try:
            os.link(a, f"{self.dir}/b")
        except OSError:
            self.skipTest("no hard links here")
        code, _, err = self.run_edits(f"=== {a}\n--- old\nx\n+++ new\ny\n")
        self.assertEqual(code, 2)
        self.assertIn("hard links", err)
        self.assertEqual(self.get(f"{self.dir}/b"), b"x\n")

    def test_locks_live_in_the_state_folder_and_belong_to_their_owner(self):
        p = self.put("a", b"x\n")
        held, token = edits.lock([(p, b"", b"", "a")])
        self.assertEqual(os.listdir(self.dir), ["a"])
        edits.unlock(held, "someone else")
        self.assertTrue(os.path.exists(held[0]))
        edits.unlock(held, token)
        self.assertFalse(os.path.exists(held[0]))

    def test_partly_written_is_reported_and_never_retried(self):
        p = self.put("a", b"x\n")
        real = edits.commit
        edits.commit = lambda writes: ("b is locked by another program", [(writes[0][0], writes[0][3])])
        try:
            code, _, err = self.run_edits(f"=== {p}\n--- old\nx\n+++ new\ny\n")
        finally:
            edits.commit = real
        self.assertEqual(code, 3)
        self.assertIn("partly written", err)
        self.assertNotIn("--retry", err)
        self.assertIn("edits --undo", err)


class RoundFour(Base):
    def test_empty_new_before_a_file_header_after_escaped_old_is_refused(self):
        a, b = self.put("a.md", b"\\=== x\n"), self.put("b.c", b"int y;\n")
        a_text = self.get(a)
        code, _, err = self.run_edits(
            f"=== {a}\n--- old\n\\=== x\n+++ new\n=== {b}\n--- old\nint y;\n+++ new\nint z;\n"
        )
        self.assertEqual(code, 2)
        self.assertIn("if it's content, write it as `\\===", err)
        self.assertEqual((self.get(a), self.get(b)), (a_text, b"int y;\n"))
        # The same delete as the last edit is fine.
        self.assertEqual(self.run_edits(f"=== {b}\n--- old\nint y;\n+++ new\nint z;\n=== {a}\n--- old\n\\=== x\n+++ new\n")[0], 0)

    def test_a_header_with_no_edits_names_its_line_and_the_escape(self):
        p = self.put("a.md", b"x\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old\nx\n+++ new\ny\n=== Results ===\n")
        self.assertEqual(code, 2)
        self.assertIn("line 6: `=== Results ===` has no edits under it; if it's content, start it with a backslash", err)

    def test_misses_point_at_the_line_that_differs(self):
        p = self.put("a.c", b"int f(void)\n{\n    while(child != NULL)\n        n++;\n}\n")
        _, _, err = self.run_edits(f"=== {p}\n--- old\n    while (child != NULL)\n+++ new\nx\n")
        self.assertIn("only a space inside a line differs", err)
        self.assertIn("file line 3", err)
        _, _, err = self.run_edits(f"=== {p}\n--- old\nint g(void)\n{{\n+++ new\nx\n")
        self.assertIn("input line 3 is 'int g(void)'; the most similar file line is 1: 'int f(void)'", err)
        _, _, err = self.run_edits(f"=== {p}\n--- from\nint g(void)\n--- to\n}}\n+++ new\nx\n")
        self.assertIn("the most similar file line is 1", err)

    def test_fold_hint_names_the_line(self):
        p = self.put("a.txt", "it\u2019s here\n".encode())
        _, _, err = self.run_edits(f"=== {p}\n--- old\nit's here\n+++ new\nx\n")
        self.assertIn("curly quotes", err)
        self.assertIn("file line 1", err)

    def test_many_matches_hint_names_the_count(self):
        p = self.put("a.txt", b"x\nx\nx\n")
        _, _, err = self.run_edits(f"=== {p}\n--- old\nx\n+++ new\ny\n")
        self.assertIn("`--- old all` if all 3 should change", err)

    def test_all_deletions_show_as_deleted(self):
        p = self.put("a.txt", b"x\ny\nx\n")
        code, out, _ = self.run_edits(f"=== {p}\n--- old all\nx\n+++ new\n")
        self.assertEqual(code, 0)
        self.assertIn("(deleted here)", out)
        self.assertEqual(self.get(p), b"y\n")

    def test_retry_of_a_copy_runs_in_the_current_folder(self):
        self.put("a", b"x\n")
        copy = self.put("copy.txt", b"=== a\n--- old\nx\n+++ new\ny\n")
        env = dict(os.environ, EDITS_STATE=self.state.name)
        r = subprocess.run([sys.executable, SCRIPT, "--retry", copy], capture_output=True, text=True, cwd=self.dir, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.get(f"{self.dir}/a"), b"y\n")
        self.assertTrue(os.path.exists(copy))  # only kept inputs are deleted


class Haiku(Base):
    """Mistakes small models make when they write old text as whole lines."""

    def test_indented_old_text_must_start_its_line(self):
        p = self.put("a.py", b"def f():\n        return x\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old\n    return x\n+++ new\n  return y\n")
        self.assertEqual(code, 1)
        self.assertIn("file line 2 is '        return x'", err)
        self.assertEqual(self.get(p), b"def f():\n        return x\n")
        # Indentation after other text on the line still matches.
        q = self.put("b.txt", b"a    = 1\n")
        self.assertEqual(self.run_edits(f"=== {q}\n--- old\n    = 1\n+++ new\n = 2\n")[0], 0)
        self.assertEqual(self.get(q), b"a = 2\n")

    def test_indented_new_text_replaces_the_line_indentation(self):
        p = self.put("a.py", b"if a:\n    return x\n")
        self.assertEqual(self.run_edits(f"=== {p}\n--- old\nreturn x\n+++ new\n    return y\n")[0], 0)
        self.assertEqual(self.get(p), b"if a:\n    return y\n")

    def test_a_line_matched_only_in_part_is_shown(self):
        p = self.put("a.py", b"x = 1\n    return f(num).strip()\n")
        code, out, _ = self.run_edits(f"=== {p}\n--- old\n    return f(num)\n+++ new\n    return g(num).strip()\n")
        self.assertEqual(code, 0)
        self.assertIn(f"{p}:2: return g(num).strip().strip()", out)
        # A whole-line match shows nothing more.
        code, out, _ = self.run_edits(f"=== {p}\n--- old\nx = 1\n+++ new\nx = 2\n")
        self.assertEqual(out, f"edits: {p} (1 edit)\n")


class EndsAndDisplay(Base):
    def test_old_ending_in_blank_lines_only_matches_at_the_end_of_the_file(self):
        p = self.put("a.py", b"x = 1\r\n\r\n\r\n")
        self.assertEqual(self.run_edits(f"=== {p}\n--- old\nx = 1\n\n\n+++ new\nx = 1\n")[0], 0)
        self.assertEqual(self.get(p), b"x = 1\r\n")
        # Mid-file, the same shape is padding and is refused.
        q = self.put("b.py", b"x = 1\n\ny = 2\n")
        code, _, err = self.run_edits(f"=== {q}\n--- old\nx = 1\n\n+++ new\nx = 2\n")
        self.assertEqual(code, 1)
        self.assertIn("allowed only where the blank lines run to the end of the file", err)
        self.assertEqual(self.get(q), b"x = 1\n\ny = 2\n")

    def test_until_new_text_must_not_repeat_the_kept_line(self):
        p = self.put("a.py", b"def a():\n    pass\n\ndef b():\n    pass\n")
        code, _, err = self.run_edits(f"=== {p}\n--- from\ndef a():\n--- until\ndef b():\n+++ new\ndef a():\n    return 1\n\ndef b():\n")
        self.assertEqual(code, 1)
        self.assertIn("ends with the `--- until` line", err)

    def test_hints_show_the_part_that_differs(self):
        long = "x" * 150
        p = self.put("a.txt", f"{long} C:\\Users\\a\tend\n".encode())
        _, _, err = self.run_edits(f"=== {p}\n--- old\n{long} C:\\Users\\a end\n+++ new\ny\n")
        self.assertIn("\\Users\\a\\tend", err)  # the tab is escaped, the backslashes are not doubled
        self.assertNotIn("\\\\Users", err)


class RoundSix(Base):
    def test_all_refuses_a_mix_of_whole_words_and_parts_of_words(self):
        p = self.put("a.sh", b"cat <<'EOF'\nx\nEOF\ncat <<'EOF2'\nEOF2\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old all\nEOF\n+++ new\nEND\n")
        self.assertEqual(code, 1)
        self.assertIn("2 of the 4 matches sit inside longer words", err)
        # Every match inside a word, as in a prefix rename, is fine.
        q = self.put("b.c", b"cJSON_Parse(x); cJSON_Print(y);\n")
        self.assertEqual(self.run_edits(f"=== {q}\n--- old all\ncJSON_\n+++ new\nCJ_\n")[0], 0)
        self.assertEqual(self.get(q), b"CJ_Parse(x); CJ_Print(y);\n")

    def test_old_text_over_several_lines_must_cover_whole_lines(self):
        p = self.put("a.md", b"# Title\nResults (updated)\nend\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old\n# Title\nResults\n+++ new\n# Title\nScores\n")
        self.assertEqual(code, 1)
        self.assertIn("ends partway through file line 2, before '(updated)'", err)
        code, _, err = self.run_edits(f"=== {p}\n--- old\nTitle\nResults (updated)\n+++ new\nx\n")
        self.assertIn("starts partway through file line 1, after '#'", err)
        self.assertEqual(self.get(p), b"# Title\nResults (updated)\nend\n")

    def test_end_of_file_blank_lines_go_and_the_final_newline_stays(self):
        p = self.put("a.py", b"}\n\n\n\n")
        self.assertEqual(self.run_edits(f"=== {p}\n--- old\n}}\n\n+++ new\n}}\n")[0], 0)
        self.assertEqual(self.get(p), b"}\n")
        q = self.put("b.py", b"}\n\n")
        self.assertEqual(self.run_edits(f"=== {q}\n--- old\n}}\n\n\n+++ new\n}}\n")[0], 0)
        self.assertEqual(self.get(q), b"}\n")

    def test_padding_errors_list_every_block(self):
        p = self.put("a", b"x\ny\n")
        _, _, err = self.run_edits(f"=== {p}\n--- old\nx\n+++ new\n\nX\n--- old\ny\n+++ new\nY\n\n=== {p}\n--- old\nX\n+++ new\nZ\n")
        self.assertIn("input line 5 (start of the `+++ new` block) and input line 11 (end of the `+++ new` block)", err)

    def test_rerunning_an_edit_that_adds_text_is_refused(self):
        p = self.put("a.py", b"import os\nimport sys\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old\nimport os\n+++ new\nimport os\nimport sys\n")
        self.assertEqual(code, 1)
        self.assertIn("looks applied already", err)
        q = self.put("b.md", b"Results (updated)\n")
        _, _, err = self.run_edits(f"=== {q}\n--- old\nResults\n+++ new\nResults (updated)\n")
        self.assertIn("looks applied already", err)

    def test_old_equal_to_new_is_refused(self):
        p = self.put("a.py", b"x = 1\ny = 2\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old\nx = 1\n+++ new\nx = 2\n--- old\ny = 2\n+++ new\ny = 2\n")
        self.assertEqual(code, 1)
        self.assertIn("the old and new text are the same", err)
        self.assertEqual(self.get(p), b"x = 1\ny = 2\n")

    def test_trailing_spaces_stay_with_the_replaced_line(self):
        p = self.put("a.md", b"- one\t\n- end\n")
        self.assertEqual(self.run_edits(f"=== {p}\n--- old\n- one\n+++ new\n- one\n- two\n")[0], 0)
        self.assertEqual(self.get(p), b"- one\n- two\n- end\n")

    def test_until_anchor_of_two_lines_is_not_repeated(self):
        p = self.put("a.py", b"def a():\n    pass\n\ndef b():\n    pass\n")
        code, _, err = self.run_edits(
            f"=== {p}\n--- from\ndef a():\n--- until\ndef b():\n    pass\n+++ new\ndef a():\n    return 1\ndef b():\n    pass\n")
        self.assertEqual(code, 1)
        self.assertIn("ends with the `--- until` line", err)

    def test_ambiguous_matches_show_their_lines(self):
        p = self.put("a.sh", b"EOF\ncat <<'EOF'\n")
        _, _, err = self.run_edits(f"=== {p}\n--- old\nEOF\n+++ new\nEND\n")
        self.assertIn("line 2: 'cat <<'EOF''", err)

    def test_deleting_the_last_block_takes_its_blank_lines(self):
        p = self.put("a.py", b"def a():\n    pass\n\n\ndef b():\n    pass\n")
        self.assertEqual(self.run_edits(f"=== {p}\n--- from\ndef b():\n--- to\n    pass\n+++ new\n")[0], 0)
        self.assertEqual(self.get(p), b"def a():\n    pass\n")

    def test_makefile_error_points_at_the_new_text(self):
        p = self.put("Makefile", b"all:\n\tcc a.c\n")
        _, _, err = self.run_edits(f"=== {p}\n--- old\n\tcc a.c\n+++ new\n    cc b.c\n")
        self.assertIn("`+++ new` text from input line 5: Makefile recipe lines need a tab", err)


class RoundSeven(Base):
    def test_partial_edit_leaving_trailing_spaces_shows_the_line(self):
        p = self.put("a.md", b"a\nSummary:   \nb\n")
        code, out, _ = self.run_edits(f"=== {p}\n--- old\nSummary:\n+++ new\nSummary (checked):\n")
        self.assertEqual(code, 0)
        self.assertIn(":2: Summary (checked): (its trailing spaces stay)", out)
        self.assertEqual(self.get(p), b"a\nSummary (checked):   \nb\n")

    def test_to_anchor_inside_the_from_line_is_skipped(self):
        p = self.put("a.md", b"x\n```sh\ncat <<EOF\n```\nend\n")
        code, _, _ = self.run_edits(f"=== {p}\n--- from\n```sh\n--- to\n```\n+++ new\n```bash\necho hi\n```\n")
        self.assertEqual(code, 0)
        self.assertEqual(self.get(p), b"x\n```bash\necho hi\n```\nend\n")

    def test_miss_says_when_the_new_text_is_already_there(self):
        p = self.put("a.c", b"int bar_x = 1;\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old all\nfoo_x\n+++ new\nbar_x\n")
        self.assertEqual(code, 1)
        self.assertIn("the new text is already at line 1, so this edit may have run already", err)

    def test_kept_anchor_in_the_file_is_not_a_rerun(self):
        # Deleting a block by keeping the next line's start: that line was there all along,
        # so its presence says nothing about a rerun; the real miss is a blank line.
        p = self.put("t.md", b"- [ ] **A task**\n  note about A that is long.\n\n- [ ] **B task: arrays**\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old\n- [ ] **A task**\n  note about A that is long.\n- [ ] **B task\n+++ new\n- [ ] **B task\n")
        self.assertEqual(code, 1)
        self.assertNotIn("may have run already", err)
        self.assertIn("only blank lines differ", err)
        self.assertIn("then input line 5 has '- [ ] **B task', the file has ''", err)

    def test_rerun_of_a_multi_line_edit_says_it_may_have_run(self):
        p = self.put("c.txt", b"start\nnew one\nnew two\nend\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old\nold one\nold two\n+++ new\nnew one\nnew two\n")
        self.assertEqual(code, 1)
        self.assertIn("the new text is already at line 2, so this edit may have run already", err)

    def test_new_text_elsewhere_with_the_old_lines_still_there_is_not_a_rerun(self):
        p = self.put("d.txt", b"keep this line here\nkeep this line here!\nvalue = 2\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old\nkeep this line here\nvalue = 1\n+++ new\nvalue = 2\n")
        self.assertEqual(code, 1)
        self.assertNotIn("may have run already", err)

    def test_miss_inside_a_long_line_names_the_line(self):
        p = self.put("r.md", b"Intro.\nPath is C:\\temp and cost is $6 for `coffee` (see notes).\nend\n")
        _, _, err = self.run_edits(f"=== {p}\n--- old\ncost is $5 for `tea`.\n+++ new\nx\n")
        self.assertIn("the file line holding the most of it is 2:", err)

    def test_padding_error_also_lists_old_text_ending_blank(self):
        p = self.put("a", b"b\n\nc\nd\n")
        _, _, err = self.run_edits(f"=== {p}\n--- old\nb\n\n+++ new\nB\n--- old\nc\n+++ new\n\nC\n")
        self.assertIn("input line 4 (end of the `--- old` block; fine only", err)
        self.assertIn("and input line 10 (start of the `+++ new` block)", err)

    def test_marker_with_nothing_after_it_suggests_a_backslash(self):
        p = self.put("a", b"a\n")
        _, _, err = self.run_edits(f"=== {p}\n--- old\na\n+++ new\nb\n--- old\n")
        self.assertIn("this edit has no `+++ new`; if line 6 is content, start it with a backslash", err)

    def test_old_text_ending_blank_mid_file_hint(self):
        p = self.put("a", b"b\n\nc\n")
        _, _, err = self.run_edits(f"=== {p}\n--- old\nb\n\n+++ new\nB\n")
        self.assertIn("include the next content line in both old and new text", err)


class Recovery(Base):
    def cli(self, stdin, *args, cwd=None):
        env = {**os.environ, "EDITS_STATE": self.state.name}
        return subprocess.run(
            [sys.executable, SCRIPT, *args], input=stdin, capture_output=True, cwd=cwd or self.dir, env=env
        )

    def kept(self, stderr):
        line = [x for x in stderr.decode().splitlines() if "input kept" in x][0]
        return line.split("edits --retry ")[1].strip()

    def undo_folder(self, stdout):
        return stdout.decode().split("edits --undo ")[1].strip()

    def test_retry_after_fixing_the_kept_input(self):
        self.put("a.md", b"one\ntwo\n")
        bad = self.cli(b"=== a.md\n--- old\none\n+++ new\n1\n--- old\nTWO\n+++ new\n2\n")
        self.assertEqual(bad.returncode, 1)
        self.assertIn(b"input line 7", bad.stderr)
        kept = self.kept(bad.stderr)
        # Fix just the bad line in the kept input, then retry from another folder.
        fix = self.cli(f"=== {kept}\n--- old\nTWO\n+++ new\ntwo\n".encode(), cwd=self.state.name)
        self.assertEqual(fix.returncode, 0)
        ok = self.cli(b"", "--retry", kept, cwd=self.state.name)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(self.get(f"{self.dir}/a.md"), b"1\n2\n")
        self.assertFalse(os.path.exists(kept))
        self.assertFalse(os.path.exists(kept + ".cwd"))

    def test_retry_failing_again_keeps_the_same_file(self):
        self.put("a.md", b"x\n")
        kept = self.kept(self.cli(b"=== a.md\n--- old\nnope\n+++ new\ny\n").stderr)
        again = self.cli(b"", "--retry", kept)
        self.assertEqual(again.returncode, 1)
        self.assertIn(f"run again: edits --retry {kept}".encode(), again.stderr)
        self.assertNotIn(b"input kept", again.stderr)
        self.assertTrue(os.path.exists(kept))

    def test_parse_errors_name_the_line_and_keep_the_input(self):
        self.put("a.md", b"x\n")
        bad = self.cli(b"=== a.md\n--- old\nx\ny\n")
        self.assertEqual(bad.returncode, 2)
        self.assertIn(b"line 2: this edit has no `+++ new`", bad.stderr)
        self.assertIn(b"input kept", bad.stderr)

    def test_undo_restores_and_refuses_after_later_changes(self):
        p = self.put("a.c", b"a\r\nb\r\nc\r\n")
        done = self.cli(b"=== a.c\n--- from\nb\n--- to\nc\n+++ new\n")
        self.assertEqual(done.returncode, 0)
        folder = self.undo_folder(done.stdout)
        self.assertEqual(self.get(p), b"a\r\n")
        back = self.cli(b"", "--undo", folder)
        self.assertEqual(back.returncode, 0, back.stderr)
        self.assertEqual(self.get(p), b"a\r\nb\r\nc\r\n")
        self.assertFalse(os.path.exists(folder))
        # A later change blocks the undo.
        done = self.cli(b"=== a.c\n--- from\nb\n--- to\nb\n+++ new\nB\n")
        folder = self.undo_folder(done.stdout)
        self.put("a.c", b"someone else\n")
        blocked = self.cli(b"", "--undo", folder)
        self.assertEqual(blocked.returncode, 1)
        self.assertIn(b"changed since", blocked.stderr)
        self.assertEqual(self.get(p), b"someone else\n")

    def test_retry_refuses_when_its_folder_is_gone(self):
        os.mkdir(f"{self.dir}/wt")
        self.put("wt/a.md", b"x\n")
        self.put("a.md", b"x\n")
        kept = self.kept(self.cli(b"=== a.md\n--- old\nnope\n+++ new\ny\n", cwd=f"{self.dir}/wt").stderr)
        with open(kept, "wb") as f:
            f.write(b"=== a.md\n--- old\nx\n+++ new\ny\n")
        shutil.rmtree(f"{self.dir}/wt")
        again = self.cli(b"", "--retry", kept)
        self.assertEqual(again.returncode, 2)
        self.assertIn(b"unknown or gone", again.stderr)
        self.assertEqual(self.get(f"{self.dir}/a.md"), b"x\n")

    def test_retry_keeps_a_file_that_is_not_a_kept_input(self):
        self.put("a.md", b"x\n")
        script = self.put("script.txt", b"=== a.md\n--- old\nx\n+++ new\ny\n")
        with open(script + ".cwd", "w") as f:
            f.write(self.dir)
        self.assertEqual(self.cli(b"", "--retry", script).returncode, 0)
        self.assertTrue(os.path.exists(script))

    def test_pruning_touches_only_its_own_entries(self):
        mine = os.path.join(self.state.name, "input-old.txt")
        other = os.path.join(self.state.name, "notes.md")
        for path in (mine, other):
            with open(path, "w") as f:
                f.write("x")
            os.utime(path, (0, 0))
        edits.state_dir()
        self.assertFalse(os.path.exists(mine))
        self.assertTrue(os.path.exists(other))

    def test_undo_refuses_a_folder_that_is_not_an_undo(self):
        os.mkdir(f"{self.dir}/app")
        with open(f"{self.dir}/app/manifest.json", "w") as f:
            f.write("[]")
        self.assertEqual(self.cli(b"", "--undo", f"{self.dir}/app").returncode, 2)
        self.assertTrue(os.path.exists(f"{self.dir}/app/manifest.json"))

    def test_undo_finishes_after_a_partial_restore(self):
        a = self.put("a", b"a\nb\n")
        b = self.put("b", b"a\nb\n")
        done = self.cli(b"=== a\n--- from\nb\n--- to\nb\n+++ new\nB\n=== b\n--- from\nb\n--- to\nb\n+++ new\nB\n")
        folder = self.undo_folder(done.stdout)
        with open(a, "wb") as f:
            f.write(b"a\nb\n")  # as if an earlier undo restored only this one
        back = self.cli(b"", "--undo", folder)
        self.assertEqual(back.returncode, 0, back.stderr)
        self.assertEqual((self.get(a), self.get(b)), (b"a\nb\n", b"a\nb\n"))

    def test_text_only_runs_save_no_undo(self):
        self.put("a.md", b"x\n")
        done = self.cli(b"=== a.md\n--- old\nx\n+++ new\ny\n")
        self.assertEqual(done.stdout, b"edits: a.md (1 edit)\n")
        self.assertEqual([x for x in os.listdir(self.state.name) if x != "locks"], [])
        self.assertEqual(os.listdir(os.path.join(self.state.name, "locks")), [])


class Cli(Base):
    def cli(self, stdin, *args):
        return subprocess.run(
            [sys.executable, SCRIPT, *args], input=stdin, capture_output=True, cwd=self.dir
        )

    def test_exit_codes(self):
        self.put("a.md", b"x\n")
        ok = self.cli(b"=== a.md\n--- old\nx\n+++ new\ny\n")
        self.assertEqual((ok.returncode, ok.stdout), (0, b"edits: a.md (1 edit)\n"))
        self.assertEqual(self.cli(b"=== a.md\n--- old\nnot there\n+++ new\ny\n").returncode, 1)
        self.assertEqual(self.cli(b"").returncode, 2)
        self.assertEqual(self.cli(b"junk\n").returncode, 2)
        self.assertEqual(self.cli(b"", "--help").returncode, 0)
        self.assertEqual(self.get(f"{self.dir}/a.md"), b"y\n")


if __name__ == "__main__":
    unittest.main()
