const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');

const AUTO_DOMAINS = ['Network', 'Console', 'Page', 'Runtime', 'DOM', 'Storage'];

var OBSERVER_SCRIPT = '';
try {
  OBSERVER_SCRIPT = fs.readFileSync(path.join(__dirname, 'observer-script.js'), 'utf8');
} catch (e) { console.error('[proxy] Failed to load observer-script.js:', e.message); }

function createProxy(listenPort, targetPort, { onCdpEvent, onHttpEvent, onResponseBody, onWsFrame, onSseEvent, onWsConnect, onWsClose, sessionId: sid }) {
  const sessionId = sid || crypto.randomUUID().slice(0, 8);
  const observerPages = new Set();
  let observerAlive = false;
  let reconnectDelay = 1000;
  let reconnectTimer = null;

  function parseMessage(msg) {
    const ts = Date.now();
    try {
      const parsed = typeof msg === 'string' ? JSON.parse(msg) : msg;
      if (parsed.id !== undefined && parsed.method) {
        return { ts, type: 'request', id: parsed.id, method: parsed.method, domain: parsed.method.split('.')[0], params: parsed.params };
      } else if (parsed.id !== undefined && parsed.result !== undefined) {
        return { ts, type: 'response', id: parsed.id, result: parsed.result };
      } else if (parsed.id !== undefined && parsed.error) {
        return { ts, type: 'error', id: parsed.id, error: parsed.error };
      } else if (parsed.method) {
        return { ts, type: 'event', method: parsed.method, domain: parsed.method.split('.')[0], params: parsed.params };
      }
      return { ts, type: 'unknown', raw: parsed };
    } catch {
      return { ts, type: 'raw', payload: String(msg).slice(0, 200) };
    }
  }

  function enrich(entry) {
    if (!entry || entry.domain !== 'Network') return entry;
    if (entry.type === 'event' && entry.method === 'Network.requestWillBeSent') {
      entry.http_method = entry.params && entry.params.request && entry.params.request.method;
      entry.url = entry.params && entry.params.request && entry.params.request.url;
      entry.request_id = entry.params && entry.params.requestId;
    }
    if (entry.type === 'event' && entry.method === 'Network.responseReceived') {
      entry.url = entry.params && entry.params.response && entry.params.response.url;
      entry.status_code = entry.params && entry.params.response && entry.params.response.status;
      entry.request_id = entry.params && entry.params.requestId;
    }
    if (entry.type === 'event' && entry.method === 'Network.responseReceivedExtraInfo') {
      entry.request_id = entry.params && entry.params.requestId;
    }
    if (entry.type === 'event' && entry.method === 'Network.webSocketFrameSent') {
      entry.request_id = entry.params && entry.params.requestId;
      entry.opcode = entry.params && entry.params.response && entry.params.response.opcode;
      entry.payload = entry.params && entry.params.response && entry.params.response.payloadData;
      entry.direction = 'client→browser';
    }
    if (entry.type === 'event' && entry.method === 'Network.webSocketFrameReceived') {
      entry.request_id = entry.params && entry.params.requestId;
      entry.opcode = entry.params && entry.params.response && entry.params.response.opcode;
      entry.payload = entry.params && entry.params.response && entry.params.response.payloadData;
      entry.direction = 'browser→client';
    }
    if (entry.type === 'event' && entry.method === 'Network.eventSourceMessageReceived') {
      entry.request_id = entry.params && entry.params.requestId;
    }
    return entry;
  }

  function emit(entry, wsId) {
    entry.session_id = sessionId;
    if (wsId) entry.wsId = wsId;
    entry = enrich(entry);
    if (onCdpEvent) onCdpEvent(entry);
  }

  // ============================================================
  // OBSERVER — auto-connect to Chrome, capture ALL page traffic
  // ============================================================

  function startObserver() {
    if (reconnectTimer) clearTimeout(reconnectTimer);

    http.get('http://127.0.0.1:' + targetPort + '/json/version', function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        try {
          var wsUrl = JSON.parse(body).webSocketDebuggerUrl;
          reconnectDelay = 1000;
          observerPages.clear();
          connectBrowser(wsUrl);
        } catch (e) {
          console.error('[observer] Bad JSON from /json/version, retrying...');
          reconnectTimer = setTimeout(startObserver, 5000);
        }
      });
    }).on('error', function () {
      reconnectTimer = setTimeout(startObserver, 5000);
    });
  }

  function connectBrowser(wsUrl) {
    var ws = new WebSocket(wsUrl);
    var wsId = 'observer';

    ws.on('open', function () {
      observerAlive = true;
      console.log('\x1b[1m\x1b[92mOBSERVER\x1b[0m   browser connected, discovering targets...');
      if (onWsConnect) onWsConnect(wsId);

      ws.send(JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } }));
      ws.send(JSON.stringify({ id: 2, method: 'Target.getTargets' }));
    });

    ws.on('message', function (data) {
      var txt = data.toString();
      try {
        var msg = JSON.parse(txt);

        // Capture browser-level messages
        var entry = parseMessage(txt);
        entry.direction = 'browser→client';
        emit(entry, wsId);

        // New page target appeared
        if (msg.method === 'Target.targetCreated') {
          var info = msg.params && msg.params.targetInfo;
          if (info && info.type === 'page') {
            setTimeout(function () { connectPage(info.targetId); }, 300);
          }
        }

        // Existing page targets
        if (msg.id === 2 && msg.result && msg.result.targetInfos) {
          msg.result.targetInfos.forEach(function (info) {
            if (info.type === 'page') {
              setTimeout(function () { connectPage(info.targetId); }, 300);
            }
          });
        }
      } catch (e) { console.error('[observer] msg parse error:', e.message); }
    });

    ws.on('close', function () {
      observerAlive = false;
      var delay = Math.min(reconnectDelay, 30000);
      console.error('[observer] Browser WS closed, reconnecting in ' + (delay / 1000) + 's...');
      if (onWsClose) onWsClose(wsId);
      reconnectTimer = setTimeout(function () {
        reconnectDelay = Math.min(reconnectDelay * 2, 60000);
        startObserver();
      }, delay);
    });

    ws.on('error', function (err) {
      console.error('[observer] browser WS error: ' + (err && err.message || 'unknown'));
    });
  }

  function connectPage(targetId) {
    if (observerPages.has(targetId)) return;
    observerPages.add(targetId);
    var wsId = 'obs-' + targetId.slice(0, 6);
    var bodyMap = {};
    var bodySeq = 0;
    var urlMap = {};

    // Map requestId → objeto HTTP parcial, preenchido incrementalmente pelos
    // eventos requestWillBeSent / responseReceived / responseReceivedExtraInfo /
    // loadingFinished. No loadingFinished (ou redirect em requestWillBeSent)
    // o objeto é consolidado e emitido via onHttpEvent (1 row por request).
    var reqMap = {};

    function finalizeHttp(requestId, override) {
      var h = reqMap[requestId];
      if (!h || !h.method || !h.url) return;
      var ev = {
        session_id: sessionId,
        request_id: requestId,
        ts: h.ts,
        method: h.method,
        url: h.url,
        status_code: h.status_code || null,
        request_headers: h.request_headers || null,
        request_body: h.request_body || null,
        response_headers: h.response_headers || null,
        response_body: h.response_body || null,
        duration_ms: h.ts_finished ? (h.ts_finished - h.ts) : null,
      };
      if (override) for (var k in override) ev[k] = override[k];
      if (onHttpEvent) onHttpEvent(ev);
      delete reqMap[requestId];
    }

    // Cap de segurança: se a página seguir abortando requests sem loadingFinished,
    // limpa os mais antigos para não vazar memória em sessões longas.
    function pruneReqMap() {
      var keys = Object.keys(reqMap);
      if (keys.length <= 500) return;
      keys.sort(function (a, b) { return reqMap[a].ts - reqMap[b].ts; });
      for (var i = 0; i < keys.length - 500; i++) finalizeHttp(keys[i]);
    }

    var ws = new WebSocket('ws://127.0.0.1:' + targetPort + '/devtools/page/' + targetId);

    ws.on('open', function () {
      AUTO_DOMAINS.forEach(function (d, i) {
        setTimeout(function () {
          var params = d === 'Network'
            ? { maxTotalBufferSize: 100 * 1024 * 1024, maxResourceBufferSize: 100 * 1024 * 1024 }
            : {};
          var cmd = { id: 97000 + i, method: d + '.enable', params: params };
          ws.send(JSON.stringify(cmd));
          var entry = parseMessage(JSON.stringify(cmd));
          entry.direction = 'client→browser';
          emit(entry, wsId);
        }, i * 20);
      });

      // Inject UI observer script
      if (OBSERVER_SCRIPT) {
        setTimeout(function () {
          ws.send(JSON.stringify({ id: 97999, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: OBSERVER_SCRIPT } }));
          ws.send(JSON.stringify({ id: 97998, method: 'Runtime.evaluate', params: { expression: OBSERVER_SCRIPT, contextId: undefined } }));
        }, 200);
      }
    });

    ws.on('message', function (data) {
      var txt = data.toString();
      var entry = parseMessage(txt);
      entry.direction = 'browser→client';
      emit(entry, wsId);

      // Track requestId → url for WebSocket/SSE correlation
      if (entry.type === 'event' && entry.method === 'Network.requestWillBeSent' && entry.params && entry.params.requestId) {
        urlMap[entry.params.requestId] = entry.params.request.url;
      }
      if (entry.type === 'event' && entry.method === 'Network.webSocketCreated' && entry.params && entry.params.requestId) {
        urlMap[entry.params.requestId] = entry.params.url;
      }
      if (entry.type === 'event' && entry.method === 'Network.webSocketHandshakeResponseReceived' && entry.params && entry.params.requestId) {
        if (!urlMap[entry.params.requestId] && entry.params.response) urlMap[entry.params.requestId] = entry.params.response.url;
      }

      // WebSocket frames → dedicated table — handled below for URL map.
      // HTTP: requestWillBeSent
      if (entry.type === 'event' && entry.method === 'Network.requestWillBeSent' && entry.params) {
        var p = entry.params;
        // Redirect chain: o mesmo requestId vê um segundo requestWillBeSent com
        // redirectResponse → o request anterior acabou (3xx). Finaliza antes de abrir o novo.
        if (p.redirectResponse && reqMap[p.requestId]) {
          finalizeHttp(p.requestId, {
            status_code: p.redirectResponse.status,
            response_headers: p.redirectResponse.headers || null,
            duration_ms: entry.ts - reqMap[p.requestId].ts,
          });
        }
        reqMap[p.requestId] = {
          ts: entry.ts,
          method: p.request && p.request.method || 'GET',
          url: p.request && p.request.url || null,
          request_headers: p.request && p.request.headers || null,
          request_body: p.request && p.request.postData || null,
        };
        pruneReqMap();
      }

      // HTTP: responseReceivedExtraInfo — chega ANTES de responseReceived, com headers reais
      // (cookies, X-*, etc) e status primeiro.
      if (entry.type === 'event' && entry.method === 'Network.responseReceivedExtraInfo' && entry.params && reqMap[entry.params.requestId]) {
        var hh = reqMap[entry.params.requestId];
        hh.response_headers = entry.params.headers || hh.response_headers;
        if (entry.params.statusCode) hh.status_code = entry.params.statusCode;
      }

      // HTTP: responseReceived — status final + headers upstream (se não veio ExtraInfo antes)
      if (entry.type === 'event' && entry.method === 'Network.responseReceived' && entry.params && reqMap[entry.params.requestId]) {
        var rr = reqMap[entry.params.requestId];
        var resp = entry.params.response || {};
        rr.status_code = resp.status != null ? resp.status : rr.status_code;
        if (!rr.response_headers && resp.headers) rr.response_headers = resp.headers;
      }

      // HTTP: loadingFinished — fim do ciclo, consolida 1 row por request
      if (entry.type === 'event' && entry.method === 'Network.loadingFinished' && entry.params && reqMap[entry.params.requestId]) {
        reqMap[entry.params.requestId].ts_finished = entry.ts;
        finalizeHttp(entry.params.requestId);
      }
      if ((entry.method === 'Network.webSocketFrameSent' || entry.method === 'Network.webSocketFrameReceived') && onWsFrame) {
        var resp = entry.params && entry.params.response;
        var opcode = resp && resp.opcode;
        var payload = resp && resp.payloadData;
        if (opcode !== 1 && typeof payload === 'string') {
          try { payload = Buffer.from(payload, 'base64').toString('utf-8'); } catch (e) { /* keep raw base64 */ }
        }
        onWsFrame({
          session_id: sessionId,
          wsId: wsId,
          ts: entry.ts,
          request_id: entry.params && entry.params.requestId,
          url: urlMap[entry.params && entry.params.requestId] || null,
          direction: entry.method === 'Network.webSocketFrameSent' ? 'sent' : 'received',
          opcode: opcode,
          payload: payload,
        });
      }

      // SSE messages → dedicated table
      if (entry.method === 'Network.eventSourceMessageReceived' && onSseEvent) {
        onSseEvent({
          session_id: sessionId,
          wsId: wsId,
          ts: entry.ts,
          request_id: entry.params && entry.params.requestId,
          url: urlMap[entry.params && entry.params.requestId] || null,
          event_name: entry.params && entry.params.eventName,
          event_id: entry.params && entry.params.eventId,
          data: entry.params && entry.params.data,
        });
      }

      if (entry.type === 'event' && entry.method === 'Network.responseReceived' && entry.request_id) {
        var reqType = entry.params && entry.params.type;
        if (reqType === 'XHR' || reqType === 'Fetch' || reqType === 'Document') {
          var rid = entry.request_id;
          setTimeout(function () {
            if (ws.readyState === WebSocket.OPEN) {
              var cmdId = 96000 + (++bodySeq);
              bodyMap[cmdId] = rid;
              ws.send(JSON.stringify({ id: cmdId, method: 'Network.getResponseBody', params: { requestId: rid } }));
            }
          }, 50);
        }
      }

      if (entry.type === 'response' && entry.result && entry.result.body !== undefined && onResponseBody) {
        var origRid = bodyMap[entry.id];
        if (origRid) {
          var body = entry.result.body;
          if (entry.result.base64Encoded) {
            try { body = Buffer.from(body, 'base64').toString('utf-8'); } catch (e) { body = '[base64 decode error]'; }
          }
          onResponseBody(origRid, body);
          delete bodyMap[entry.id];
        }
      }
    });

    ws.on('close', function () {
      observerPages.delete(targetId);
      console.error('[observer] page disconnected ' + targetId.slice(0, 6));
    });

    ws.on('error', function (err) {
      console.error('[observer] page error ' + targetId.slice(0, 6) + ': ' + (err && err.message || 'unknown'));
    });
  }

  // ============================================================
  // RELAY — WebSocket proxy for external CDP clients
  // ============================================================

  function cleanHeaders(headers) {
    var cleaned = {};
    for (var k in headers) {
      if (k === 'host') continue;
      var v = headers[k];
      if (v === undefined || v === null) continue;
      cleaned[k] = v;
    }
    cleaned['host'] = '127.0.0.1:' + targetPort;
    return cleaned;
  }

  var httpServer = http.createServer(function (req, res) {
    var bodyChunks = [];
    req.on('data', function (chunk) { bodyChunks.push(chunk); });
    req.on('end', function () {
      var reqBody = Buffer.concat(bodyChunks).toString();
      var options = {
        hostname: '127.0.0.1',
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: cleanHeaders(req.headers),
      };

      var proxyReq = http.request(options, function (proxyRes) {
        var resChunks = [];
        proxyRes.on('data', function (chunk) { resChunks.push(chunk); });
        proxyRes.on('end', function () {
          var resBody = Buffer.concat(resChunks).toString();
          var proxied = resBody
            .replace(new RegExp('ws://127\\.0\\.0\\.1:' + targetPort, 'g'), 'ws://127.0.0.1:' + listenPort)
            .replace(new RegExp('"127\\.0\\.0\\.1:' + targetPort + '"', 'g'), '"127.0.0.1:' + listenPort + '"')
            .replace(new RegExp('\\?ws=127\\.0\\.0\\.1:' + targetPort, 'g'), '?ws=127.0.0.1:' + listenPort);
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end(proxied);

          if (onHttpEvent) {
            onHttpEvent({
              session_id: sessionId,
              ts: Date.now(),
              method: req.method,
              url: req.url,
              status_code: proxyRes.statusCode,
            });
          }
        });
      });

      proxyReq.on('error', function () { res.writeHead(502); res.end('{}'); });
      proxyReq.setTimeout(30000, function () { proxyReq.destroy(); res.writeHead(504); res.end('{}'); });
      if (reqBody) proxyReq.write(reqBody);
      proxyReq.end();
    });
  });

  var wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', function (clientWs, req) {
    var relayId = 'relay-' + crypto.randomUUID().slice(0, 4);
    var targetPath = req.url;
    var chromeWsUrl = 'ws://127.0.0.1:' + targetPort + targetPath;

    if (onWsConnect) onWsConnect(relayId);

    var chromeWs = new WebSocket(chromeWsUrl);

    chromeWs.on('open', function () {
      clientWs.on('message', function (data) {
        var txt = data.toString();
        var entry = parseMessage(txt); entry.direction = 'client→browser'; emit(entry, relayId);
        if (chromeWs.readyState === WebSocket.OPEN) chromeWs.send(txt);
      });

      chromeWs.on('message', function (data) {
        var txt = data.toString();
        var entry = parseMessage(txt); entry.direction = 'browser→client'; emit(entry, relayId);
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(txt);
      });
    });

    chromeWs.on('error', function () {});
    chromeWs.on('close', function () {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    });

    clientWs.on('close', function () {
      if (onWsClose) onWsClose(relayId);
      if (chromeWs.readyState === WebSocket.OPEN) chromeWs.close();
    });
    clientWs.on('error', function () {});
  });

  httpServer.listen(listenPort, function () {
    console.log('\x1b[1m\x1b[92mCDP PROXY\x1b[0m  :' + listenPort + ' → :' + targetPort + '  (' + AUTO_DOMAINS.length + ' domains)');
    startObserver();
  });

  return { httpServer, sessionId };
}

module.exports = { createProxy };
