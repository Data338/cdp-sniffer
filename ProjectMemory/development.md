# Development guide

## Codebase map

```
index.js (212 linhas)
├── Modo CLI: runCli() → parseArgs() → db.queryCdp/searchCdp/getStats/...
└── Modo Daemon: start() → checkCDP() → createProxy() → cleanup()
                              │
                              ▼
src/proxy.js (~390 linhas)
├── createProxy(listenPort, targetPort, callbacks)
│   ├── parseMessage() — classifica mensagem CDP (request/response/event/error)
│   ├── enrich()       — extrai http_method, url, status_code, request_id, opcode, payload
│   ├── emit()         — chama onCdpEvent (armazenamento)
│   ├── startObserver()
│   │   ├── connectBrowser() — conecta no browser WS
│   │   │   └── on message → Target.targetCreated → connectPage()
│   │   └── connectPage()   — conecta no page WS
│   │       ├── AUTO_DOMAINS.forEach → domain.enable (Network com buffer 100MB)
│   │       ├── Page.addScriptToEvaluateOnNewDocument (script UI)
│   │       ├── urlMap        — requestId → url (WS/SSE correlation)
│   │       ├── on message → Network.responseReceived → getResponseBody
│   │       ├── on message → webSocketFrame* → onWsFrame (payload decode)
│   │       ├── on message → eventSourceMessageReceived → onSseEvent
│   │       └── on message → response com body → onResponseBody()
│   ├── HTTP proxy   — http.createServer, reescreve URLs de WS
│   └── Relay        — WebSocketServer, bidirecional cliente↔Chrome
│
src/db.js (~540 linhas)
├── open()          — cria/abre SQLite, schema (cdp_events, http_events, marks, ws_frames, sse_events), índices, WAL mode
├── close()         — fecha conexão
├── startSession()  — INSERT/UPDATE em sessions
├── endSession()    — UPDATE ended_at
├── insertCdpEvent()— INSERT em cdp_events, buffer circular
├── insertHttpEvent()— INSERT em http_events
├── insertWsFrame() — INSERT em ws_frames, buffer circular
├── insertSseEvent()— INSERT em sse_events, buffer circular
├── updateCdpBody() — UPDATE response_body por request_id
├── insertMark()    — INSERT em marks
├── queryCdp()      — SELECT com filtros dinâmicos
├── queryHttp()     — SELECT em http_events
├── queryWsFrames() — SELECT paginado em ws_frames (url/request_id/direction/opcode)
├── querySseEvents()— SELECT paginado em sse_events (url/request_id/event_name)
├── getByRequestId()— lifecycle por request_id
├── searchCdp()     — LIKE em params/result/method/url
├── getStats()      — COUNT, GROUP BY (domínios, URLs, status)
├── clearAll()      — DELETE por session_id (todas as tabelas)
├── safeTruncate()  — trunca JSON sem quebrar estrutura
└── safeJson()      — JSON.parse com fallback

src/observer-script.js (160 linhas)
├── MutationObserver  — childList + attributes no documentElement
├── click listener    — captura elementos com semântica
├── change listener   — captura inputs/selects
├── enqueue/flush     — batch a cada 250ms, max 60 eventos
└── console.log('[cdp-ui]', JSON.stringify(batch))

src/mcp.mjs (~430 linhas) — MCP stdio server (@modelcontextprotocol/sdk + zod)
├── db.open() direto (WAL = lê enquanto daemon escreve)
├── summarize()     — output compacto default; full:true retorna tudo
├── 13 tools        — sniffer_{get_status,start_stack,query_events,search_events,get_request,query_websocket,query_sse,get_stats,list_sessions,add_mark,watch_events,clear_events,control_daemon}
├── instructions    — workflow + glossário enviado ao client (McpServer 2º arg)
├── paginação       — query_* retornam total_count/has_more/next_offset
├── startDaemon()   — helper de spawn do daemon (detached, stdio → /tmp/sniffer-out.log)
├── harnessEnv()    — PATH enriquecido ($HOME/.local/bin:$HOME/bin) p/ spawn do sniffer-start
├── runScript()     — spawna sniffer-start (subprocess) com timeout; tailFile() p/ log
├── guards          — sniffer_clear_events exige confirm:true; control_daemon start exige Chrome na :9222
└── sniffer_start_stack — full stack: reusa Chrome se up; senão roda sniffer-start; reset:true → --reset

sniffer-start (49 linhas)
├── Kill processo anterior na porta :9223
├── Sobe Chrome com --remote-debugging-port=9222
├── Aguarda /json/version responder
└── Sobe sniffer com nohup em background
```

## Como adicionar um novo domínio CDP

1. Adicionar string em `AUTO_DOMAINS` no `proxy.js:7`
2. Se o domínio tiver eventos que precisam de enriquecimento, adicionar em `enrich()`
3. Exemplo: para capturar `Performance`:
   ```js
   const AUTO_DOMAINS = ['Network', 'Console', 'Page', 'Runtime', 'DOM', 'Storage', 'Performance'];
   ```

## Como adicionar uma tool MCP

1. `server.registerTool('sniffer_<verbo>_<recurso>', { description, inputSchema (zod), annotations }, handler)` em `src/mcp.mjs` — description com 3-4 frases (o quê/quando/quando NÃO/caveats)
2. Se precisar de query nova, adicionar função em `src/db.js` e exportar
3. Validar com `node ~/.dsh/profiles/shared/scripts/probe-mcp-tools.mjs`
4. Harnesses recarregam no próximo start (stdio = processo por sessão de harness)

## Como adicionar um novo comando CLI

1. Adicionar o nome do comando no array `CLI` em `index.js:11`
2. Adicionar `case 'comando':` no `switch` em `runCli()`
3. Adicionar na função `printHelp()` e no `parseArgs()` se precisar de flags novas

## Como modificar o script de UI

Editar `src/observer-script.js`. O script é injetado via `Page.addScriptToEvaluateOnNewDocument`. Não precisa reiniciar o sniffer — o script é lido do disco a cada `connectPage()`.

## Dependências

```
better-sqlite3  — SQLite binding síncrono, rápido, sem dependências nativas complexas
ws              — WebSocket client + server, implementação pura JS
```

Nada mais. Zero frameworks.

## Debugging

```bash
# Ver logs do daemon
cat /tmp/sniffer-out.log

# Ver se o observer tá vivo
sniffer status                           # ws_connections > 0 = observer conectado

# Ver eventos mais recentes
sniffer query --last 5

# Testar script de UI no console do Chrome
# (abrir DevTools na página, colar conteúdo de observer-script.js)
```

## Testes manuais

1. `sniffer-start`
2. Navegar, fazer login, interagir
3. `sniffer stats` → verificar `total_cdp_events > 0`
4. `sniffer query --domain Network --last 10` → verificar URLs
5. `sniffer query --domain Console` → verificar eventos UI (`[cdp-ui]`)
6. `sniffer search "token"` → verificar JWT
7. `sniffer clear` → limpar DB
