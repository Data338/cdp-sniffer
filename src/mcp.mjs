#!/usr/bin/env node
// cdp-sniffer MCP server — stdio transport.
// Exposes the sniffer DB + daemon lifecycle as MCP tools so any harness
// (opencode, dsh/omdsh, etc.) can query captured CDP traffic directly.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import dbModule from './db.js';

const db = dbModule;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = path.join(__dirname, '..', 'index.js');
const START_SCRIPT = path.join(__dirname, '..', 'sniffer-start');
const LOG_FILE = '/tmp/sniffer-out.log';
const CHROME_PORT = parseInt(process.env.CDP_CHROME_PORT || '9222');
const PROXY_PORT = parseInt(process.env.CDP_PROXY_PORT || '9223');

db.open();

// --- helpers ---

function summarize(e) {
  return {
    id: e.id, ts: e.ts, type: e.type, direction: e.direction,
    domain: e.domain, method: e.method, http_method: e.http_method,
    url: e.url, status_code: e.status_code, request_id: e.request_id,
    has_body: !!e.response_body,
  };
}

function summarizeHttp(h) {
  return {
    id: h.id, ts: h.ts, method: h.method, url: h.url,
    status_code: h.status_code, duration_ms: h.duration_ms,
    request_id: h.request_id, has_body: !!h.response_body,
  };
}

function maybeFull(events, full) {
  return full ? events : events.map(summarize);
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function checkHttp(port, pathName) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: pathName, timeout: 1500 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ up: true, body }));
    });
    req.on('error', () => resolve({ up: false }));
    req.on('timeout', () => { req.destroy(); resolve({ up: false }); });
  });
}

function checkPort(port) {
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.end(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

function pidsOnPort(port) {
  try {
    return execSync('lsof -ti :' + port + ' 2>/dev/null', { encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

async function waitForPort(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await checkPort(port)) return true;
    await sleep(250);
  }
  return false;
}

function startDaemon() {
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [DAEMON_ENTRY], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.closeSync(out);
  return child;
}

// The sniffer-start script uses bare `google-chrome`, `curl`, `node`, `lsof`,
// which live in the user's bin dirs. Harnesses (esp. desktop-launched) may
// not have those on PATH, so build an explicit env for the child.
function harnessEnv() {
  const home = process.env.HOME || '';
  const bins = [path.join(home, '.local', 'bin'), path.join(home, 'bin'), path.join(home, '.npm-global', 'bin')].filter(Boolean);
  const PATH = bins.join(':') + (process.env.PATH ? ':' + process.env.PATH : '');
  return { ...process.env, HOME: home, PATH };
}

function runScript(script, args, timeoutMs) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(script, args, { env: harnessEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err && err.message || err) });
      return;
    }
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on('error', err => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err && err.message || err) }); });
  });
}

function tailFile(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, size - start, start);
    fs.closeSync(fd);
    return buf.toString();
  } catch { return ''; }
}

// Query with pagination metadata. total_count uses a COUNT(*) over the same
// filters (session/domain/type/http_method/url/status) ignoring limit/offset.
function queryPaged(opts) {
  const all = db.queryCdp({ ...opts, limit: 100000 });
  const total = all.length;
  const offset = opts.offset || 0;
  const limit = opts.limit || 30;
  const page = all.slice(offset, offset + limit);
  return {
    total_count: total,
    count: page.length,
    offset,
    has_more: offset + page.length < total,
    next_offset: offset + page.length < total ? offset + page.length : null,
    events: page,
  };
}

// --- server ---

const INSTRUCTIONS = [
  'cdp-sniffer captures Chrome DevTools Protocol traffic (Network, Console, Page, Runtime, DOM, Storage) plus UI events (clicks, inputs, DOM mutations) into a local SQLite database. Use these tools to inspect what a website actually sent/received, reverse-engineer API flows, and verify browser automation.',
  '',
  'TYPICAL WORKFLOW (mark-correlated — deterministic, no timestamp guessing):',
  '1. sniffer_get_status — check capture is live (chrome_up + daemon_up). If down, call sniffer_start_stack.',
  '2. sniffer_add_mark with label "before-<action>" BEFORE the browser action.',
  '3. Perform the browser action (browse, click, form submit, API call).',
  '4. sniffer_query_http with after_mark="before-<action>" to get ONE consolidated row per HTTP request (method, url, status, headers, bodies) — this is the PRIMARY tool for API inspection.',
  '5. sniffer_get_http with the request_id of the row of interest to get the full redirect chain + linked CDP lifecycle.',
  '6. sniffer_query_ui to see clicks/inputs/DOM mutations between the same marks.',
  '',
  'KEY CONCEPTS:',
  '- session: a capture run. Default is the latest session; sniffer_list_sessions returns earlier ids to pass as `session`.',
  '- marks: named timestamps you insert with sniffer_add_mark. Pass after_mark/before_mark to sniffer_query_events, sniffer_query_http or sniffer_query_ui to isolate a flow (e.g. login POSTs, form submit, API call).',
  '- http_events: 1 row per HTTP request with consolidated request_headers, request_body, response_headers, response_body, duration_ms. The original CDP events (requestWillBeSent, responseReceived, etc.) stay in cdp_events linked by request_id.',
  '- domain: CDP domain. Network = HTTP traffic (carries http_method/url/status_code). Console = includes [cdp-ui] UI events. Page/Runtime/DOM/Storage = lifecycle & storage.',
  '- request_id: CDP requestId correlating requestWillBeSent + responseReceived + response_body + the consolidated http_events row.',
  '- url filters accept substring (case-insensitive) or prefix "re:<regex>" for FULL REGEX, e.g. url="re:^https?://api\\\\..*\\\\.json$".',
  '- Output is summarized by default. Pass full=true to include params/result/headers/bodies. Use pagination (total_count/has_more/next_offset) for large results.',
  '- WebSocket frames are in sniffer_query_websocket; SSE (Server-Sent Events) messages are in sniffer_query_sse — these are NOT in the main HTTP stream.',
  '',
  'RULES:',
  '- Prefer sniffer_query_http for HTTP inspection; use sniffer_query_events only for raw CDP events or non-HTTP domains.',
  '- Use sniffer_search_events with fields=[...] for free-text search across params/result/method/url/response_body when you dont know which request holds a token.',
  '- Destructive tools (sniffer_clear_events, sniffer_control_daemon) require explicit intent.',
  '- Chrome must run with --remote-debugging-port=' + CHROME_PORT + '. Use sniffer_start_stack for a full launch (Chrome + daemon); sniffer_control_daemon only touches the daemon.',
].join('\n');

const server = new McpServer(
  { name: 'cdp-sniffer', version: '1.3.0' },
  { instructions: INSTRUCTIONS },
);

// --- shared schema fragments ---

const sessionOpt = z.string().optional().describe(
  'Capture session id. Default: the latest session. Call sniffer_list_sessions to get earlier session ids.'
);
const fullOpt = z.boolean().optional().describe(
  'If true, return full params/result/response_body for each event. Default false returns a compact summary (id, ts, type, direction, domain, method, http_method, url, status_code, request_id, has_body) to save context.'
);
const domainOpt = z.string().optional().describe(
  'CDP domain filter. Common values: Network (HTTP traffic with http_method/url/status_code), Console (includes [cdp-ui] UI events: clicks, inputs, DOM mutations), Page, Runtime, DOM, Storage.'
);
const limitOpt = z.number().optional().describe('Max events to return per page (default 30).');
const offsetOpt = z.number().optional().describe('Pagination offset. Use next_offset from a previous response to fetch the next page.');
const urlOpt = z.string().optional().describe(
  'Filter by URL. Either a case-insensitive substring (e.g. "login", "api/quote"), or a full REGEX with the prefix "re:" (e.g. "re:^https?://api\\\\..*/v2/"). Default is substring matching.'
);
const afterMarkOpt = z.string().optional().describe(
  'Only show events AFTER the most recent mark with this label (isolated flow). Call sniffer_add_mark before the action, then use that label here.'
);
const beforeMarkOpt = z.string().optional().describe(
  'Only show events BEFORE the most recent mark with this label.'
);
const methodOpt = z.string().optional().describe(
  'HTTP method filter (case-insensitive): GET | POST | PUT | DELETE | ...'
);

// --- tools ---

server.registerTool('sniffer_get_status', {
  description:
    'Check whether the sniffer is capturing: Chrome remote-debugging endpoint, the capture daemon, and the SQLite DB. ' +
    'ALWAYS call this first before querying — if chrome_up or daemon_up is false, queries return stale/empty data. ' +
    'The response includes a `hint` telling you exactly what to do next when something is down. ' +
    'Do NOT use this to start anything; use sniffer_start_stack (full stack) or sniffer_control_daemon (daemon only).',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  const chrome = await checkHttp(CHROME_PORT, '/json/version');
  const daemon = await checkPort(PROXY_PORT);
  const s = db.getLatestSession();
  return ok({
    chrome_up: chrome.up, chrome_port: CHROME_PORT,
    daemon_up: daemon, proxy_port: PROXY_PORT,
    db: db.DB_PATH,
    latest_session: s ? s.id : null,
    session_started: s ? s.started_at : null,
    ws_connections: s ? s.ws_connections : 0,
    hint: !chrome.up
      ? 'Chrome down — call sniffer_start_stack to launch the full stack (Chrome + daemon).'
      : !daemon
        ? 'Daemon down — call sniffer_control_daemon with action=start, or sniffer_start_stack for a full relaunch.'
        : 'Capturing. Query with sniffer_query_events (domain=Network for HTTP, domain=Console for UI events).',
  });
});

server.registerTool('sniffer_query_http', {
  description:
    'Query CONSOLIDATED HTTP requests: one row per request with method, url, status, request/response headers, bodies and timing. This is the PRIMARY tool for API inspection — much easier than raw sniffer_query_events. ' +
    'Use after_mark to isolate a flow: 1) sniffer_add_mark before the action, 2) perform the browser action, 3) call this with after_mark to see only the requests that action caused. ' +
    'Filter by method (case-insensitive), url (substring or "re:<regex>"), status. Paginated. Default returns a summary (method, url, status, duration, request_id, has_body); pass full=true for headers + bodies.',
  inputSchema: {
    method: methodOpt,
    url: urlOpt,
    status: z.number().optional().describe('HTTP status code filter, e.g. 200, 401, 500.'),
    after_mark: afterMarkOpt,
    before_mark: beforeMarkOpt,
    since: z.number().optional().describe('Unix timestamp (ms) — only requests at or after this time.'),
    limit: limitOpt,
    offset: offsetOpt,
    session: sessionOpt,
    full: fullOpt,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ method, url, status, after_mark, before_mark, since, limit, offset, session, full }) => {
  const r = db.queryHttpEvents({ method, url, status, after_mark, before_mark, since, limit: limit || 30, offset, session_id: session });
  if (r.total_count === 0) {
    const suggestions = [];
    if (after_mark) suggestions.push('no HTTP requests after mark "' + after_mark + '" — check the mark exists via sniffer_list_marks, or a different mark name');
    if (url) suggestions.push('no URLs matched "' + url + '" — try a broader substring (e.g. "admex" instead of "admex.com.br/login") or relax status/method filters');
    suggestions.push('confirm capture is live: sniffer_get_status should show daemon_up: true');
    return ok({ ...r, events: [], hint: suggestions });
  }
  return ok({ ...r, events: full ? r.events : r.events.map(summarizeHttp) });
});

server.registerTool('sniffer_get_http', {
  description:
    'Get the FULL detail of ONE HTTP request by request_id: the consolidated row (method, url, request_headers, request_body, response_headers, response_body, duration_ms) plus every redirect in the chain and every linked raw CDP event. ' +
    'Equivalent to old sniffer_get_request but returns the consolidated http_events data directly (no need to reassemble requestWillBeSent + responseReceived + loadingFinished).',
  inputSchema: {
    request_id: z.string().describe('CDP requestId, copied from a sniffer_query_http / sniffer_query_events result (field request_id).'),
    session: sessionOpt,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ request_id, session }) => {
  const data = db.getHttpByRequestId(request_id, session);
  if (!data || (!data.http && !data.cdp_events.length)) {
    return fail(
      'Nothing found for request_id "' + request_id + '". ' +
      'Next step: run sniffer_query_http (or sniffer_query_events domain=Network) to list requests and copy a valid request_id from the results.'
    );
  }
  return ok(data);
});

server.registerTool('sniffer_query_ui', {
  description:
    'Query UI events captured from the page (clicks, input changes, DOM mutations) as structured data — no more parsing the raw [cdp-ui] console message. ' +
    'Filter by ui_type (click | input | dom-attr | dom-add | dom-remove) and by after_mark/before_mark to isolate a flow. ' +
    'Each result is one console batch containing one or more UI events with timestamp, tag, selector, visible text, and parent path.',
  inputSchema: {
    ui_type: z.enum(['click', 'input', 'dom-attr', 'dom-add', 'dom-remove']).optional().describe('Filter by UI event type.'),
    after_mark: afterMarkOpt,
    before_mark: beforeMarkOpt,
    limit: limitOpt,
    offset: offsetOpt,
    session: sessionOpt,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ ui_type, after_mark, before_mark, limit, offset, session }) => {
  const r = db.queryUiEvents({ ui_type, after_mark, before_mark, limit: limit || 30, offset, session_id: session });
  return ok(r);
});

server.registerTool('sniffer_list_marks', {
  description:
    'List timestamp marks of a session (label + ts), most recent first. Use this to pick mark labels for after_mark/before_mark in sniffer_query_http / sniffer_query_events / sniffer_query_ui.',
  inputSchema: {
    limit: z.number().optional().describe('Max marks to return (default 20).'),
    session: sessionOpt,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ limit, session }) => {
  const sid = session || (db.getLatestSession() ? db.getLatestSession().id : null);
  return ok(db.getMarks(sid, limit || 20));
});

server.registerTool('sniffer_query_events', {
  description:
    'Query captured CDP events with structured filters. Use domain=Network for raw CDP network events, domain=Console to see UI events ([cdp-ui] clicks/inputs/mutations). ' +
    'For consolidated HTTP (1 row per request with headers/bodies) prefer sniffer_query_http instead — this tool is for raw CDP internals. ' +
    'Supports url substring or "re:<regex>", after_mark/before_mark to isolate a flow between named marks, and pagination (next_offset). ' +
    'Returns a paginated summary by default; pass full=true for complete params/result/response_body.',
  inputSchema: {
    domain: domainOpt,
    type: z.string().optional().describe('CDP message type: request | response | event | error. Usually leave unset.'),
    http_method: methodOpt,
    url: urlOpt,
    status: z.number().optional().describe('HTTP status code filter, e.g. 200, 401, 500.'),
    after_mark: afterMarkOpt,
    before_mark: beforeMarkOpt,
    limit: limitOpt,
    offset: offsetOpt,
    session: sessionOpt,
    full: fullOpt,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ domain, type, http_method, url, status, after_mark, before_mark, limit, offset, session, full }) => {
  const r = queryPaged({ domain, type, http_method, url, status, after_mark, before_mark, limit: limit || 30, offset, session_id: session });
  return ok({ ...r, events: maybeFull(r.events, full) });
});

server.registerTool('sniffer_search_events', {
  description:
    'Free-text search across event fields. Use this to find a specific token, header value, cookie, JWT, or payload fragment when you do NOT know which request it belongs to. ' +
    'Pass fields to restrict which columns are searched (params, result, method, url, response_body); default searches params/result/method/url. ' +
    'Pass regex=true for a full ECMAScript regex instead of substring (e.g. "eyJ[A-Za-z0-9_-]{10}\\\\."). ' +
    'For structured browsing by method/url/status use sniffer_query_http or sniffer_query_events instead.',
  inputSchema: {
    query: z.string().describe('Search term (case-insensitive substring) or regex if regex=true. Examples: "eyJhbGciOi" (JWT), "sessionid", "csrf", an API path fragment.'),
    domain: domainOpt,
    fields: z.array(z.enum(['params', 'result', 'method', 'url', 'response_body'])).optional().describe(
      'Restrict search to these event fields. Default: params, result, method, url (response_body excluded — add it explicitly for body search).'
    ),
    regex: z.boolean().optional().describe('If true, treats query as a full ECMAScript regex (case-insensitive) instead of a substring.'),
    limit: limitOpt,
    session: sessionOpt,
    full: fullOpt,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ query, domain, fields, regex, limit, session, full }) => {
  const results = db.searchCdp({ query, domain, fields, regex, limit: limit || 30, session_id: session });
  if (results.length === 0) {
    const suggestions = [];
    if (!fields) suggestions.push('try response_body in fields: fields=["params","response_body"]');
    if (!regex) suggestions.push('if your query has special chars or is a pattern, pass regex: true');
    suggestions.push('the event may live in WebSocket frames or SSE — try sniffer_query_websocket or sniffer_query_sse');
    suggestions.push('confirm via sniffer_get_stats that the session has traffic (total_http_events > 0)');
    return ok({ query, count: 0, results: [], hint: suggestions });
  }
  return ok({ query, count: results.length, results: maybeFull(results, full) });
});

server.registerTool('sniffer_get_request', {
  description:
    'Get the full CDP lifecycle of ONE HTTP request by request_id: the request (method, url, headers, postData), the response (status, headers), and the decoded response_body — as raw CDP events. ' +
    'For the consolidated HTTP view (headers + bodies in one row) prefer sniffer_get_http instead. ' +
    'Obtain request_id values from sniffer_query_events or sniffer_search_events results. ' +
    'Use this after narrowing down to a specific request — it returns the complete payload, so prefer it over re-querying with full=true.',
  inputSchema: {
    request_id: z.string().describe('CDP requestId, copied from a sniffer_query_events / sniffer_search_events result (field request_id).'),
    session: sessionOpt,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ request_id, session }) => {
  const events = db.getByRequestId(request_id, session);
  if (!events.length) {
    return fail(
      'No events found for request_id "' + request_id + '". ' +
      'Next step: run sniffer_query_events with domain=Network (optionally url=<substring>) to list requests and copy a valid request_id from the results.'
    );
  }
  return ok({ request_id, count: events.length, events });
});

server.registerTool('sniffer_get_stats', {
  description:
    'Aggregated statistics for a capture session: total CDP/HTTP/mark counts, event counts per domain, top URLs, and HTTP status code distribution. ' +
    'Use this to get a quick overview of what was captured before drilling into specific requests with sniffer_query_events.',
  inputSchema: { session: sessionOpt },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ session }) => ok(db.getStats(session)));

server.registerTool('sniffer_query_websocket', {
  description:
    'Query captured WebSocket frames (the full-duplex messages that follow a WS handshake). Each frame has direction (sent/received), opcode (1=text, 2=binary, 8=close, 9=ping, 10=pong), payload (base64-decoded for binary), and the correlated request_id + url. ' +
    'Use this to inspect real-time/streaming traffic that does NOT appear in sniffer_query_events (frames are stored separately). ' +
    'Filter by url substring, request_id, direction, or opcode. Returns paginated results with total_count/has_more/next_offset.',
  inputSchema: {
    url: z.string().optional().describe('Case-insensitive substring match on the WebSocket URL.'),
    request_id: z.string().optional().describe('CDP requestId of the WebSocket connection (from sniffer_query_events with domain=Network).'),
    direction: z.enum(['sent', 'received']).optional().describe('Frame direction: sent = client→browser, received = browser→client.'),
    opcode: z.number().optional().describe('Frame opcode: 1=text, 2=binary, 8=close, 9=ping, 10=pong.'),
    limit: limitOpt,
    offset: offsetOpt,
    session: sessionOpt,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ url, request_id, direction, opcode, limit, offset, session }) => {
  const r = db.queryWsFrames({ url, request_id, direction, opcode, limit: limit || 30, offset, session_id: session });
  return ok(r);
});

server.registerTool('sniffer_query_sse', {
  description:
    'Query captured Server-Sent Events (SSE / EventSource stream messages). Each entry has event_name, event_id, data, and the correlated request_id + url. ' +
    'Use this to inspect streaming feeds, notifications, or LLM token streams that arrive via EventSource. ' +
    'Filter by url substring, request_id, or event_name. Returns paginated results with total_count/has_more/next_offset.',
  inputSchema: {
    url: z.string().optional().describe('Case-insensitive substring match on the EventSource URL.'),
    request_id: z.string().optional().describe('CDP requestId of the EventSource request (from sniffer_query_events with domain=Network).'),
    event_name: z.string().optional().describe('SSE event name (the "event:" field).'),
    limit: limitOpt,
    offset: offsetOpt,
    session: sessionOpt,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ url, request_id, event_name, limit, offset, session }) => {
  const r = db.querySseEvents({ url, request_id, event_name, limit: limit || 30, offset, session_id: session });
  return ok(r);
});

server.registerTool('sniffer_list_sessions', {
  description:
    'List capture sessions, most recent first. Each session has an id, started_at, ended_at, and ws_connections. ' +
    'Use the id as the `session` argument in other tools to query an older capture instead of the latest one.',
  inputSchema: { limit: z.number().optional().describe('Max sessions to return (default 20).') },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ limit }) => ok(db.getSessions(limit || 20)));

server.registerTool('sniffer_add_mark', {
  description:
    'Insert a named timestamp marker into the capture stream (e.g. "before-login", "after-submit"). ' +
    'Markers let you correlate later queries with a specific moment in the browser flow. ' +
    'This writes to the database but is non-destructive and idempotent-safe.',
  inputSchema: {
    label: z.string().describe('Short marker label, e.g. "before-login".'),
    tags: z.array(z.string()).optional().describe('Optional tags for grouping/filtering marks.'),
    session: sessionOpt,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ label, tags, session }) => {
  const id = db.insertMark(session || null, label, tags);
  return ok({ id, label, ok: true });
});

server.registerTool('sniffer_watch_events', {
  description:
    'Poll the database until events matching the filters appear, or the timeout elapses (max 30s). ' +
    'Use this RIGHT AFTER triggering a browser action (e.g. after a click or form submit) to wait for the resulting network request to be captured, instead of guessing a fixed sleep. ' +
    'Returns found=true with the matching events, or timed_out=true.',
  inputSchema: {
    domain: domainOpt,
    url: z.string().optional().describe('Case-insensitive substring match on the request URL.'),
    timeout: z.number().optional().describe('Milliseconds to wait, capped at 30000 (default 10000).'),
    session: sessionOpt,
    full: fullOpt,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ domain, url, timeout, session, full }) => {
  const cap = Math.min(timeout || 10000, 30000);
  const deadline = Date.now() + cap;
  while (Date.now() < deadline) {
    const events = db.queryCdp({ domain, url, limit: 10, session_id: session });
    if (events.length > 0) {
      return ok({ found: events.length, timed_out: false, events: maybeFull(events, full) });
    }
    await sleep(500);
  }
  return ok({ found: 0, timed_out: true });
});

server.registerTool('sniffer_clear_events', {
  description:
    'PERMANENTLY DELETE captured events. You MUST pass confirm=true or the call is rejected. ' +
    'If `session` is given, only that session is wiped; if omitted, ALL sessions are deleted. ' +
    'There is no undo. Do not call this unless the user explicitly asked to clear the capture data.',
  inputSchema: {
    confirm: z.literal(true).describe('Must be exactly true to confirm deletion. This is a safety guard.'),
    session: sessionOpt,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ session }) => {
  db.clearAll(session);
  return ok({ ok: true, scope: session || 'all' });
});

server.registerTool('sniffer_start_stack', {
  description:
    'Launch the FULL capture stack: Chrome (with remote debugging on :' + CHROME_PORT + ') plus the sniffer daemon on :' + PROXY_PORT + '. ' +
    'Use this when sniffer_get_status reports chrome_up=false, or when you need a fresh capture from scratch. ' +
    'SAFETY: if Chrome is ALREADY running it is reused, not killed; Chrome is only (re)launched when it is down (that path kills any leftover process on the ports). ' +
    'Pass profile to pick which signed-in Google account loads (e.g. "andreictg338@gmail.com" → the "Profile 1" dir with Browser MCP extension). ' +
    'Pass profile="ask" to show the Chrome profile-picker. Omit profile to keep the last-used profile (default behavior). ' +
    'Pass reset=true to also wipe the Chrome profile — destructive: removes extensions and login. Check current state first with sniffer_get_status.',
  inputSchema: {
    reset: z.boolean().optional().describe('If true, wipe the Chrome profile (--reset). Destructive: removes extensions and login.'),
    profile: z.string().optional().describe(
      'Which Chrome profile to launch. Pass the profile email (e.g. "andreictg338@gmail.com") — it is resolved via ~/.config/cdp-sniffer-chrome/Local State. ' +
      'Use "ask" to force the Chrome profile-picker window. Omit to keep the last-used profile (default).'
    ),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ reset, profile }) => {
  const chrome = await checkHttp(CHROME_PORT, '/json/version');
  const daemon = await checkPort(PROXY_PORT);

  if (!reset && chrome.up && daemon) {
    return ok({ already_running: true, chrome_up: true, daemon_up: true });
  }

  // Chrome up, daemon down → reuse the running Chrome, only start the daemon.
  if (!reset && chrome.up && !daemon) {
    const child = startDaemon();
    const up = await waitForPort(PROXY_PORT, 6000);
    return ok({ launched: 'daemon', chrome_up: true, daemon_up: up, pid: child.pid, log: LOG_FILE });
  }

  // Chrome down (or reset requested) → full launch via sniffer-start.
  const args = [];
  if (reset) args.push('--reset');
  if (profile) args.push('--profile=' + profile);
  const res = await runScript(START_SCRIPT, args, 25000);
  await sleep(1500);
  const chromeUp = await checkHttp(CHROME_PORT, '/json/version');
  const daemonUp = await checkPort(PROXY_PORT);
  const note = res.code !== 0 ? 'sniffer-start exited ' + res.code + ': ' + (res.stderr || '').trim() : undefined;
  return ok({
    launched: 'stack',
    chrome_up: chromeUp.up,
    daemon_up: daemonUp,
    profile: profile || null,
    script_exit_code: res.code,
    launcher_output: (res.stdout || '').trim(),
    daemon_log_tail: tailFile(LOG_FILE, 1024),
    ...(note ? { note } : {}),
  });
});

server.registerTool('sniffer_control_daemon', {
  description:
    'Start, stop, or restart ONLY the capture daemon (the background process that reads CDP from Chrome and writes to the DB). ' +
    'start requires Chrome to ALREADY be running with --remote-debugging-port=' + CHROME_PORT + ' — it fails with a hint otherwise and never launches/kills Chrome itself. ' +
    'To launch the full stack (Chrome + daemon) use sniffer_start_stack instead. ' +
    'Check current state first with sniffer_get_status.',
  inputSchema: {
    action: z.enum(['start', 'stop', 'restart']).describe('start: spawn daemon if not running. stop: kill daemon. restart: stop then start.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ action }) => {
  if (action === 'stop' || action === 'restart') {
    const pids = pidsOnPort(PROXY_PORT);
    for (const pid of pids) { try { process.kill(parseInt(pid)); } catch {} }
    if (pids.length) await sleep(800);
    if (action === 'stop') return ok({ stopped: pids.length > 0, pids });
  }

  const chrome = await checkHttp(CHROME_PORT, '/json/version');
  if (!chrome.up) {
    return fail(
      'Chrome is not running on :' + CHROME_PORT + ', so the daemon has nothing to capture. ' +
      'Next step: call sniffer_start_stack to launch the full stack (Chrome + daemon), then retry.'
    );
  }
  if (await checkPort(PROXY_PORT)) return ok({ started: false, already_running: true });

  const child = startDaemon();
  const up = await waitForPort(PROXY_PORT, 6000);
  return ok({ started: up, pid: child.pid, log: LOG_FILE });
});

// --- boot ---

const transport = new StdioServerTransport();
await server.connect(transport);

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
