#!/usr/bin/env node
// cdp-sniffer smoke test — verifies WebSocket + SSE capture end-to-end.
// Requires: Chrome running with --remote-debugging-port=9222 AND the sniffer
// daemon running on :9223 (i.e. `sniffer-start` already launched). This script
// does NOT launch Chrome or the daemon.
//
// It serves a local page that (after a short delay) opens:
//   1. a WebSocket to wss://ws.ifelse.io and sends/echoes "ping-sniffer"
//   2. an EventSource to a LOCAL /sse endpoint (3 "tick" messages, deterministic)
// then asserts the sniffer captured ws_frames + sse_events for them.
// Note: /json/new requires PUT (GET returns 405) on modern Chrome.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dbModule from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = dbModule;

const CHROME_PORT = parseInt(process.env.CDP_CHROME_PORT || '9222');
const PROXY_PORT = parseInt(process.env.CDP_PROXY_PORT || '9223');
const PAGE_PORT = 8787;
const WS_URL = 'wss://ws.ifelse.io';
const SSE_PATH = '/sse';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpReq(port, pathName, method) {
  method = method || 'GET';
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method, timeout: 3000 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// --- 1. sanity: Chrome + daemon up ---
const chrome = await httpReq(CHROME_PORT, '/json/version');
if (!chrome || !chrome.body.includes('webSocketDebuggerUrl')) {
  console.error('FAIL: Chrome not reachable on :' + CHROME_PORT + ' — run sniffer-start first.');
  process.exit(1);
}

const pageHtml = `<!doctype html><html><body>
<h1>cdp-sniffer smoke test</h1>
<script>
setTimeout(function () {
  try {
    var ws = new WebSocket('${WS_URL}');
    ws.onopen = function () { ws.send('ping-sniffer'); };
  } catch (e) {}
  try {
    var es = new EventSource('${SSE_PATH}');
    es.addEventListener('tick', function (ev) {});
    es.onerror = function () {};
  } catch (e) {}
}, 1500);
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === SSE_PATH) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    let i = 0;
    const iv = setInterval(() => {
      i++;
      res.write('event: tick\ndata: message-' + i + '\n\n');
      if (i >= 3) { clearInterval(iv); res.end(); }
    }, 300);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(pageHtml);
});

// --- 2. serve page + open it in Chrome via /json/new (PUT, required by modern Chrome) ---
await new Promise(r => server.listen(PAGE_PORT, '127.0.0.1', r));
const opened = await httpReq(CHROME_PORT, '/json/new?' + encodeURIComponent('http://127.0.0.1:' + PAGE_PORT + '/'), 'PUT');
if (!opened || opened.status >= 400) {
  console.error('FAIL: could not open page via /json/new (status ' + (opened && opened.status) + ')');
  server.close();
  process.exit(1);
}
console.log('Opened test page; waiting for WS + SSE traffic...');
await sleep(8000);

// --- 3. read latest session ---
db.open();
const latest = db.getLatestSession();
const sid = latest ? latest.id : null;
console.log('session:', sid);

const ws = db.queryWsFrames({ url: 'ifelse', session_id: sid, limit: 100 });
const sse = db.querySseEvents({ url: '/sse', session_id: sid, limit: 100 });

const sent = ws.frames.filter(f => f.direction === 'sent');
const recv = ws.frames.filter(f => f.direction === 'received');

console.log('\n--- WebSocket frames ---');
console.log('  total:', ws.total_count, '| sent:', sent.length, '| received:', recv.length);
if (recv.length) console.log('  sample received payload:', JSON.stringify(recv[0].payload));

console.log('\n--- SSE events ---');
console.log('  total:', sse.total_count);
if (sse.events.length) console.log('  sample data:', JSON.stringify(sse.events[0].data));

const wsOk = sent.length >= 1 && recv.length >= 1;
const sseOk = sse.total_count >= 1;

console.log('\n=== RESULTS ===');
console.log('WebSocket capture:', wsOk ? 'PASS' : 'FAIL');
console.log('SSE capture:      ', sseOk ? 'PASS' : 'FAIL');

db.close();
server.close();
process.exit(wsOk && sseOk ? 0 : 1);
