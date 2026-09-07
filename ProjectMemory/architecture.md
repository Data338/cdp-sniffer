# Architecture

## Componentes

```
sniffer (binário único em ~/bin/sniffer)
├── modo DAEMON  →  proxy.js  +  db.js
├── modo CLI     →  db.js (leitura)
└── modo MCP     →  mcp.mjs (stdio, spawado pelo harness)
```

O mesmo `index.js` opera em dois modos, detectados pelo `process.argv`:

| Modo | Gatilho | Processo |
|------|---------|----------|
| Daemon | `sniffer` sem argumentos CLI | Processo de longa duração, sobe proxy + observer |
| CLI | `sniffer query/search/stats/...` | Abre DB, consulta, imprime JSON, sai |
| MCP | Harness spawna `src/mcp.mjs` | Servidor stdio; lê o mesmo DB (WAL) e controla o daemon |

## Daemon: 3 subsistemas

```
┌─────────────────────────────────────────────────┐
│  index.js                                        │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ OBSERVER │  │  RELAY   │  │  HTTP PROXY   │  │
│  │ (ativo)  │  │(passivo) │  │  (passivo)    │  │
│  │          │  │          │  │               │  │
│  │ Conecta  │  │ Aceita   │  │ Proxy HTTP    │  │
│  │ direto   │  │ clientes │  │ /json/*       │  │
│  │ no Chrome│  │ externos │  │ requests      │  │
│  │ via WS   │  │ via WS   │  │               │  │
│  └────┬─────┘  └────┬─────┘  └───────┬───────┘  │
│       │             │               │           │
│       └──────────┬──┘───────────────┘           │
│                  ▼                               │
│            ┌──────────┐                          │
│            │  emit()  │  parse + enrich + store  │
│            └────┬─────┘                          │
│                 ▼                                │
│            ┌──────────┐                          │
│            │  SQLite  │  WAL mode, buffer circ.  │
│            └──────────┘                          │
└─────────────────────────────────────────────────┘
```

### Observer (proxy.js — `startObserver`)

Conecta-se **ativamente** ao Chrome, sem precisar de cliente externo:

1. GET `/json/version` → pega `webSocketDebuggerUrl`
2. WebSocket conecta no browser endpoint
3. Envia `Target.setDiscoverTargets` + `Target.getTargets`
4. Para cada página (existente ou nova via `Target.targetCreated`):
   - Abre WS em `/devtools/page/{targetId}`
   - Habilita 6 domínios: Network, Console, Page, Runtime, DOM, Storage
   - Injeta script de UI observer via `Page.addScriptToEvaluateOnNewDocument`
   - Para cada `Network.responseReceived` XHR/Fetch: busca corpo com `Network.getResponseBody`
5. Reconexão com backoff exponencial (1s → 60s) se o WS do browser cair

### Relay (proxy.js — `wss.on('connection')`)

Servidor WebSocket na porta `:9223`. Clientes CDP externos (Puppeteer, Playwright) conectam aqui. Cada mensagem é:

1. Parseada e armazenada no DB
2. Encaminhada bidirecionalmente entre cliente ↔ Chrome

### HTTP Proxy (proxy.js — `http.createServer`)

Proxy HTTP na porta `:9223` para endpoints `/json/*`. Reescreve URLs de WebSocket nas respostas pra apontar pra `:9223`.

### Enriquecimento (proxy.js — `enrich`)

Antes de armazenar, cada evento CDP passa por `enrich()` que extrai campos estruturados:

| Evento | Campos extraídos |
|--------|-----------------|
| `Network.requestWillBeSent` | `http_method`, `url`, `request_id` |
| `Network.responseReceived` | `url`, `status_code`, `request_id` |
| `Network.responseReceivedExtraInfo` | `request_id` (headers CORS/cookies em `params`) |
| `Network.webSocketFrameSent/Received` | `request_id`, `opcode`, `payload`, `direction` |
| `Network.eventSourceMessageReceived` | `request_id` |

Além do `enrich`, o handler de message do `connectPage` mantém um `urlMap` (requestId → url, alimentado por `requestWillBeSent`/`webSocketCreated`) e roteia:
- `webSocketFrameSent/Received` → `onWsFrame` (payload base64 decodificado quando binário) → `ws_frames`
- `eventSourceMessageReceived` → `onSseEvent` → `sse_events`

O `Network.enable` é enviado com `maxTotalBufferSize`/`maxResourceBufferSize` de 100MB pra não truncar frames grandes.

### Script de UI (observer-script.js)

Injetado via CDP em cada página. Observa:

- **Clicks**: tag, id, classes, texto visível, path CSS
- **Inputs**: tag, tipo, valor (máscara em password, truncado em 200 chars)
- **DOM mutations**: elementos adicionados/removidos com significado semântico
- **Atributos**: `class`, `style`, `disabled`, `hidden`, `aria-expanded`, `aria-hidden`

Emite batches via `console.log('[cdp-ui]', [...])` a cada 250ms. O domínio Console (já habilitado) captura automaticamente.

Filtra ruído: ignora `<script>`, `<style>`, `<link>`, `<meta>`, `<svg>`, `<path>`, `<br>`, `<hr>`, e elementos sem semântica (sem id, sem classe, sem texto).

## SQLite (db.js)

### Schema

```sql
sessions       (id, started_at, ended_at, ws_connections)
cdp_events     (id, session_id, ts, type, direction, domain, method,
                http_method, url, status_code, request_id,
                params, result, response_body, duration_ms)
http_events    (id, session_id, ts, method, url, status_code,
                request_headers, request_body, response_headers, response_body)
marks          (id, session_id, ts, label, tags)
ws_frames      (id, session_id, ws_id, ts, request_id, url, direction, opcode, payload)
sse_events     (id, session_id, ws_id, ts, request_id, url, event_name, event_id, data)
```

### Índices

`(session_id, ts)`, `(domain, type)`, `(url)`, `(http_method)`, `(status_code)`, `(ts)`, `(request_id)` em `cdp_events`; `(session_id, ts)`, `(request_id)`, `(url)` em `ws_frames` e `sse_events`.

### Buffer circular

- `cdp_events`: 100k linhas máx, limpeza a cada 2000 inserts acima do limite
- `http_events`: 20k linhas máx, limpeza a cada 500 inserts
- `ws_frames`: 50k linhas máx, limpeza a cada 1000 inserts
- `sse_events`: 50k linhas máx, limpeza a cada 1000 inserts
- Configurável via `CDP_SNIFFER_MAX_EVENTS` / `CDP_SNIFFER_MAX_HTTP` / `CDP_SNIFFER_MAX_WS` / `CDP_SNIFFER_MAX_SSE`

### WAL mode

Write-Ahead Log permite leituras concorrentes. O CLI lê o DB enquanto o daemon escreve, sem locks.

## CLI (index.js — `runCli`)

Comandos disponíveis, todos retornam JSON:

| Comando | Descrição |
|---------|-----------|
| `sniffer query` | Lista eventos CDP com filtros |
| `sniffer search` | Full-text em params/result/method/url |
| `sniffer stats` | Agregados: domínios, top URLs, status codes |
| `sniffer mark` | Insere timestamp marker |
| `sniffer watch` | Polling até encontrar eventos (automação) |
| `sniffer sessions` | Lista sessões anteriores |
| `sniffer clear` | Limpa eventos de uma sessão ou tudo |
| `sniffer status` | Info do DB atual |

Todos aceitam `--session <id>` para consultar sessões antigas.
