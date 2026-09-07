// kwin-place-sniffer.js — KWin one-shot script loaded via D-Bus.
// Waits for the "cdp-sniffer-chrome" window (launched by sniffer-start with
// --class=cdp-sniffer-chrome) and moves it to the virtual desktop where the
// opencode terminal (ghostty) lives. Self-unloads after placement or timeout.
//
// Wayland facts (verified on KWin 6.7.4 + Chrome 149, native Wayland):
//   - Chromium sets xdg_toplevel app_id = --class value (source:
//     chrome/browser/ui/views/frame/browser_native_widget_aura_linux.cc →
//     wayland_app_id = wm_class_class; shell_integration_linux.cc →
//     GetProgramClassClass() reads switches::kWmClass).
//   - KWin XdgToplevelWindow::handleAppIdChanged() → resourceClass = app_id,
//     desktopFileName = app_id. resourceName is NOT influenced by --class.
//
// Failure modes fixed vs the original version:
//   1. callDBus(selfUnload) was missing the interface argument and silently
//      failed (script leaked, never unloaded).
//   2. windowAdded can fire before the client commits set_app_id; the old
//      one-shot check then missed the window forever. We now re-check on
//      windowClassChanged AND poll the whole window list every SCAN_MS.
//   3. With several ghostty windows open, "first ghostty" could be the wrong
//      desktop. Preference order: ghostty whose caption starts with
//      TERMINAL_CAPTION_PREFIX (opencode sets "OC | ..."), then any ghostty.
//      Fallback: workspace.currentDesktop at load time (reasonable when the
//      launcher ran interactively from that terminal).

var PLUGIN = 'cdp-sniffer-place'
var TIMEOUT_MS = 15000
var SCAN_MS = 500
var MOVE_DELAY_MS = 400

var MATCH_CLASS = 'cdp-sniffer-chrome'
var MATCH_CAPTION = '' // optional extra safety net, e.g. 'CDP-SNIFFER'
var TERMINAL_CLASS = 'com.mitchellh.ghostty'
var TERMINAL_CAPTION_PREFIX = 'OC |'

var done = false
var scheduled = false
var pending = []

function log(msg) {
  print('[cdp-sniffer-place] ' + msg)
}

function selfUnload() {
  try {
    callDBus('org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting',
      'unloadScript', PLUGIN)
  } catch (e) {}
}

function finish(reason) {
  if (done) return
  done = true
  log('done: ' + reason)
  selfUnload()
}

function findTargetDesktop() {
  var wins = workspace.windowList()
  var i, w, cap
  // 1) ghostty running opencode (caption heuristic)
  for (i = 0; i < wins.length; i++) {
    w = wins[i]
    if (String(w.resourceClass || '') !== TERMINAL_CLASS) continue
    cap = String(w.caption || '')
    if (TERMINAL_CAPTION_PREFIX !== '' &&
        cap.indexOf(TERMINAL_CAPTION_PREFIX) !== 0) continue
    if (w.desktops && w.desktops.length > 0) return w.desktops[0]
  }
  // 2) any ghostty
  for (i = 0; i < wins.length; i++) {
    w = wins[i]
    if (String(w.resourceClass || '') !== TERMINAL_CLASS) continue
    if (w.desktops && w.desktops.length > 0) return w.desktops[0]
  }
  // 3) current desktop (launcher usually runs from the focused terminal)
  return workspace.currentDesktop || null
}

function isTargetWindow(win) {
  var rc = String(win.resourceClass || '')
  var dfn = String(win.desktopFileName || '')
  if (rc === MATCH_CLASS || dfn === MATCH_CLASS) return true
  if (MATCH_CAPTION !== '' &&
      String(win.caption || '').indexOf(MATCH_CAPTION) !== -1 &&
      rc.toLowerCase().indexOf('chrome') !== -1) return true
  return false
}

function scheduleMove(win) {
  if (done || scheduled) return
  scheduled = true
  var target = findTargetDesktop()
  if (target === null) {
    scheduled = false
    return
  }
  var w = win
  var t = new QTimer()
  t.singleShot = true
  t.interval = MOVE_DELAY_MS
  t.timeout.connect(function () {
    try {
      w.desktops = [target]
      var on = []
      for (var i = 0; i < w.desktops.length; i++) on.push(w.desktops[i].x11DesktopNumber)
      log('moved "' + w.caption + '" to desktop ' + target.x11DesktopNumber +
          ' (readback: ' + on.join(',') + ')')
      finish('placed')
    } catch (e) {
      scheduled = false
      log('move failed: ' + e + ' — will retry on next scan')
    }
  })
  t.start()
}

function consider(win) {
  if (done || !win) return
  if (isTargetWindow(win)) {
    var idx = pending.indexOf(win)
    if (idx !== -1) pending.splice(idx, 1)
    scheduleMove(win)
    return
  }
  // Might become the target once the client commits set_app_id: watch.
  if (pending.indexOf(win) === -1 && win.normalWindow) {
    pending.push(win)
    try {
      win.windowClassChanged.connect(function () {
        if (isTargetWindow(win)) scheduleMove(win)
      })
    } catch (e) {}
  }
}

workspace.windowAdded.connect(consider)

// Poll: covers windows that existed before the "windowClassChanged" hook was
// attached and any missed signal paths.
var scan = new QTimer()
scan.interval = SCAN_MS
scan.timeout.connect(function () {
  if (done) return
  var wins = workspace.windowList()
  for (var i = 0; i < wins.length; i++) consider(wins[i])
})
scan.start()

// Safety net: unload if Chrome never appears.
var guard = new QTimer()
guard.singleShot = true
guard.interval = TIMEOUT_MS
guard.timeout.connect(function () { finish('timeout') })
guard.start()

log('loaded; waiting for ' + MATCH_CLASS + ' window')
