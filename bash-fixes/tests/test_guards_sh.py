"""guards.sh shell functions, run in Git Bash with a stand-in for the native program."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GUARDS = os.path.join(HERE, "..", "hooks", "guards.sh")


class GhApi(unittest.TestCase):
    def setUp(self):
        cygpath = shutil.which("cygpath")
        if os.name != "nt" or cygpath is None:
            self.skipTest("Windows Git Bash only")
        self.bash = os.path.join(os.path.dirname(cygpath), "bash.exe")
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        # A bash stand-in for gh that hands its arguments to native python,
        # which sees them after Git Bash's path rewriting, as gh.exe would.
        with open(os.path.join(self.dir, "gh"), "w", newline="\n") as f:
            f.write("#!/usr/bin/env bash\nexec python -c 'import json,sys; print(json.dumps(sys.argv[1:]))' \"$@\"\n")
        self.file = os.path.join(self.dir, "body.json")
        open(self.file, "w").close()

    def unix(self, path):
        return subprocess.run(["cygpath", "-u", path], capture_output=True, text=True, check=True).stdout.strip()

    def mixed(self, path):
        return subprocess.run(["cygpath", "-m", path], capture_output=True, text=True, check=True).stdout.strip()

    def gh(self, *args):
        script = f'source "$1"; shift; PATH="$(cygpath -u "{self.dir}"):$PATH"; gh "$@"'
        out = subprocess.run([self.bash, "-c", script, "x", GUARDS, *args], capture_output=True, text=True, check=True)
        return json.loads(out.stdout)

    def test_api_keeps_endpoint_and_fields_and_converts_real_files(self):
        f = self.unix(self.file)
        got = self.gh("api", "/advisories/GHSA-x", "-f", "path=/docs", "-F", f"body=@{f}", "--input", f)
        self.assertEqual(got, ["api", "/advisories/GHSA-x", "-f", "path=/docs", "-F", f"body=@{self.mixed(self.file)}", "--input", self.mixed(self.file)])

    def test_other_commands_keep_default_rewriting(self):
        got = self.gh("repo", "clone", "o/r", "/c/not-made-yet")
        self.assertEqual(got, ["repo", "clone", "o/r", "C:/not-made-yet"])


class Stdin(unittest.TestCase):
    def test_a_program_reading_stdin_does_not_wait_on_the_tool_pipe(self):
        cygpath = shutil.which("cygpath")
        if os.name != "nt" or cygpath is None:
            self.skipTest("Windows Git Bash only")
        bash = os.path.join(os.path.dirname(cygpath), "bash.exe")
        # stdin is a pipe nobody writes to or closes, like claude.exe's. After the
        # guards, stdin is /dev/null, and pipes inside the command still work.
        script = 'source "$1"; readlink /proc/$$/fd/0; printf "a\\nb\\n" | grep -c b'
        p = subprocess.run([bash, "-c", script, "x", GUARDS], stdin=subprocess.PIPE, capture_output=True, text=True, timeout=20)
        self.assertEqual(p.stdout.split(), ["/dev/null", "1"])


class WinSwitchTools(unittest.TestCase):
    def setUp(self):
        cygpath = shutil.which("cygpath")
        if os.name != "nt" or cygpath is None:
            self.skipTest("Windows Git Bash only")
        self.bash = os.path.join(os.path.dirname(cygpath), "bash.exe")
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        # A stand-in powercfg that prints its arguments as native python sees them.
        with open(os.path.join(self.dir, "powercfg"), "w", newline="\n") as f:
            f.write("#!/usr/bin/env bash\nexec python -c 'import json,sys; print(json.dumps(sys.argv[1:]))' \"$@\"\n")

    def test_switches_stay_and_real_paths_become_windows_paths(self):
        unix = subprocess.run(["cygpath", "-u", self.dir], capture_output=True, text=True, check=True).stdout.strip()
        script = f'source "$1"; shift; PATH="{unix}:$PATH"; powercfg "$@"'
        out = subprocess.run([self.bash, "-c", script, "x", GUARDS, "/change", "standby-timeout-dc", "0", "/output", unix],
                             capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(out.stdout), ["/change", "standby-timeout-dc", "0", "/output", os.path.normpath(self.dir)])


if __name__ == "__main__":
    unittest.main()
