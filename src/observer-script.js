// Injected into every page via Page.addScriptToEvaluateOnNewDocument.
// Observes clicks, inputs, and DOM mutations, emits structured JSON via console.log.
(function () {
  if (window.__cdp_ui_observer__) return;
  window.__cdp_ui_observer__ = true;

  var tag = '[cdp-ui]';
  var buf = [];
  var timer = null;
  var MAX_BATCH = 60;
  var FLUSH_MS = 250;

  function flush() {
    if (buf.length === 0) return;
    var batch = buf.splice(0, MAX_BATCH);
    console.log(tag + ' ' + JSON.stringify(batch));
  }

  function enqueue(ev) {
    buf.push(ev);
    if (!timer) timer = setTimeout(function () { timer = null; flush(); }, FLUSH_MS);
    if (buf.length >= MAX_BATCH) { clearTimeout(timer); timer = null; flush(); }
  }

  // --- Helpers ---

  function ellipsis(s, n) {
    if (!s) return '';
    s = String(s);
    return s.length > n ? s.slice(0, n) + '...' : s;
  }

  function visibleText(el) {
    return ellipsis((el.textContent || '').replace(/\s+/g, ' ').trim(), 120);
  }

  function getSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return '';
    var tag = (el.tagName || '').toLowerCase();
    var id = el.id ? '#' + el.id : '';
    var cls = '';
    if (el.classList && el.classList.length > 0) {
      var parts = [];
      for (var i = 0; i < Math.min(el.classList.length, 3); i++) {
        parts.push(el.classList[i]);
      }
      cls = '.' + parts.join('.');
    }
    return tag + id + cls;
  }

  function shouldSkip(el) {
    if (!el || !el.tagName) return true;
    var t = el.tagName.toLowerCase();
    return t === 'script' || t === 'style' || t === 'link' || t === 'meta' ||
           t === 'svg' || t === 'path' || t === 'g' || t === 'br' || t === 'hr' ||
           t === 'head' || t === 'title' || t === 'noscript';
  }

  function hasSemantics(el) {
    if (!el) return false;
    return !!(el.id || (el.classList && el.classList.length > 0) ||
              visibleText(el) || el.getAttribute('role') ||
              el.getAttribute('aria-expanded') !== null ||
              el.getAttribute('aria-hidden') !== null ||
              el.getAttribute('disabled') !== null ||
              el.getAttribute('hidden') !== null);
  }

  function describe(el) {
    if (!el) return null;
    return {
      tag: (el.tagName || '').toLowerCase(),
      id: el.id || '',
      sel: getSelector(el),
      text: visibleText(el),
    };
  }

  function parentPath(el, depth) {
    depth = depth || 4;
    var parts = [];
    var cur = el;
    while (cur && depth-- > 0) {
      parts.unshift(getSelector(cur) || cur.tagName.toLowerCase());
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // --- Event listeners ---

  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || shouldSkip(el) || !hasSemantics(el)) return;
    enqueue({ t: Date.now(), type: 'click', d: { el: describe(el), path: parentPath(el) } });
  }, true);

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || shouldSkip(el)) return;
    var val = '';
    try {
      if (el.type === 'password') val = '***';
      else if (el.tagName === 'SELECT') {
        val = el.options && el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : el.value;
      } else val = el.value;
    } catch (e) { val = '?'; }
    enqueue({ t: Date.now(), type: 'input', d: {
      el: describe(el),
      tag: (el.tagName || '').toLowerCase(),
      type: el.type || '',
      value: ellipsis(val, 200),
    }});
  }, true);

  // --- DOM mutations ---

  function recordMutation(type, el, extra) {
    if (!el || shouldSkip(el)) return;
    if (!hasSemantics(el)) return;
    var ev = { t: Date.now(), type: type, d: { el: describe(el), path: parentPath(el) } };
    if (extra) Object.assign(ev.d, extra);
    enqueue(ev);
  }

  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];

      // Child list
      if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length; j++) {
          recordMutation('dom-add', m.addedNodes[j]);
          // Also walk descendants (max 2 levels) for meaningful children
          if (m.addedNodes[j].querySelectorAll) {
            var children = m.addedNodes[j].querySelectorAll('[id],[class],[role],[aria-expanded],[aria-hidden],[disabled],[hidden]');
            for (var k = 0; k < Math.min(children.length, 10); k++) {
              recordMutation('dom-add', children[k]);
            }
          }
        }
        for (var jj = 0; jj < m.removedNodes.length; jj++) {
          recordMutation('dom-remove', m.removedNodes[jj]);
        }
      }

      // Attributes
      if (m.type === 'attributes') {
        var attr = m.attributeName;
        if (attr === 'class' || attr === 'style' || attr === 'disabled' ||
            attr === 'hidden' || attr === 'aria-expanded' || attr === 'aria-hidden') {
          recordMutation('dom-attr', m.target, { attr: attr, val: m.target.getAttribute(attr) || '' });
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-expanded', 'aria-hidden'],
  });

  flush();
})();
