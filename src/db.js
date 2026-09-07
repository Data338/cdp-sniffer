const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.resolve(process.env.CDP_SNIFFER_DB_DIR || path.join(process.env.HOME, 'Documents', 'logs'));
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = path.join(DB_DIR, 'cdp-sniffer.db');
let db;

const MAX_CDP_EVENTS = parseInt(process.env.CDP_SNIFFER_MAX_EVENTS || '100000');
const MAX_HTTP_EVENTS = parseInt(process.env.CDP_SNIFFER_MAX_HTTP || '20000');
const MAX_WS_FRAMES = parseInt(process.env.CDP_SNIFFER_MAX_WS || '50000');
const MAX_SSE_EVENTS = parseInt(process.env.CDP_SNIFFER_MAX_SSE || '50000');

function open() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      ws_connections INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS cdp_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ws_id TEXT,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      direction TEXT,
      domain TEXT,
      method TEXT,
      http_method TEXT,
      url TEXT,
      status_code INTEGER,
      request_id TEXT,
      params TEXT,
      result TEXT,
      response_body TEXT,
      duration_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS http_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      status_code INTEGER,
      request_headers TEXT,
      request_body TEXT,
      response_headers TEXT,
      response_body TEXT,
      duration_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      label TEXT NOT NULL,
      tags TEXT
    );

    CREATE TABLE IF NOT EXISTS ws_frames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ws_id TEXT,
      ts INTEGER NOT NULL,
      request_id TEXT,
      url TEXT,
      direction TEXT,
      opcode INTEGER,
      payload TEXT
    );

    CREATE TABLE IF NOT EXISTS sse_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ws_id TEXT,
      ts INTEGER NOT NULL,
      request_id TEXT,
      url TEXT,
      event_name TEXT,
      event_id TEXT,
      data TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cdp_session ON cdp_events(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_cdp_domain ON cdp_events(domain, type);
    CREATE INDEX IF NOT EXISTS idx_cdp_url ON cdp_events(url);
    CREATE INDEX IF NOT EXISTS idx_cdp_method ON cdp_events(http_method);
    CREATE INDEX IF NOT EXISTS idx_cdp_status ON cdp_events(status_code);
    CREATE INDEX IF NOT EXISTS idx_cdp_ts ON cdp_events(ts);
    CREATE INDEX IF NOT EXISTS idx_cdp_request_id ON cdp_events(request_id);
    CREATE INDEX IF NOT EXISTS idx_http_session ON http_events(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_marks_session ON marks(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_ws_session ON ws_frames(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_ws_request ON ws_frames(request_id);
    CREATE INDEX IF NOT EXISTS idx_ws_url ON ws_frames(url);
    CREATE INDEX IF NOT EXISTS idx_sse_session ON sse_events(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_sse_request ON sse_events(request_id);
    CREATE INDEX IF NOT EXISTS idx_sse_url ON sse_events(url);
  `);

  // Evoluções de schema — ALTER ADD COLUMN é atômico e sem migration
  try { db.exec('ALTER TABLE http_events ADD COLUMN request_id TEXT'); } catch (e) { /* coluna já existe */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_http_request ON http_events(request_id)'); } catch (e) {}

  // Operador REGEXP (url/body regex search). Pattern inválido → não casa (não quebra a query).
  db.function('regexp', { deterministic: true }, function (pattern, text) {
    if (text == null) return 0;
    try { return new RegExp(String(pattern), 'i').test(String(text)) ? 1 : 0; } catch { return 0; }
  });

  return db;
}

function close() {
  if (db) { db.close(); db = null; }
}

function getDb() {
  if (!db) open();
  return db;
}

function startSession(sessionId) {
  const d = getDb();
  const exists = d.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (exists) {
    d.prepare('UPDATE sessions SET ended_at = NULL, ws_connections = 0 WHERE id = ?').run(sessionId);
  } else {
    d.prepare('INSERT INTO sessions (id) VALUES (?)').run(sessionId);
  }
}

function endSession(sessionId) {
  getDb().prepare("UPDATE sessions SET ended_at = datetime('now') WHERE id = ? AND ended_at IS NULL").run(sessionId);
}

function incrementConnections(sessionId) {
  getDb().prepare('UPDATE sessions SET ws_connections = ws_connections + 1 WHERE id = ?').run(sessionId);
}

function decrementConnections(sessionId) {
  getDb().prepare('UPDATE sessions SET ws_connections = MAX(0, ws_connections - 1) WHERE id = ?').run(sessionId);
}

function getLatestSession() {
  return getDb().prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1').get();
}

function getSessions(limit) {
  return getDb().prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit || 20);
}

// --- CDP Events ---

let cdpStmt;
let cdpCount = 0;

function insertCdpEvent(event) {
  const d = getDb();
  if (!cdpStmt) {
    cdpStmt = d.prepare(`
      INSERT INTO cdp_events (session_id, ws_id, ts, type, direction, domain, method,
        http_method, url, status_code, request_id, params, result, response_body, duration_ms)
      VALUES (@session_id, @ws_id, @ts, @type, @direction, @domain, @method,
        @http_method, @url, @status_code, @request_id, @params, @result, @response_body, @duration_ms)
    `);
  }

  var row = cdpStmt.run({
    session_id: event.session_id,
    ws_id: event.wsId || null,
    ts: event.ts,
    type: event.type,
    direction: event.direction || null,
    domain: event.domain || (event.method ? event.method.split('.')[0] : null),
    method: event.method || null,
    http_method: event.http_method || null,
    url: event.url ? event.url.slice(0, 2000) : null,
    status_code: event.status_code || null,
    request_id: event.request_id ? String(event.request_id).slice(0, 200) : null,
    params: safeTruncate(event.params, 100000),
    result: safeTruncate(event.result, 100000),
    response_body: event.response_body ? String(event.response_body).slice(0, 200000) : null,
    duration_ms: event.duration_ms || null,
  });

  cdpCount++;
  if (cdpCount >= MAX_CDP_EVENTS && cdpCount % 2000 === 0) {
    const keep = MAX_CDP_EVENTS - 2000;
    d.prepare('DELETE FROM cdp_events WHERE id NOT IN (SELECT id FROM cdp_events ORDER BY id DESC LIMIT ?)').run(keep);
    cdpCount = d.prepare('SELECT COUNT(*) as c FROM cdp_events').get().c;
  }

  return row.lastInsertRowid;
}

// --- HTTP Events ---

let httpStmt;
let httpCount = 0;

function insertHttpEvent(event) {
  const d = getDb();
  if (!httpStmt) {
    httpStmt = d.prepare(`
      INSERT INTO http_events (session_id, ts, method, url, status_code,
        request_headers, request_body, response_headers, response_body, duration_ms, request_id)
      VALUES (@session_id, @ts, @method, @url, @status_code,
        @request_headers, @request_body, @response_headers, @response_body, @duration_ms, @request_id)
    `);
  }

  httpStmt.run({
    session_id: event.session_id,
    ts: event.ts,
    method: event.method,
    url: event.url ? event.url.slice(0, 2000) : null,
    status_code: event.status_code || null,
    request_headers: event.request_headers ? JSON.stringify(event.request_headers) : null,
    request_body: event.request_body ? String(event.request_body).slice(0, 200000) : null,
    response_headers: event.response_headers ? JSON.stringify(event.response_headers) : null,
    response_body: event.response_body ? String(event.response_body).slice(0, 200000) : null,
    duration_ms: event.duration_ms || null,
    request_id: event.request_id ? String(event.request_id).slice(0, 200) : null,
  });

  httpCount++;
  if (httpCount >= MAX_HTTP_EVENTS && httpCount % 500 === 0) {
    const keep = MAX_HTTP_EVENTS - 500;
    d.prepare('DELETE FROM http_events WHERE id NOT IN (SELECT id FROM http_events ORDER BY id DESC LIMIT ?)').run(keep);
    httpCount = d.prepare('SELECT COUNT(*) as c FROM http_events').get().c;
  }
}

// --- Marks ---

function insertMark(sessionId, label, tags) {
  const d = getDb();
  if (!sessionId) {
    const latest = getLatestSession();
    if (!latest) { const id = 'cli-' + Date.now(); startSession(id); sessionId = id; }
    else sessionId = latest.id;
  }
  return d.prepare('INSERT INTO marks (session_id, ts, label, tags) VALUES (?, ?, ?, ?)').run(
    sessionId, Date.now(), label, tags ? JSON.stringify(tags) : null
  ).lastInsertRowid;
}

function getMarks(sessionId, limit) {
  return getDb().prepare('SELECT * FROM marks WHERE session_id = ? ORDER BY ts DESC LIMIT ?').all(sessionId, limit || 50);
}

// --- WebSocket frames ---

let wsStmt;
let wsCount = 0;

function insertWsFrame(frame) {
  const d = getDb();
  if (!wsStmt) {
    wsStmt = d.prepare(`
      INSERT INTO ws_frames (session_id, ws_id, ts, request_id, url, direction, opcode, payload)
      VALUES (@session_id, @ws_id, @ts, @request_id, @url, @direction, @opcode, @payload)
    `);
  }
  wsStmt.run({
    session_id: frame.session_id,
    ws_id: frame.wsId || null,
    ts: frame.ts,
    request_id: frame.request_id ? String(frame.request_id).slice(0, 200) : null,
    url: frame.url ? frame.url.slice(0, 2000) : null,
    direction: frame.direction || null,
    opcode: frame.opcode != null ? frame.opcode : null,
    payload: frame.payload != null ? String(frame.payload).slice(0, 200000) : null,
  });
  wsCount++;
  if (wsCount >= MAX_WS_FRAMES && wsCount % 1000 === 0) {
    const keep = MAX_WS_FRAMES - 1000;
    d.prepare('DELETE FROM ws_frames WHERE id NOT IN (SELECT id FROM ws_frames ORDER BY id DESC LIMIT ?)').run(keep);
    wsCount = d.prepare('SELECT COUNT(*) as c FROM ws_frames').get().c;
  }
}

// --- SSE events ---

let sseStmt;
let sseCount = 0;

function insertSseEvent(event) {
  const d = getDb();
  if (!sseStmt) {
    sseStmt = d.prepare(`
      INSERT INTO sse_events (session_id, ws_id, ts, request_id, url, event_name, event_id, data)
      VALUES (@session_id, @ws_id, @ts, @request_id, @url, @event_name, @event_id, @data)
    `);
  }
  sseStmt.run({
    session_id: event.session_id,
    ws_id: event.wsId || null,
    ts: event.ts,
    request_id: event.request_id ? String(event.request_id).slice(0, 200) : null,
    url: event.url ? event.url.slice(0, 2000) : null,
    event_name: event.event_name || null,
    event_id: event.event_id ? String(event.event_id).slice(0, 200) : null,
    data: event.data != null ? String(event.data).slice(0, 200000) : null,
  });
  sseCount++;
  if (sseCount >= MAX_SSE_EVENTS && sseCount % 1000 === 0) {
    const keep = MAX_SSE_EVENTS - 1000;
    d.prepare('DELETE FROM sse_events WHERE id NOT IN (SELECT id FROM sse_events ORDER BY id DESC LIMIT ?)').run(keep);
    sseCount = d.prepare('SELECT COUNT(*) as c FROM sse_events').get().c;
  }
}

// --- Query ---

// url: prefixo 're:' vira REGEXP; senão substring LIKE (case-insensitive)
function urlCondition(field, value, params) {
  if (value.startsWith('re:')) {
    params['re_' + field] = value.slice(3);
    return field + ' REGEXP @re_' + field;
  }
  params['lk_' + field] = '%' + value + '%';
  return field + ' LIKE @lk_' + field + ' COLLATE NOCASE';
}

function markTs(sessionId, label, dir) {
  const row = getDb().prepare(
    'SELECT ts FROM marks WHERE session_id = ? AND label = ? ORDER BY ts ' + (dir === 'before' ? 'ASC' : 'DESC') + ' LIMIT 1'
  ).get(sessionId, label);
  return row ? row.ts : null;
}

function resolveMarks(opts, sessionId, params, conditions) {
  if (opts.after_mark) {
    const ts = markTs(sessionId, opts.after_mark, 'after');
    if (ts != null) { conditions.push('ts > @after_ts'); params.after_ts = ts; }
  }
  if (opts.before_mark) {
    const ts = markTs(sessionId, opts.before_mark, 'before');
    if (ts != null) { conditions.push('ts < @before_ts'); params.before_ts = ts; }
  }
}

function queryCdp(opts) {
  opts = opts || {};
  let sessionId = opts.session_id;
  if (!sessionId) {
    const latest = getLatestSession();
    if (latest) sessionId = latest.id;
    else return [];
  }

  const conditions = ['session_id = @session_id'];
  const params = { session_id: sessionId, limit: opts.limit || 50 };

  if (opts.domain) { conditions.push('domain = @domain'); params.domain = opts.domain; }
  if (opts.type) { conditions.push('type = @type'); params.type = opts.type; }
  if (opts.method) { conditions.push('method = @method'); params.method = opts.method; }
  if (opts.http_method) { conditions.push('http_method = @http_method COLLATE NOCASE'); params.http_method = opts.http_method; }
  if (opts.url) { conditions.push(urlCondition('url', opts.url, params)); }
  if (opts.status !== undefined) { conditions.push('status_code = @status'); params.status = opts.status; }
  if (opts.since) { conditions.push('ts >= @since'); params.since = opts.since; }
  resolveMarks(opts, sessionId, params, conditions);

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const results = getDb().prepare('SELECT * FROM cdp_events ' + where + ' ORDER BY ts DESC LIMIT @limit').all(params);

  return results.map(r => ({
    ...r,
    params: safeJson(r.params),
    result: safeJson(r.result),
  }));
}

function pageResult(table, where, params, opts) {
  const total = getDb().prepare('SELECT COUNT(*) as c FROM ' + table + ' ' + where).get(params).c;
  const offset = opts.offset || 0;
  const limit = opts.limit || 30;
  const rows = getDb().prepare('SELECT * FROM ' + table + ' ' + where + ' ORDER BY ts DESC LIMIT @limit OFFSET @offset')
    .all({ ...params, limit, offset });
  return {
    total_count: total,
    count: rows.length,
    offset,
    has_more: offset + rows.length < total,
    next_offset: offset + rows.length < total ? offset + rows.length : null,
    events: rows,
  };
}

function queryHttpEvents(opts) {
  opts = opts || {};
  let sessionId = opts.session_id;
  if (!sessionId) {
    const latest = getLatestSession();
    if (latest) sessionId = latest.id;
    else return pageResult('http_events', 'WHERE 0', {}, { limit: 30 });
  }

  const conditions = ['session_id = @session_id'];
  const params = { session_id: sessionId };

  if (opts.method) { conditions.push('method = @method COLLATE NOCASE'); params.method = opts.method; }
  if (opts.url) { conditions.push(urlCondition('url', opts.url, params)); }
  if (opts.status !== undefined) { conditions.push('status_code = @status'); params.status = opts.status; }
  if (opts.since) { conditions.push('ts >= @since'); params.since = opts.since; }
  resolveMarks(opts, sessionId, params, conditions);

  const result = pageResult('http_events', 'WHERE ' + conditions.join(' AND '), params, opts);
  result.events = result.events.map(r => ({
    ...r,
    request_headers: safeJson(r.request_headers),
    response_headers: safeJson(r.response_headers),
  }));
  return result;
}

function getByRequestId(requestId, sessionId) {
  let sid = sessionId;
  if (!sid) {
    const latest = getLatestSession();
    if (latest) sid = latest.id;
    else return [];
  }
  return getDb().prepare('SELECT * FROM cdp_events WHERE session_id = ? AND request_id = ? ORDER BY ts ASC').all(sid, String(requestId))
    .map(r => ({ ...r, params: safeJson(r.params), result: safeJson(r.result) }));
}

// HTTP consolidado + eventos CDP do mesmo request_id em uma call só
function getHttpByRequestId(requestId, sessionId) {
  let sid = sessionId;
  if (!sid) {
    const latest = getLatestSession();
    if (latest) sid = latest.id;
    else return null;
  }
  const http = getDb().prepare('SELECT * FROM http_events WHERE session_id = ? AND request_id = ? ORDER BY ts ASC')
    .all(sid, String(requestId))
    .map(r => ({ ...r, request_headers: safeJson(r.request_headers), response_headers: safeJson(r.response_headers) }));
  const cdp = getByRequestId(requestId, sid);
  return { request_id: String(requestId), http: http[0] || null, http_redirects: http, cdp_events: cdp };
}

function queryWsFrames(opts) {
  opts = opts || {};
  const sid = opts.session_id || (getLatestSession() ? getLatestSession().id : null);
  if (!sid) return { total_count: 0, count: 0, offset: 0, has_more: false, next_offset: null, frames: [] };

  const conditions = ['session_id = @session_id'];
  const params = { session_id: sid };
  if (opts.request_id) { conditions.push('request_id = @request_id'); params.request_id = opts.request_id; }
  if (opts.url) { conditions.push('url LIKE @url'); params.url = '%' + opts.url + '%'; }
  if (opts.direction) { conditions.push('direction = @direction'); params.direction = opts.direction; }
  if (opts.opcode !== undefined) { conditions.push('opcode = @opcode'); params.opcode = opts.opcode; }

  const where = 'WHERE ' + conditions.join(' AND ');
  const total = getDb().prepare('SELECT COUNT(*) as c FROM ws_frames ' + where).get(params).c;
  const offset = opts.offset || 0;
  const limit = opts.limit || 30;
  const rows = getDb().prepare('SELECT * FROM ws_frames ' + where + ' ORDER BY ts ASC LIMIT @limit OFFSET @offset')
    .all({ ...params, limit, offset });
  return {
    total_count: total,
    count: rows.length,
    offset,
    has_more: offset + rows.length < total,
    next_offset: offset + rows.length < total ? offset + rows.length : null,
    frames: rows,
  };
}

function querySseEvents(opts) {
  opts = opts || {};
  const sid = opts.session_id || (getLatestSession() ? getLatestSession().id : null);
  if (!sid) return { total_count: 0, count: 0, offset: 0, has_more: false, next_offset: null, events: [] };

  const conditions = ['session_id = @session_id'];
  const params = { session_id: sid };
  if (opts.request_id) { conditions.push('request_id = @request_id'); params.request_id = opts.request_id; }
  if (opts.url) { conditions.push('url LIKE @url'); params.url = '%' + opts.url + '%'; }
  if (opts.event_name) { conditions.push('event_name = @event_name'); params.event_name = opts.event_name; }

  const where = 'WHERE ' + conditions.join(' AND ');
  const total = getDb().prepare('SELECT COUNT(*) as c FROM sse_events ' + where).get(params).c;
  const offset = opts.offset || 0;
  const limit = opts.limit || 30;
  const rows = getDb().prepare('SELECT * FROM sse_events ' + where + ' ORDER BY ts ASC LIMIT @limit OFFSET @offset')
    .all({ ...params, limit, offset });
  return {
    total_count: total,
    count: rows.length,
    offset,
    has_more: offset + rows.length < total,
    next_offset: offset + rows.length < total ? offset + rows.length : null,
    events: rows,
  };
}

// fields: subset de ['params','result','method','url','response_body']; default = 4 campos originais
function searchCdp(opts) {
  opts = opts || {};
  let sessionId = opts.session_id;
  if (!sessionId) {
    const latest = getLatestSession();
    if (latest) sessionId = latest.id;
    else return [];
  }

  const validFields = ['params', 'result', 'method', 'url', 'response_body'];
  const fields = (opts.fields && opts.fields.length ? opts.fields : validFields.filter(f => f !== 'response_body'))
    .filter(f => validFields.indexOf(f) !== -1);
  if (!fields.length) return [];

  const conditions = ['session_id = @session_id'];
  const params = { session_id: sessionId, limit: opts.limit || 50 };
  if (opts.domain) { conditions.push('domain = @domain'); params.domain = opts.domain; }

  let searchClause;
  if (opts.regex) {
    conditions.push('(' + fields.map(f => f + ' REGEXP @pattern').join(' OR ') + ')');
    params.pattern = opts.query || '';
  } else {
    conditions.push('(' + fields.map(f => f + ' LIKE @pattern COLLATE NOCASE').join(' OR ') + ')');
    params.pattern = '%' + (opts.query || '') + '%';
  }

  const where = 'WHERE ' + conditions.join(' AND ');
  return getDb().prepare('SELECT * FROM cdp_events ' + where + ' ORDER BY ts DESC LIMIT @limit').all(params)
    .map(r => ({ ...r, params: safeJson(r.params), result: safeJson(r.result) }));
}

function parseUiText(text) {
  const m = /^\[cdp-ui\] (\[.*\])/.exec(text || '');
  return m ? safeJson(m[1]) : null;
}

// Mensagens [cdp-ui] da sessão, já com o payload JSON parseado
function queryUiEvents(opts) {
  opts = opts || {};
  let sessionId = opts.session_id;
  if (!sessionId) {
    const latest = getLatestSession();
    if (latest) sessionId = latest.id;
    else return { total_count: 0, count: 0, offset: 0, has_more: false, next_offset: null, events: [] };
  }

  const conditions = ["session_id = @session_id", "domain = 'Console'", "method = 'Console.messageAdded'", "params LIKE @tag"];
  const params = { session_id: sessionId, tag: '%[cdp-ui]%' };

  if (opts.ui_type) {
    // params guarda o JSON bruto, então o [cdp-ui] batch vem com aspas escapadas:
    // \"type\":\"click\" → pattern com backslash na frente da aspa.
    conditions.push('params LIKE @ui_type');
    params.ui_type = '%\\"type\\":\\"' + opts.ui_type + '\\"%';
  }
  resolveMarks(opts, sessionId, params, conditions);

  const where = 'WHERE ' + conditions.join(' AND ');
  const total = getDb().prepare('SELECT COUNT(*) as c FROM cdp_events ' + where).get(params).c;
  const offset = opts.offset || 0;
  const limit = opts.limit || 30;
  const rows = getDb().prepare('SELECT id, session_id, ts, params FROM cdp_events ' + where + ' ORDER BY ts DESC LIMIT @limit OFFSET @offset')
    .all({ ...params, limit, offset });

  const events = [];
  for (const r of rows) {
    const msg = safeJson(r.params);
    const text = msg && msg.message && msg.message.text;
    const batch = parseUiText(text);
    if (batch) events.push({ id: r.id, session_id: r.session_id, ts: r.ts, events: batch });
  }

  return {
    total_count: total,
    count: events.length,
    offset,
    has_more: offset + events.length < total,
    next_offset: offset + events.length < total ? offset + events.length : null,
    events,
  };
}

function getStats(sessionId) {
  if (!sessionId) {
    const latest = getLatestSession();
    if (latest) sessionId = latest.id;
    else return {};
  }
  const d = getDb();
  const lastTs = d.prepare('SELECT MAX(ts) as m FROM cdp_events WHERE session_id = ?').get(sessionId).m;
  return {
    session_id: sessionId,
    total_cdp_events: d.prepare('SELECT COUNT(*) as c FROM cdp_events WHERE session_id = ?').get(sessionId).c,
    total_http_events: d.prepare('SELECT COUNT(*) as c FROM http_events WHERE session_id = ?').get(sessionId).c,
    total_marks: d.prepare('SELECT COUNT(*) as c FROM marks WHERE session_id = ?').get(sessionId).c,
    last_event_ts: lastTs,
    console_ui_count: d.prepare("SELECT COUNT(*) as c FROM cdp_events WHERE session_id = ? AND domain = 'Console' AND params LIKE '%[cdp-ui]%'").get(sessionId).c,
    ws_frames: d.prepare('SELECT COUNT(*) as c FROM ws_frames WHERE session_id = ?').get(sessionId).c,
    sse_events: d.prepare('SELECT COUNT(*) as c FROM sse_events WHERE session_id = ?').get(sessionId).c,
    pending_marks: d.prepare('SELECT label, ts FROM marks WHERE session_id = ? ORDER BY ts DESC LIMIT 10').all(sessionId),
    domain_counts: d.prepare('SELECT domain, COUNT(*) as count FROM cdp_events WHERE session_id = ? AND domain IS NOT NULL GROUP BY domain ORDER BY count DESC').all(sessionId),
    top_urls: d.prepare('SELECT url, COUNT(*) as count FROM http_events WHERE session_id = ? AND url IS NOT NULL GROUP BY url ORDER BY count DESC LIMIT 20').all(sessionId),
    top_status: d.prepare('SELECT status_code, COUNT(*) as count FROM http_events WHERE session_id = ? AND status_code IS NOT NULL GROUP BY status_code ORDER BY count DESC').all(sessionId),
  };
}

function safeJson(val) {
  if (!val) return null;
  try { return JSON.parse(val); } catch { return val; }
}

function safeTruncate(val, maxLen) {
  if (!val) return null;
  try {
    var s = JSON.stringify(val);
    if (s.length <= maxLen) return s;
    return JSON.stringify({ _truncated: true, _size: s.length, preview: s.slice(0, maxLen) });
  } catch { return null; }
}

function updateCdpBody(requestId, body) {
  if (!requestId || !body) return;
  const rid = String(requestId).slice(0, 200);
  const b = String(body).slice(0, 200000);
  getDb().prepare('UPDATE cdp_events SET response_body = ? WHERE request_id = ? AND response_body IS NULL').run(b, rid);
  // backfill também no row consolidado (finalize acontece no loadingFinished,
  // então o body chega depois do INSERT do http_events)
  getDb().prepare('UPDATE http_events SET response_body = ? WHERE request_id = ? AND response_body IS NULL').run(b, rid);
}

function clearAll(sessionId) {
  const d = getDb();
  if (sessionId) {
    d.prepare('DELETE FROM cdp_events WHERE session_id = ?').run(sessionId);
    d.prepare('DELETE FROM http_events WHERE session_id = ?').run(sessionId);
    d.prepare('DELETE FROM marks WHERE session_id = ?').run(sessionId);
    d.prepare('DELETE FROM ws_frames WHERE session_id = ?').run(sessionId);
    d.prepare('DELETE FROM sse_events WHERE session_id = ?').run(sessionId);
  } else {
    d.prepare('DELETE FROM cdp_events').run();
    d.prepare('DELETE FROM http_events').run();
    d.prepare('DELETE FROM marks').run();
    d.prepare('DELETE FROM ws_frames').run();
    d.prepare('DELETE FROM sse_events').run();
  }
  cdpCount = d.prepare('SELECT COUNT(*) as c FROM cdp_events').get().c;
  httpCount = d.prepare('SELECT COUNT(*) as c FROM http_events').get().c;
  wsCount = d.prepare('SELECT COUNT(*) as c FROM ws_frames').get().c;
  sseCount = d.prepare('SELECT COUNT(*) as c FROM sse_events').get().c;
}

module.exports = {
  DB_PATH,
  open,
  close,
  getDb,
  startSession,
  endSession,
  incrementConnections,
  decrementConnections,
  getLatestSession,
  getSessions,
  insertCdpEvent,
  insertHttpEvent,
  updateCdpBody,
  insertWsFrame,
  insertSseEvent,
  insertMark,
  getMarks,
  queryCdp,
  queryHttpEvents,
  queryUiEvents,
  queryWsFrames,
  querySseEvents,
  getByRequestId,
  getHttpByRequestId,
  searchCdp,
  getStats,
  clearAll,
};
