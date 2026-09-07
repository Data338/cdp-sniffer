# cdp-sniffer

See exactly what a website sends and receives. **cdp-sniffer** captures every Chrome DevTools Protocol message — Network, Console, DOM, Runtime — plus UI clicks/inputs/mutations into a local SQLite database, with a CLI, a one-command launcher, and an MCP server so AI harnesses can query traffic directly.

Built for **reverse-engineering web API flows**: log in through the real browser, then ask what requests the page made, what the POST body was, where the JWT came from.

```
You browse normally in Chrome
        │
        ▼
┌──────────────┐   CDP over WebSocket    ┌───────────────┐
│    Chrome    │ ───────────────────────▶ │  cdp-sniffer  │
│ :remote-debug │   (observer auto-links   │   :proxy      │
│    :9222     │    every page target)     │    :9223      │
└──────────────┘                           └───────┬───────┘
                                                   │ writes
                                                   ▼
                                            ┌────────────┐
                                            │   SQLite   │◀── sniffer CLI
                                            │  (WAL)     │◀── MCP tools (17)
                                            └────────────┘
```

No REST API. No cloud. Everything stays on your machine.

## Features

- **Zero-config capture** — one command launches Chrome (remote-debugging) + daemon; every page target is hooked automatically, no proxy settings, no certs
- **Consolidated HTTP view** — raw `Network.*` events are aggregated into one row per request (method, URL, headers, bodies, timing, redirect chain)
- **WebSocket & SSE tables** — full-duplex WS frames and EventSource messages stored separately, queryable
- **UI events** — clicks, inputs and DOM mutations captured from the page and parsed into structured data
- **Marks** — named timestamps (`before-login`) to isolate exactly the requests one action caused
- **17 MCP tools** — `sniffer_query_http`, `sniffer_get_http`, `sniffer_query_ui`, `sniffer_query_websocket`, `sniffer_query_sse`, `sniffer_search_events`, `sniffer_start_stack`, … for opencode / Claude / any MCP harness
- **HTTP/2-friendly** — Chrome launches with `--disable-http3/--disable-quic` so everything goes through observable CDP

## Requirements

- **Linux** (KWin window placement is optional; core works anywhere Chrome runs)
- **Node.js ≥ 18**
- **Google Chrome** (`google-chrome` on PATH)

## Install

```bash
git clone https://github.com/Data338/cdp-sniffer.git
cd cdp-sniffer
npm install
npm link   # provides sniffer, sniffer-start, sniffer-mcp on PATH
```

## Quick start

```bash
sniffer-start                          # 1. launch Chrome + daemon
# ... browse the site, do your flow ...
sniffer query-http --method POST --url login   # 2. consolidated HTTP (1 row/request)
sniffer get-http <request_id>                  # 3. full request + redirect chain
sniffer ui --ui-type click                     # 4. clicks/inputs as structured data
sniffer stats                                  # 5. session overview
```

Pick a logged-in Chrome profile (so the MCP browser extension travels with it):

```bash
sniffer-start --profile=you@gmail.com   # resolve via Local State
sniffer-start --profile=ask             # force the profile picker
sniffer-start --reset                   # wipe profile (removes extensions + login)
```

### The mark-correlated workflow

```bash
sniffer mark before-login
# ... log in in the browser ...
sniffer query-http --after-mark before-login --last 20
```

Only the requests that login caused. Deterministic — no timestamp guessing.

## CLI reference

| Command | What |
|---|---|
| `sniffer query [--domain X] [--method GET] [--url pat] [--status N] [--after-mark L] [--last N]` | Raw CDP events |
| `sniffer query-http [--method GET] [--url pat] [--status N] [--after-mark L] [--last N]` | Consolidated HTTP, 1 row/request |
| `sniffer get-http <request_id>` | Full request + redirects + linked CDP events |
| `sniffer search <term> [--fields params,response_body] [--regex]` | Free-text / regex search |
| `sniffer ui [--ui-type click\|input] [--after-mark L]` | Clicks, inputs, DOM mutations |
| `sniffer query-ws [--url pat] [--direction sent\|received]` | WebSocket frames |
| `sniffer query-sse [--url pat] [--event-name n]` | SSE / EventSource messages |
| `sniffer mark <label> [--tags a,b]` / `sniffer marks` | Timestamp markers |
| `sniffer watch [--domain X] [--url pat] [--timeout ms]` | Wait for matching events |
| `sniffer stats` / `sniffer sessions` / `sniffer status` | Overview |
| `sniffer clear` | **Permanently** delete captured events |

URL filters also accept full regex with `--url-re`, or `re:` prefix in MCP.

## MCP server (AI harnesses)

```bash
sniffer-mcp   # stdio transport
```

Generic MCP config:

```json
{
  "mcpServers": {
    "cdp-sniffer": {
      "command": "sniffer-mcp"
    }
  }
}
```

Typical agent flow: `sniffer_get_status` → `sniffer_add_mark` → user browses → `sniffer_query_http({ after_mark })` → `sniffer_get_http({ request_id })`. Read tools query the live DB (WAL) while the daemon captures; `sniffer_start_stack` boots the whole stack, `sniffer_control_daemon` manages only the daemon.

## Configuration

| Env var | Default | What |
|---|---|---|
| `CDP_CHROME_PORT` | `9222` | Chrome remote-debugging port |
| `CDP_PROXY_PORT` | `9223` | Sniffer relay/proxy port |
| `CDP_SNIFFER_DB_DIR` | `~/Documents/logs` | SQLite directory (`cdp-sniffer.db`) |
| `CDP_SNIFFER_MAX_EVENTS` | `100000` | CDP event retention (oldest pruned) |
| `CDP_SNIFFER_MAX_HTTP` | `20000` | HTTP row retention |
| `CDP_SNIFFER_MAX_WS` / `CDP_SNIFFER_MAX_SSE` | `50000` | WS/SSE retention |
| `SNIFFER_PROFILE` | — | Default Chrome profile (email or `ask`) |

## Project layout

```
index.js            # daemon + CLI entry
sniffer-start       # launcher: Chrome + daemon (+ KWin placement)
src/
  proxy.js          # CDP relay + observer (auto-hooks page targets)
  db.js             # SQLite schema, retention, queries
  mcp.mjs           # MCP server (17 tools, stdio)
  observer-script.js# in-page UI observer (clicks/inputs/mutations)
scripts/
  smoke-test.mjs    # capture smoke test (needs live Chrome+daemon)
  resolve-profile.cjs # email → Chrome profile dir via Local State
  kwin-place-sniffer.js # KWin: pin sniffer window to terminal desktop
ProjectMemory/      # architecture, CLI/env/DB reference, dev notes
```

Deep docs live in [`ProjectMemory/`](ProjectMemory/) and [`AGENTS.md`](AGENTS.md).

## Privacy

Capture is powerful: the DB records request/response bodies — cookies, tokens, form inputs — for every page open in the debugging-profile Chrome. The DB and the Chrome profile live **outside this repo** (see env vars) and are never committed (see `.gitignore`). `sniffer clear` wipes captured events; deleting `cdp-sniffer.db` resets everything.

## License

MIT — see [LICENSE](LICENSE).
