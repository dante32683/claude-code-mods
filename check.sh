#!/usr/bin/env bash
# Check every mod, or only the ones named: `claude plugin validate --strict`, the
# plugin tests (tests/*.test.ts*), and any Python tests (tests/test_*.py).
# Usage: ./check.sh [mod ...]    Prints one line per mod and the full log of a failure.
set -uo pipefail
cd "$(dirname "$0")"

mods=("$@")
if [ ${#mods[@]} -eq 0 ]; then
  for d in */.claude-plugin; do mods+=("${d%/.claude-plugin}"); done
fi

log=$(mktemp)
trap 'rm -f "$log"' EXIT
failed=()
for m in "${mods[@]}"; do
  : > "$log"
  ok=1
  (cd "$m" && claude plugin validate --strict .) >>"$log" 2>&1 || ok=0
  if compgen -G "$m/tests/*.test.ts*" >/dev/null; then
    (cd "$m" && claude plugin test) >>"$log" 2>&1 || ok=0
  fi
  if compgen -G "$m/tests/test_*.py" >/dev/null; then
    (cd "$m" && python -m unittest discover -s tests -p 'test_*.py') >>"$log" 2>&1 || ok=0
  fi
  if [ $ok = 1 ]; then
    echo "pass  $m"
  else
    echo "FAIL  $m"
    sed 's/^/      /' "$log"
    failed+=("$m")
  fi
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "${#failed[@]} of ${#mods[@]} mods failed: ${failed[*]}"
  exit 1
fi
echo "All ${#mods[@]} mods pass."
