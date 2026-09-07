# Contributing to cdp-sniffer

## Setup

```bash
git clone https://github.com/Data338/cdp-sniffer.git
cd cdp-sniffer
npm install
npm link   # sniffer, sniffer-start, sniffer-mcp on PATH
```

You need Google Chrome (`google-chrome` on PATH). No other services.

## Running the smoke test

Needs a live stack (it boots Chrome + daemon itself via `sniffer-start`):

```bash
node scripts/smoke-test.mjs
```

## Ground rules

- **No network calls to third parties.** Everything stays on localhost (`:9222` Chrome, `:9223` proxy, local SQLite). Never add telemetry, updaters, or external fetches.
- **No credentials in code.** API keys, tokens, logins — never committed. Grep for `sk-`, `ghp_`, `password\s*[:=]` before every PR.
- **DB and Chrome profile are machine-local** (`CDP_SNIFFER_DB_DIR`, `~/.config/cdp-sniffer-chrome`). Never commit `*.db`, `*.db-wal`, profiles, or captured traffic.
- **Retention is a feature.** The pruner in `src/db.js` keeps the DB bounded; don't grow default limits without a reason.
- **Docs live with code.** Changing a tool? Update `README.md`, `AGENTS.md`, and `ProjectMemory/reference.md` in the same commit.

## Commit style

Short, imperative, English: `Add --url-re to query-ws`, `Fix observer reconnect storm`.
