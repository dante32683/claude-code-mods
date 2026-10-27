"""Tests for bin/edits.py. Run from the bash-fixes folder:

    python -m unittest discover -s tests -p "test_*.py"
"""

import io
import os
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

    def tearDown(self):
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
        self.assertEqual(files, [("a.md", [("one\ntwo", "three", False)]), ("b.md", [("x", "", True)])])

    def test_blank_lines_inside_a_block_count(self):
        files = edits.parse("=== a\n--- old\nx\n\n+++ new\ny\n")
        self.assertEqual(files[0][1], [("x\n", "y", False)])

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
        self.assertIn("edit 1 ('missing line'): 0 matches", err)
        self.assertEqual(self.get(a), b"keep\n")
        self.assertEqual(self.get(b), b"keep\n")
        self.assertEqual(sorted(os.listdir(self.dir)), ["a.md", "b.md"])  # no temp files left

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
        self.assertIn("whitespace is ignored", err)

    def test_mixed_line_endings_hint(self):
        p = self.put("a.md", b"a\r\nb\nc\n")
        code, _, err = self.run_edits(f"=== {p}\n--- old\na\nb\n+++ new\nx\n")
        self.assertEqual(code, 1)
        self.assertIn("line endings are ignored", err)
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
        self.assertEqual(out, "edits: a.md (2 edits)\n")
        self.assertEqual(self.get(f"{self.dir}/a.md"), b"ok\n")


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
