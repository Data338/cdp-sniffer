#!/usr/bin/env node
const crypto = require('crypto');
const http = require('http');
const db = require('./src/db');
const { createProxy } = require('./src/proxy');

const CHROME_PORT = parseInt(process.env.CDP_CHROME_PORT || '9222');
const PROXY_PORT = parseInt(process.env.CDP_PROXY_PORT || '9223');
const SESSION_ID = crypto.randomUUID().slice(0, 8);

var CLI = ['query', 'query-http', 'get-http', 'search', 'stats', 'ui', 'marks', 'mark', 'clear', 'sessions', 'status', 'watch', 'query-ws', 'query-sse']
  .some(function (c) { return process.argv.includes(c); }) ||
  process.argv.includes('--help') || process.argv.includes('-h');

if (CLI) {
  db.open();
  runCli().then(function () { db.close(); process.exit(0); }).catch(function (e) {
    console.error(e.message);
    db.close();
    process.exit(1);
  });
  return;
}

// === Daemon mode ===

function checkCDP(port) {
  return new Promise(function (resolve) {
    var req = http.get('http://127.0.0.1:' + port + '/json/version', function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () { resolve(body.includes('webSocketDebuggerUrl')); });
    });
    req.on('error', function () { resolve(false); });
    req.setTimeout(2000, function () { req.destroy(); resolve(false); });
  });
}

async function start() {
  var chromeOk = await checkCDP(CHROME_PORT);
  if (!chromeOk) {
    console.error('\x1b[91mChrome not running on :' + CHROME_PORT + '\x1b[0m');
    console.error('Start Chrome: google-chrome --remote-debugging-port=' + CHROME_PORT);
    console.error('Or use: sniffer-start');
    process.exit(1);
  }

  db.open();
  db.startSession(SESSION_ID);

  createProxy(PROXY_PORT, CHROME_PORT, {
    onCdpEvent: function (e) { db.insertCdpEvent(e); },
    onHttpEvent: function (e) { db.insertHttpEvent(e); },
    onResponseBody: function (requestId, body) { db.updateCdpBody(requestId, body); },
    onWsFrame: function (e) { db.insertWsFrame(e); },
    onSseEvent: function (e) { db.insertSseEvent(e); },
    onWsConnect: function () { db.incrementConnections(SESSION_ID); },
    onWsClose: function () { db.decrementConnections(SESSION_ID); },
    sessionId: SESSION_ID,
  });

  console.log('\n\x1b[1m\x1b[96mcdp-sniffer\x1b[0m  session: ' + SESSION_ID);
  console.log('  Chrome :' + CHROME_PORT + '  →  Proxy :' + PROXY_PORT);
  console.log('  DB     : ' + db.DB_PATH);
  console.log('\n  sniffer query --domain Network --last 10');
  console.log('  sniffer stats');
  console.log('  Ctrl+C to stop\n');

  function cleanup() {
    console.log('\n\x1b[90mShutting down...\x1b[0m');
    db.endSession(SESSION_ID);
    db.close();
    setTimeout(function () { process.exit(0); }, 500);
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('uncaughtException', function (e) {
    console.error('\n\x1b[91mFATAL:\x1b[0m', e.message);
    db.close();
    setTimeout(function () { process.exit(1); }, 500);
  });
}

start().catch(function (e) {
  console.error('Fatal:', e.message);
  db.close();
  process.exit(1);
});

// === CLI ===

function parseArgs(argv) {
  var opts = {};
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--domain' && argv[i + 1]) { opts.domain = argv[++i]; continue; }
    if (argv[i] === '--method' && argv[i + 1]) { opts.http_method = argv[++i]; continue; }
    if (argv[i] === '--type' && argv[i + 1]) { opts.type = argv[++i]; continue; }
    if (argv[i] === '--url' && argv[i + 1]) { opts.url = argv[++i]; continue; }
    if (argv[i] === '--url-re' && argv[i + 1]) { opts.url = 're:' + argv[++i]; continue; }
    if (argv[i] === '--fields' && argv[i + 1]) { opts.fields = argv[++i].split(','); continue; }
    if (argv[i] === '--regex') { opts.regex = true; continue; }
    if (argv[i] === '--ui-type' && argv[i + 1]) { opts.ui_type = argv[++i]; continue; }
    if (argv[i] === '--after-mark' && argv[i + 1]) { opts.after_mark = argv[++i]; continue; }
    if (argv[i] === '--before-mark' && argv[i + 1]) { opts.before_mark = argv[++i]; continue; }
    if (argv[i] === '--since' && argv[i + 1]) { opts.since = parseInt(argv[++i]); continue; }
    if (argv[i] === '--status' && argv[i + 1]) { opts.status = parseInt(argv[++i]); continue; }
    if (argv[i] === '--last' && argv[i + 1]) { opts.limit = parseInt(argv[++i]); continue; }
    if (argv[i] === '--offset' && argv[i + 1]) { opts.offset = parseInt(argv[++i]); continue; }
    if (argv[i] === '--request-id' && argv[i + 1]) { opts.request_id = argv[++i]; continue; }
    if (argv[i] === '--direction' && argv[i + 1]) { opts.direction = argv[++i]; continue; }
    if (argv[i] === '--opcode' && argv[i + 1]) { opts.opcode = parseInt(argv[++i]); continue; }
    if (argv[i] === '--event-name' && argv[i + 1]) { opts.event_name = argv[++i]; continue; }
    if (argv[i] === '--tags' && argv[i + 1]) { opts.tags = argv[++i].split(','); continue; }
    if (argv[i] === '--timeout' && argv[i + 1]) { opts.timeout = parseInt(argv[++i]); continue; }
    if (argv[i] === '--session' && argv[i + 1]) { opts.session = argv[++i]; continue; }
  }
  return opts;
}

function printHelp() {
  console.log('cdp-sniffer CLI');
  console.log('  sniffer query   [--domain X] [--method GET] [--url pat] [--url-re regex] [--status N] [--after-mark L] [--before-mark L] [--last N]');
  console.log('  sniffer query-http  [--method GET] [--url pat] [--url-re regex] [--status N] [--after-mark L] [--last N]  (HTTP consolidado)');
  console.log('  sniffer get-http <request_id>                                          (1 request HTTP completo + redirect chain)');
  console.log('  sniffer search  <term> [--fields params,response_body] [--regex]       (free-text / regex)');
  console.log('  sniffer ui      [--ui-type click|input] [--after-mark L]               (clicks, inputs, DOM mutations)');
  console.log('  sniffer stats');
  console.log('  sniffer mark    <label> [--tags a,b]');
  console.log('  sniffer marks                                                          (últimos marks)');
  console.log('  sniffer watch   [--domain X] [--url pat] [--timeout ms]');
  console.log('  sniffer query-ws  [--url pat] [--request-id id] [--direction sent|received] [--opcode N] [--last N]');
  console.log('  sniffer query-sse [--url pat] [--request-id id] [--event-name name] [--last N]');
  console.log('  sniffer clear');
  console.log('  sniffer sessions');
  console.log('  sniffer status');
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function runCli() {
  var args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return;
  }

  var cmd = args[0];
  var rest = args.slice(1);
  var opts = parseArgs(rest);

  switch (cmd) {
    case 'status': {
      var s = db.getLatestSession();
      console.log(JSON.stringify({
        db: db.DB_PATH,
        latest_session: s ? s.id : null,
        started: s ? s.started_at : null,
        ws_connections: s ? s.ws_connections : 0,
      }, null, 2));
      break;
    }

    case 'query': {
      var events = db.queryCdp({
        domain: opts.domain,
        type: opts.type,
        http_method: opts.http_method,
        url: opts.url,
        status: opts.status,
        since: opts.since,
        after_mark: opts.after_mark,
        before_mark: opts.before_mark,
        limit: opts.limit || 50,
        session_id: opts.session,
      });
      console.log(JSON.stringify({ count: events.length, events: events }, null, 2));
      break;
    }

    case 'query-http': {
      var http = db.queryHttpEvents({
        method: opts.http_method,
        url: opts.url,
        status: opts.status,
        since: opts.since,
        after_mark: opts.after_mark,
        before_mark: opts.before_mark,
        limit: opts.limit || 30,
        offset: opts.offset,
        session_id: opts.session,
      });
      console.log(JSON.stringify(http, null, 2));
      break;
    }

    case 'get-http': {
      var rid = rest[0];
      if (!rid) { console.log('Usage: sniffer get-http <request_id>'); return; }
      var r = db.getHttpByRequestId(rid, opts.session);
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    case 'ui': {
      var ui = db.queryUiEvents({
        ui_type: opts.ui_type,
        after_mark: opts.after_mark,
        before_mark: opts.before_mark,
        limit: opts.limit || 30,
        offset: opts.offset,
        session_id: opts.session,
      });
      console.log(JSON.stringify(ui, null, 2));
      break;
    }

    case 'marks': {
      var sid2 = opts.session || (db.getLatestSession() ? db.getLatestSession().id : null);
      console.log(JSON.stringify(db.getMarks(sid2, opts.limit || 20), null, 2));
      break;
    }

    case 'search': {
      var query = rest[0] || '';
      var results = db.searchCdp({ query: query, domain: opts.domain, fields: opts.fields, regex: opts.regex, limit: opts.limit || 50, session_id: opts.session });
      console.log(JSON.stringify({ query: query, count: results.length, results: results }, null, 2));
      break;
    }

    case 'stats': {
      console.log(JSON.stringify(db.getStats(opts.session), null, 2));
      break;
    }

    case 'mark': {
      var label = rest[0];
      if (!label) { console.log('Usage: sniffer mark <label> [--tags a,b]'); return; }
      var sid = opts.session || (db.getLatestSession() ? db.getLatestSession().id : null);
      var id = db.insertMark(sid, label, opts.tags);
      console.log(JSON.stringify({ id: id, label: label, ok: true }));
      break;
    }

    case 'sessions': {
      console.log(JSON.stringify(db.getSessions(20), null, 2));
      break;
    }

    case 'clear': {
      db.clearAll(opts.session);
      console.log(JSON.stringify({ ok: true }));
      break;
    }

    case 'watch': {
      var timeout = opts.timeout || 30000;
      var deadline = Date.now() + timeout;
      var limit = opts.limit || 1;
      console.log('Watching for ' + limit + '+ events (timeout ' + (timeout / 1000) + 's)...');
      while (Date.now() < deadline) {
        var events = db.queryCdp({
          domain: opts.domain,
          type: opts.type,
          url: opts.url,
          limit: 100,
          session_id: opts.session,
        });
        if (events.length >= limit) {
          console.log(JSON.stringify({ found: events.length, timed_out: false, events: events.slice(0, limit) }, null, 2));
          return;
        }
        await sleep(500);
      }
      console.log(JSON.stringify({ found: 0, timed_out: true }));
      break;
    }

    case 'query-ws': {
      var frames = db.queryWsFrames({
        request_id: opts.request_id,
        url: opts.url,
        direction: opts.direction,
        opcode: opts.opcode,
        limit: opts.limit || 30,
        offset: opts.offset,
        session_id: opts.session,
      });
      console.log(JSON.stringify(frames, null, 2));
      break;
    }

    case 'query-sse': {
      var sse = db.querySseEvents({
        request_id: opts.request_id,
        url: opts.url,
        event_name: opts.event_name,
        limit: opts.limit || 30,
        offset: opts.offset,
        session_id: opts.session,
      });
      console.log(JSON.stringify(sse, null, 2));
      break;
    }

    default:
      console.log('Unknown: ' + cmd);
      printHelp();
  }
}
