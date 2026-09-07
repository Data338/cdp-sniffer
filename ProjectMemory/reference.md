# Reference

## Launcher (`sniffer-start`)

```bash
sniffer-start                          # launch Chrome (last-used profile) + daemon
sniffer-start --profile=<email>        # pick signed-in profile by email
sniffer-start --profile=ask            # force Chrome profile picker on every launch
sniffer-start --profile=list           # list available profiles and exit-0
sniffer-start --reset                  # wipe isolated profile dir ($HOME/.config/cdp-sniffer-chrome)
sniffer-start --no-kwin-place          # skip KWin window placement script
```

Profiles are resolved by `scripts/resolve-profile.cjs` via `~/.config/cdp-sniffer-chrome/Local State → profile.info_cache`. Emails matched case-insensitive. `ask` returns `"Guest Profile"` which Chrome interprets as "show the picker".

**Known profiles in this machine:**

| Dir | Email | Notes |
|---|---|---|
| `Default` | andreictg2@gmail.com | No extensions |
| `Profile 1` | andreictg338@gmail.com [Fahrenheit] | Has Browser MCP + 9 other extensions |

## CLI commands

```
sniffer query   [--domain X] [--method GET|POST] [--url pat] [--url-re regex] [--status N] [--since ms] [--after-mark L] [--before-mark L] [--offset N] [--last N] [--session id]
sniffer query-http  [--method GET] [--url pat] [--url-re regex] [--status N] [--since ms] [--after-mark L] [--before-mark L] [--offset N] [--last N]
sniffer get-http <request_id>              # full consolidated request + redirect chain
sniffer ui      [--ui-type click|input|dom-attr|dom-add|dom-remove] [--after-mark L] [--before-mark L] [--last N]
sniffer search  <term> [--domain X] [--fields params,result,method,url,response_body] [--regex] [--session id]
sniffer stats   [--session id]
sniffer marks   [--session id] [--last N]
sniffer mark    <label> [--tags a,b] [--session id]
sniffer watch   [--domain X] [--url pat] [--timeout ms] [--session id]
sniffer query-ws  [--url pat] [--request-id id] [--direction sent|received] [--opcode N] [--last N] [--offset N] [--session id]
sniffer query-sse [--url pat] [--request-id id] [--event-name name] [--last N] [--offset N] [--session id]
sniffer clear   [--session id]
sniffer sessions
sniffer status
```

### Exemplos

```bash
# HTTP consolidado — 1 row por request (melhor que raw cdp_events)
sniffer query-http --method POST --url login

# Flow isolado por marca
sniffer mark pre-login
# ... faz o fluxo no browser ...
sniffer query-http --after-mark pre-login

# Regex em URL
sniffer query-http --url-re '^https?://api\..*/v2/'

# Request completo + redirect chain
sniffer get-http 26731.105

# Clicks/inputs
sniffer ui --ui-type click --last 10

# Buscar token JWT em response_body
sniffer search "eyJhbGciOi" --fields response_body --regex

# WebSocket frames (chat/live/streaming)
sniffer query-ws --url ifelse --direction received

# SSE / EventSource (feeds, streams de LLM)
sniffer query-sse --url stream

# Resumo da sessão
sniffer stats

# Consultar sessão antiga
sniffer sessions                          # lista IDs
sniffer stats --session a1b2c3d4
```

## MCP server (src/mcp.mjs)

Stdio MCP server for harness integration. Launch: `node src/mcp.mjs` (or `sniffer-mcp`).

| Tool | Descrição |
|------|-----------|
| `sniffer_get_status` | Chrome/daemon/DB status + hint de ação |
| `sniffer_start_stack` | Lança a pilha completa (Chrome + daemon); reusa Chrome se já up; `reset:true` apaga perfil |
| `sniffer_query_events` | Query CDP events (domain, type, http_method, url, status, limit, offset, session, full) — paginada |
| `sniffer_search_events` | Full-text em params/result/method/url |
| `sniffer_get_request` | Lifecycle completo de um request_id (request, response, response_body) |
| `sniffer_query_websocket` | WebSocket frames (url, request_id, direction, opcode, payload) — paginada |
| `sniffer_query_sse` | SSE / EventSource messages (url, request_id, event_name, data) — paginada |
| `sniffer_get_stats` | Agregados da sessão |
| `sniffer_list_sessions` | Lista sessões |
| `sniffer_add_mark` | Insere marker |
| `sniffer_watch_events` | Poll até match (timeout cap 30s) |
| `sniffer_query_http` | HTTP consolidado — 1 row por request com headers, body, duration |
| `sniffer_get_http` | 1 request completo + redirect chain + CDP events correlacionados |
| `sniffer_query_ui` | Clicks/inputs/mutações DOM já parseados do `[cdp-ui]` |
| `sniffer_list_marks` | Lista marks da sessão (pra usar em `after_mark`/`before_mark`) |
| `sniffer_clear_events` | Limpa eventos — exige `confirm: true` |
| `sniffer_control_daemon` | start/stop/restart **só** do daemon (start exige Chrome já na :9222) |

Output default é sumarizado (campos-chave + `has_body`); `full: true` retorna params/result/response_body. `sniffer_query_events`/`sniffer_query_http`/`sniffer_query_ui`/`sniffer_query_websocket`/`sniffer_query_sse` retornam metadados de paginação (`total_count`, `has_more`, `next_offset`, `offset`). O server expõe `instructions` (workflow + glossário) enviado ao client.

`sniffer_start_stack` aceita `profile` — passa o email de um profile já logado no cdp-sniffer-chrome isolado (ex: `"andreictg338@gmail.com"`), ou `"ask"` pra forçar o picker. Detalhes em "Launcher" acima.

## Environment variables

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `CDP_CHROME_PORT` | `9222` | Porta do Chrome remote debugging |
| `CDP_PROXY_PORT` | `9223` | Porta do proxy CDP |
| `CDP_SNIFFER_DB_DIR` | `~/Documents/logs` | Diretório do SQLite |
| `CDP_SNIFFER_MAX_EVENTS` | `100000` | Máximo de eventos CDP no buffer circular |
| `CDP_SNIFFER_MAX_HTTP` | `20000` | Máximo de HTTP events no buffer circular |
| `CDP_SNIFFER_MAX_WS` | `50000` | Máximo de WebSocket frames no buffer circular |
| `CDP_SNIFFER_MAX_SSE` | `50000` | Máximo de SSE events no buffer circular |
| `SNIFFER_PROFILE` | — | Fallback de `--profile=` pra o `sniffer-start` (MCP `sniffer_start_stack` passa param `profile` como arg, mas a env funciona se o script for chamado de outros lugares) |

## DB Schema

### sessions
```
id               TEXT PRIMARY KEY
started_at       TEXT DEFAULT (datetime('now'))
ended_at         TEXT
ws_connections   INTEGER DEFAULT 0
```

### cdp_events
```
id             INTEGER PRIMARY KEY AUTOINCREMENT
session_id     TEXT NOT NULL
ws_id          TEXT
ts             INTEGER NOT NULL        -- Unix timestamp ms
type           TEXT NOT NULL           -- request | response | event | error | raw | unknown
direction      TEXT                    -- client→browser | browser→client
domain         TEXT                    -- Network | Console | Page | Runtime | DOM | Storage
method         TEXT                    -- Full CDP method name
http_method    TEXT                    -- GET | POST | PUT | DELETE (from Network enrichment)
url            TEXT                    -- HTTP URL (from Network enrichment)
status_code    INTEGER                 -- HTTP status (from Network enrichment)
request_id     TEXT                    -- CDP requestId for correlation
params         TEXT                    -- JSON string
result         TEXT                    -- JSON string
response_body  TEXT                    -- Decoded response body (from getResponseBody)
duration_ms    INTEGER
```

### http_events
```
id                INTEGER PRIMARY KEY AUTOINCREMENT
session_id        TEXT NOT NULL
ts                INTEGER NOT NULL
method            TEXT NOT NULL
url               TEXT NOT NULL
status_code       INTEGER
request_headers   TEXT
request_body      TEXT
response_headers  TEXT
response_body     TEXT
duration_ms       INTEGER
```

### marks
```
id          INTEGER PRIMARY KEY AUTOINCREMENT
session_id  TEXT NOT NULL
ts          INTEGER NOT NULL
label       TEXT NOT NULL
tags        TEXT                -- JSON array
```

### ws_frames
```
id          INTEGER PRIMARY KEY AUTOINCREMENT
session_id  TEXT NOT NULL
ws_id       TEXT
ts          INTEGER NOT NULL
request_id  TEXT                -- CDP requestId (correlates with cdp_events)
url         TEXT                -- WebSocket URL
direction   TEXT                -- sent | received
opcode      INTEGER             -- 1=text 2=binary 8=close 9=ping 10=pong
payload     TEXT                -- decoded (base64→utf8 for binary)
```

### sse_events
```
id          INTEGER PRIMARY KEY AUTOINCREMENT
session_id  TEXT NOT NULL
ws_id       TEXT
ts          INTEGER NOT NULL
request_id  TEXT                -- CDP requestId (correlates with cdp_events)
url         TEXT                -- EventSource URL
event_name  TEXT                -- SSE "event:" field
event_id    TEXT                -- SSE "id:" field
data        TEXT                -- SSE "data:" field
```

## Files

```
~/Documents/tools/cdp-sniffer/
├── AGENTS.md                  → Portal de documentação
├── package.json
├── index.js                   → Entry point (daemon + CLI)
├── sniffer-start              → Bash launcher (Chrome + sniffer)
├── src/
│   ├── proxy.js               → WebSocket proxy + observer + HTTP proxy
│   ├── db.js                  → SQLite schema, queries, buffer circular
│   ├── observer-script.js     → Script injetado para captura de UI
│   └── mcp.mjs                → MCP stdio server (harness integration)
├── scripts/
│   └── smoke-test.mjs         → WS + SSE capture smoke test (requer Chrome+daemon vivos)
└── ProjectMemory/
    ├── README.md
    ├── architecture.md
    ├── reference.md           ← este arquivo
    └── development.md

~/bin/sniffer                  → symlink → ~/Documents/tools/cdp-sniffer/index.js
~/.local/bin/sniffer           → symlink → ~/Documents/tools/cdp-sniffer/index.js
~/.local/bin/sniffer-start     → symlink → ~/Documents/tools/cdp-sniffer/sniffer-start
~/.local/bin/sniffer-mcp       → symlink → ~/Documents/tools/cdp-sniffer/src/mcp.mjs
~/Documents/logs/cdp-sniffer.db → SQLite database
```

## Ports

| Porta | Serviço |
|-------|---------|
| `9222` | Chrome DevTools Protocol |
| `9223` | CDP Sniffer proxy + observer |
