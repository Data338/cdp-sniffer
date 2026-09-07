# cdp-sniffer

Chrome DevTools Protocol sniffer for reverse engineering. Captures every CDP message (Network, Console, DOM, Runtime) + UI clicks/inputs/mutations into SQLite. Three surfaces: CLI (`sniffer`), daemon (`sniffer-start`), and MCP server (`src/mcp.mjs`, stdio) for harness integration (opencode, dsh). No REST API.

## Agent quick-reference (read this first)

**Before anything:** `sniffer_get_status` → if `chrome_up` or `daemon_up` is false, `sniffer_start_stack { profile: "andreictg338@gmail.com" }`.

**Most common flows (MCP):**

1. **"What requests did that page make?"** → `sniffer_add_mark({label:'pre-x'})` → prompt user to browse → `sniffer_query_http({after_mark:'pre-x'})`
2. **"Show me the POST body for login"** → `sniffer_query_http({method:'POST', url:'login'})` → copy `request_id` → `sniffer_get_http({request_id})`
3. **"What clicks happened?"** → `sniffer_query_ui({ui_type:'click'})`
4. **"Find the JWT token"** → `sniffer_search_events({query:'eyJ', fields:['response_body'], regex:true})`
5. **"Check XHR request payload"** → same as #2 then inspect `request_body`

**If a search returns 0 results:** try `fields:['response_body']` (bodies are excluded by default), or `regex:true` for patterns. If still 0, hit `sniffer_get_stats` — if `total_http_events: 0`, the thing you want wasn't captured (site uses WebSocket/SSE/HTTP3? try `sniffer_query_websocket`/`sniffer_query_sse`).

**Deciding between HTTP vs UI vs WS vs SSE:** HTTP = `query_http` (requests with headers/bodies). UI = `query_ui` (clicks/inputs). WS = `query_websocket` (live chat/feeds). SSE = `query_sse` (server-pushed streams).

**Browser automation (Browser MCP extension):** only in profile `andreictg338@gmail.com` — needs manual "Connect" click in toolbar per launch (unavoidable, last blocker of full automation).

## Docs

See [ProjectMemory/](./ProjectMemory/) for full reference:

| File | Covers |
|------|--------|
| [README.md](./ProjectMemory/README.md) | What it is, why, quickstart |
| [architecture.md](./ProjectMemory/architecture.md) | How it works: proxy, observer, relay, DB, CLI |
| [reference.md](./ProjectMemory/reference.md) | CLI commands, env vars, DB schema |
| [development.md](./ProjectMemory/development.md) | Codebase map, how to extend |

## KWin desktop pinning

When launched via `sniffer-start`, Chrome gets `--class=cdp-sniffer-chrome` AND a one-shot KWin script (`scripts/kwin-place-sniffer.js`) is pre-loaded via D-Bus. The script waits for the sniffer window (by `resourceClass == cdp-sniffer-chrome`, matching the Wayland `app_id` that Chromium sets from `--class`) and moves it to the desktop where the opencode terminal (ghostty, caption starts with `OC |`) lives. Works on KWin 6.7 + Chrome 149 (Wayland native). Use `--no-kwin-place` to skip placement.

## Quick start

```bash
sniffer-start                          # Launch Chrome + sniffer daemon
sniffer-start --profile=andreictg338@gmail.com   # Pick logged-in profile (Browser MCP lives here)
sniffer-start --profile=ask            # Force the Chrome profile picker
sniffer-start --reset                  # Wipe profile (removes extensions + login)
# Browse the site, do your flow
sniffer query-http --method POST --url login   # Consolidated HTTP (1 row/request)
sniffer query --domain Network --last 10       # Raw CDP network events
sniffer get-http <request_id>                  # Full request + redirect chain
sniffer ui --ui-type click                     # User clicks/inputs (parsed [cdp-ui])
sniffer query-ws --url chat                    # WebSocket frames
sniffer query-sse --url stream                 # SSE / EventSource messages
sniffer stats
```

## Profile selection

The isolated user-data-dir (`~/.config/cdp-sniffer-chrome`) holds real Chrome profiles. Pick one with `--profile=<email>`; resolve via `scripts/resolve-profile.cjs` (reads `Local State → profile.info_cache`):

| Profile dir | Account | Extensions |
|---|---|---|
| `Default` | andreictg2@gmail.com | none |
| `Profile 1` | andreictg338@gmail.com [Fahrenheit] | Browser MCP + 9 others |

Browser MCP only exists in **Profile 1** — use `--profile=andreictg338@gmail.com` when you need browser automation. `--profile=ask` shows the Chrome picker on every launch.

CLI installed as `sniffer-start` via `~/bin`; profile flag also exposed in MCP `sniffer_start_stack` (`profile` param).

## MCP server

`src/mcp.mjs` exposes the sniffer as MCP stdio tools (17 tools: `sniffer_get_status`, `sniffer_start_stack`, `sniffer_query_events`, `sniffer_query_http`, `sniffer_get_http`, `sniffer_query_ui`, `sniffer_list_marks`, `sniffer_search_events`, `sniffer_get_request`, `sniffer_query_websocket`, `sniffer_query_sse`, `sniffer_get_stats`, `sniffer_list_sessions`, `sniffer_add_mark`, `sniffer_watch_events`, `sniffer_clear_events`, `sniffer_control_daemon`) with server `instructions` (workflow + glossary) and pagination metadata. Registered in:

- **opencode**: `~/.config/opencode/opencode.json` → `mcp."cdp-sniffer"`
- **dsh/omdsh**: `~/.dsh/profiles/shared/scripts/generate-cordis-patch.py` → `MCP_SERVERS` (regenerates `cordis.patch.yml`; probe with `scripts/probe-mcp-tools.mjs`)

Any other harness: point its MCP stdio config at `node ~/Documents/tools/cdp-sniffer/src/mcp.mjs` (or `sniffer-mcp` on PATH). Read tools work against the live DB (WAL) while the daemon captures. `sniffer_start_stack` launches the full stack (Chrome + daemon); `sniffer_control_daemon start` only starts the daemon (requires Chrome already on :9222).

## HTTP consolidation

Since v1.2, the daemon aggregates raw CDP `Network.*` events into one consolidated `http_events` row per request (method/url/headers/body/duration, `request_id` links back to the raw `cdp_events`). Prefer `sniffer query-http` / `sniffer_get_http` for API inspection; use `sniffer query`/`sniffer_query_events` only for raw CDP internals.
