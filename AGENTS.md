# claude-code-mods

Public Claude Code mods (plugins), one per folder, published as a marketplace
(`.claude-plugin/marketplace.json`). `README.md` describes each mod for users.

- Gate: `./check.sh <mod>` for the mods you changed, `./check.sh` for all of them. It
  runs `claude plugin validate --strict`, the plugin tests, and any Python tests.
- Keep personal paths, names, and private setup out of every file here.
