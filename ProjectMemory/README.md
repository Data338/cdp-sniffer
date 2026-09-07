# cdp-sniffer — Visão geral

Sniffer de Chrome DevTools Protocol para engenharia reversa. Captura todo o tráfego CDP (Network, Console, DOM, Runtime) + eventos de UI (cliques, inputs, mutações do DOM) em SQLite.

## Por que existe

Ferramentas de automação (Puppeteer, Playwright) falam CDP com o Chrome. Esse sniffer intercepta **todas** as mensagens desse protocolo e as armazena de forma queryable. Serve pra:

- Entender o fluxo de API de um site (login, cotação, busca de CEP)
- Ver headers, tokens JWT, corpos de requisição e resposta
- Rastrear interações de UI (cliques, inputs, modais, validações)
- Ter uma base de dados estruturada pra construir automações depois

## O que ele captura

| Domínio | O que pega |
|---------|-----------|
| **Network** | Toda requisição HTTP: URL, método, headers, status code, corpo da resposta (XHR/Fetch) |
| **WebSocket** | Frames (sent/received) com opcode + payload decodificado → tabela `ws_frames` |
| **SSE** | Mensagens EventSource (event_name, id, data) → tabela `sse_events` |
| **Console** | `console.log`, `console.error`, logs do observer de UI |
| **Runtime** | Execution contexts, chamadas de console API |
| **Page** | Ciclo de vida: load, DOMContentLoaded, navegação de frame |
| **DOM** | Atualizações de documento |
| **Storage** | Mudanças em localStorage, sessionStorage |
| **UI (script injetado)** | Clicks, inputs, mudanças de atributo (`class`, `style`, `disabled`, `hidden`, `aria-*`), elementos adicionados/removidos do DOM |

## O que NÃO captura

- Performance timeline (domínio Performance não habilitado)
- Conteúdo de iframes cross-origin
- Áudio/vídeo/WebRTC
- HTTP/3 (QUIC) — mitigado: `sniffer-start` sobe o Chrome com `--disable-http3`/`--disable-quic`

## Fluxo de uso

```
Terminal 1:  sniffer-start
             → Chrome sobe com --remote-debugging-port=9222
             → Sniffer daemon sobe na porta :9223
             → Observer ativo conecta no Chrome e começa a capturar

Navegador:   Usuário faz o fluxo (login, cotação, navegação)
             → Cada evento CDP é parseado, enriquecido, armazenado em SQLite
             → Corpos de resposta XHR/Fetch são buscados via getResponseBody

Terminal 2:  sniffer query --domain Network --url login
             → Abre o mesmo DB SQLite (WAL mode = leitura concorrente)
             → Retorna JSON formatado
```

## Requisitos

- Node.js 18+
- Google Chrome / Chromium
- Linux (macOS/WSL devem funcionar, não testado)
