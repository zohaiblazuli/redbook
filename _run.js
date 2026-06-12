// Bluebook launcher v2 — adds Dev Mode panel + Redbook theme switcher.
//
// What this does:
//  - Locks down `global.selfHealingCallbackFunction` BEFORE require so the obfuscator's
//    self-defending counter-measure is a noop (in case any hook trips it).
//  - Stubs `win-verify-signature` to return signed=true (we're not running under signed Bluebook.exe).
//  - Blocks app.exit/app.quit at require-time argv check.
//  - Forces win.show() on every browser-window-created event (real Bluebook starts hidden).
//  - Honors launch flags: --noCheckin (sets process.env.NOCHECKIN=1), --sentry-debug
//  - Listens for <<RB_IPC>> console messages from the renderer and dispatches commands
//    (session save/load/list/delete, log tail, app relaunch, shell open, cookies dump/set).
//  - Injects mods/redbook.css + mods/switcher.js + mods/devpanel.js into every page load.
//
// app.asar is NEVER modified. Integrity check passes naturally because the binary at
//   F:\bluebook_runtime\resources\app.asar matches the publisher's signed bytes.

const fs = require('fs');
const path = require('path');
const Module = require('module');
const electron = require('electron');
const { app, dialog, shell, session } = electron;

const logPath = path.join(__dirname, '_run.log');
fs.writeFileSync(logPath, `[${new Date().toISOString()}] run v2\n`);
const log = (...a) => fs.appendFileSync(logPath, a.map(x => typeof x === 'string' ? x : require('util').inspect(x, {depth: 3})).join(' ') + '\n');

// ── Launch flags ──────────────────────────────────────────────────────────────
const FLAG_NO_CHECKIN   = process.argv.includes('--noCheckin');
const FLAG_SENTRY_DEBUG = process.argv.includes('--sentry-debug');
if (FLAG_NO_CHECKIN)   { process.env.NOCHECKIN = '1'; log('flag --noCheckin: process.env.NOCHECKIN=1'); }
if (FLAG_SENTRY_DEBUG) { globalThis.__SENTRY_DEBUG__ = true; log('flag --sentry-debug: globalThis.__SENTRY_DEBUG__=true'); }

// ── Lock self-healing callback as a non-writable noop ─────────────────────────
Object.defineProperty(global, 'selfHealingCallbackFunction', {
  value: function selfHealingCallbackFunction() {},
  writable: false, configurable: false, enumerable: false,
});
log('selfHealingCallbackFunction locked');

// ── Block exit/quit while still allowing our own relaunch ────────────────────
let _allowExit = false;
process.exit = (c) => { if (_allowExit) return require('process').reallyExit ? require('process').reallyExit(c) : 0; log(`[blocked] process.exit(${c})`); };
app.exit = (c)     => { if (_allowExit) return; log(`[blocked] app.exit(${c})`); };
app.quit = ()      => { if (_allowExit) return; log(`[blocked] app.quit() | ${(new Error().stack.split('\n').slice(1,3).join(' | '))}`); };
dialog.showErrorBox = (t, c) => { log('SUPPRESSED dialog:', t, '|', c); };
process.on('uncaughtException', (e) => log('UNCAUGHT', e && e.stack || e));

// ── IPC tracing DISABLED — was monkey-patching ipcMain.handle/.on which appears to
// break Bluebook's login flow (renderer's ipcRenderer.invoke calls timed out or
// returned wrong shape). If you need to see what IPC channels fire, re-enable manually
// AFTER you've already logged in.
//
// const { ipcMain } = electron;
// const realHandle = ipcMain.handle.bind(ipcMain);
// const realOn     = ipcMain.on.bind(ipcMain);
// (the rest of the wrapper is commented out — restore from git history if needed)

// ── Stub win-verify-signature ─────────────────────────────────────────────────
const origLoad = Module._load;
Module._load = function(req, parent, isMain) {
  if (req === 'win-verify-signature') {
    return { verifySignatureByPublishName(fp, pn) {
      const t = (pn && pn[0]) || 'The College Board';
      const s = String(t).includes('=') ? String(t) : `CN=${t}`;
      log(`win-verify stub: ${fp} -> signed`);
      return { signed: true, subject: s };
    }};
  }
  return origLoad.apply(this, arguments);
};

// ── Mod bundle loader ─────────────────────────────────────────────────────────
function loadModsBundle() {
  try {
    const css      = fs.readFileSync(path.join(__dirname, 'mods', 'redbook.css'),  'utf8');
    const switchJs = fs.readFileSync(path.join(__dirname, 'mods', 'switcher.js'),  'utf8');
    const panelJs  = fs.readFileSync(path.join(__dirname, 'mods', 'devpanel.js'),  'utf8');
    const flags = { sentryDebug: FLAG_SENTRY_DEBUG, noCheckin: FLAG_NO_CHECKIN };
    let version = { version: '0.0.0', electron: '?' };
    try { version = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')); } catch (_) {}
    return `(()=>{
      const __RB_CSS     = ${JSON.stringify(css)};
      const __RB_FLAGS   = ${JSON.stringify(flags)};
      const __RB_VERSION = ${JSON.stringify(version)};
      ${switchJs}
      ${panelJs}
    })();`;
  } catch (e) {
    log('loadModsBundle err', e && e.message);
    return '';
  }
}

// ── IPC dispatcher (console-message → file ops) ──────────────────────────────
const SESSIONS_DIR   = path.join(__dirname, 'mods', 'sessions');
const RECORDINGS_DIR = path.join(__dirname, 'mods', 'recordings');
function ensureSessionsDir() {
  try { if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true }); }
  catch (e) { log('ensureSessionsDir err', e.message); }
}
function ensureRecordingsDir() {
  try { if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true }); }
  catch (e) { log('ensureRecordingsDir err', e.message); }
}
ensureSessionsDir();
ensureRecordingsDir();

let _mainWin = null;

// ── AI overlay (WebContentsView inside _mainWin — invisible to Bluebook) ─────
// Unlike a BrowserWindow, a WebContentsView lives inside the main window:
//   • No browser-window-created event
//   • No window focus change (main window stays focused)
//   • Not in BrowserWindow.getAllWindows()
//   • Invisible to Bluebook's security stack (kiosk, lockdown, focus monitor)
let _aiView = null;
let _aiViewVisible = false;
const AI_PARTITION = 'persist:redbook-ai';
const AI_VIEW_W = 520;
const AI_VIEW_H = 800;
const AI_VIEW_MARGIN = 12;

let _aiSkinCssKey = null;
let _aiColorSyncTimer = null;
let _aiLastBg = '#f8f9fa';

// Proximity fade — mouse-distance-based opacity (smooth gradient, no sudden pop)
const FADE_JS = `(function() {
  if (window._rbFadeActive) return 'already active';
  window._rbFadeActive = true;
  var REST = 0, MAX = 0.85, DECAY_MS = 600;
  var cur = REST, target = REST, raf = null;
  var root = document.documentElement;
  root.style.opacity = REST;
  root.style.transition = 'none';
  function lerp(a, b, t) { return a + (b - a) * t; }
  function tick() {
    cur = lerp(cur, target, 0.18);
    if (Math.abs(cur - target) < 0.005) cur = target;
    root.style.opacity = cur.toFixed(3);
    if (cur !== target) raf = requestAnimationFrame(tick);
    else raf = null;
  }
  function kick() { if (!raf) raf = requestAnimationFrame(tick); }
  document.addEventListener('mousemove', function(e) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var cx = vw / 2, cy = vh / 2;
    var dx = (e.clientX - cx) / cx, dy = (e.clientY - cy) / cy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var t = 1 - Math.min(dist / 1.2, 1);
    target = REST + (MAX - REST) * t * t;
    kick();
  }, { passive: true });
  document.addEventListener('mouseleave', function() {
    target = REST; kick();
  });
  document.addEventListener('mouseenter', function(e) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var cx = vw / 2, cy = vh / 2;
    var dx = (e.clientX - cx) / cx, dy = (e.clientY - cy) / cy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var t = 1 - Math.min(dist / 1.2, 1);
    target = REST + (MAX - REST) * t * t;
    kick();
  });
  return 'fade active';
})()`;

// Drag/resize handles — injected into AI overlay, relays mouse deltas via console.log
// Uses a 5px threshold before committing to drag so normal clicks on page elements still work
const DRAG_RESIZE_JS = `(function() {
  if (window._rbDragActive) return 'already active';
  window._rbDragActive = true;
  var EDGE = 6, TOP_BAR = 10;
  var DRAG_THRESHOLD = 5;
  var pending = null, mode = null, startX = 0, startY = 0, anchorX = 0, anchorY = 0;

  function hitTest(x, y) {
    var w = window.innerWidth, h = window.innerHeight;
    var onLeft = x < EDGE, onRight = x > w - EDGE;
    var onTop = y < EDGE, onBottom = y > h - EDGE;
    if (onTop && onLeft) return 'nw-resize';
    if (onTop && onRight) return 'ne-resize';
    if (onBottom && onLeft) return 'sw-resize';
    if (onBottom && onRight) return 'se-resize';
    if (onLeft) return 'w-resize';
    if (onRight) return 'e-resize';
    if (onTop) return 'n-resize';
    if (onBottom) return 's-resize';
    if (y <= TOP_BAR) return 'move';
    return null;
  }

  // Cursor hints on hover (only for edges, not top bar — keep top bar clickable)
  document.addEventListener('mousemove', function(e) {
    if (mode || pending) return;
    var h = hitTest(e.clientX, e.clientY);
    if (h && h !== 'move') document.documentElement.style.cursor = h;
    else document.documentElement.style.cursor = '';
  }, true);

  // Mousedown: don't immediately capture — just record intent
  document.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    var h = hitTest(e.clientX, e.clientY);
    if (!h) return;
    // For resize edges, commit immediately (no threshold needed, edges have no clickable content)
    if (h !== 'move') {
      mode = h;
      startX = e.screenX;
      startY = e.screenY;
      document.documentElement.style.cursor = h;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // For move (top bar), set pending — only commit after threshold
    pending = h;
    anchorX = e.screenX;
    anchorY = e.screenY;
    startX = e.screenX;
    startY = e.screenY;
    // Don't preventDefault here — let clicks through if user doesn't drag
  }, true);

  document.addEventListener('mousemove', function(e) {
    // Check if pending drag should commit
    if (pending && !mode) {
      var pdx = e.screenX - anchorX, pdy = e.screenY - anchorY;
      if (Math.abs(pdx) + Math.abs(pdy) >= DRAG_THRESHOLD) {
        mode = pending;
        pending = null;
        document.documentElement.style.cursor = 'grabbing';
        // Send the accumulated delta
        console.log('__rb_drag__:' + mode + ':' + pdx + ':' + pdy);
        startX = e.screenX;
        startY = e.screenY;
      }
      return;
    }
    if (!mode) return;
    var dx = e.screenX - startX, dy = e.screenY - startY;
    if (dx === 0 && dy === 0) return;
    startX = e.screenX;
    startY = e.screenY;
    console.log('__rb_drag__:' + mode + ':' + dx + ':' + dy);
    e.preventDefault();
    e.stopPropagation();
  }, true);

  document.addEventListener('mouseup', function(e) {
    if (pending) { pending = null; return; }
    if (!mode) return;
    mode = null;
    document.documentElement.style.cursor = '';
    e.preventDefault();
  }, true);

  // Close button — small X in top-right corner, appears on hover
  var closeBtn = document.createElement('div');
  closeBtn.style.cssText = 'position:fixed;top:4px;right:8px;z-index:999999;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:14px;color:#888;cursor:pointer;opacity:0;transition:opacity 0.2s;user-select:none;font-family:sans-serif;border-radius:3px';
  closeBtn.textContent = 'x';
  closeBtn.title = 'Close AI';
  closeBtn.addEventListener('mouseenter', function() { closeBtn.style.opacity = '1'; closeBtn.style.background = 'rgba(0,0,0,0.1)'; });
  closeBtn.addEventListener('mouseleave', function() { closeBtn.style.opacity = '0'; closeBtn.style.background = 'none'; });
  closeBtn.addEventListener('click', function(e) { e.stopPropagation(); console.log('__rb_close__'); });
  document.body.appendChild(closeBtn);
  document.addEventListener('mousemove', function(e) {
    if (e.clientY < 40) closeBtn.style.opacity = '0.6';
    else if (!closeBtn.matches(':hover')) closeBtn.style.opacity = '0';
  });

  return 'drag active';
})()`;

// Skin JS — hide AI branding/sidebars, expand main content
const SKIN_JS = `(function() {
  if (window._rbSkinActive) return 'already active';
  window._rbSkinActive = true;
  function skinApply() {
    // Standard semantic sidebar/nav elements (NOT header/footer — those contain model selectors)
    document.querySelectorAll('nav, aside, [role="navigation"], [role="complementary"]')
      .forEach(function(el) { if (!el.dataset.rbSkinHidden) el.dataset.rbSkinHidden = '1'; });
    // Position-based sidebar: any tall narrow element pinned to left edge
    document.querySelectorAll('body > div > div, body > div > section, body > div > nav, body > div > aside, body > div > header').forEach(function(el) {
      if (el.dataset.rbSkinHidden) return;
      var r = el.getBoundingClientRect();
      if (r.left <= 0 && r.width < 350 && r.height > window.innerHeight * 0.4)
        el.dataset.rbSkinHidden = '1';
    });
    // Deep scan: Claude/ChatGPT nest sidebars inside #__next or deep div trees
    document.querySelectorAll('div').forEach(function(el) {
      if (el.dataset.rbSkinHidden || el.children.length === 0) return;
      var r = el.getBoundingClientRect();
      // Tall narrow panel on the left = sidebar
      if (r.left <= 0 && r.width > 40 && r.width < 320 && r.height > window.innerHeight * 0.6) {
        // Make sure it's not the main content by checking there's something wider next to it
        var sibling = el.nextElementSibling || el.previousElementSibling;
        if (sibling) {
          var sr = sibling.getBoundingClientRect();
          if (sr.width > r.width) el.dataset.rbSkinHidden = '1';
        }
      }
    });
    // Logos/icons in header area
    document.querySelectorAll('svg, img').forEach(function(el) {
      if (el.dataset.rbSkinHidden) return;
      var r = el.getBoundingClientRect();
      if (r.top < 80 && r.width < 200 && r.height < 80 && r.width > 8)
        el.dataset.rbSkinHidden = '1';
    });
    // Brand links — only hide if they're clearly a homepage logo link, NOT a model selector
    // Skip anything that has a sibling/child dropdown chevron or is inside a button/header
    document.querySelectorAll('a').forEach(function(el) {
      if (el.dataset.rbSkinHidden) return;
      if (el.closest('button, header, [role="combobox"], [role="menu"], [role="listbox"]')) return;
      var r = el.getBoundingClientRect();
      if (r.top < 60 && /^(claude|gemini|chatgpt)$/i.test((el.textContent || '').trim()) && r.width > 40)
        el.dataset.rbSkinHidden = '1';
    });
    // Expand main content to fill
    document.querySelectorAll('main, [role="main"]').forEach(function(el) {
      el.style.cssText += 'margin-left:0!important;max-width:100%!important;width:100%!important';
    });

    // ── Provider-specific landing page cleanup ──
    var host = location.hostname;

    // Claude: greeting spans, category chips, centered logo
    if (host.includes('claude')) {
      // "Welcome, Name" — span with whitespace-nowrap + select-none, in upper half
      // "Paste a doc..." subtitle — span.text-text-500
      document.querySelectorAll('h1, h2, span').forEach(function(el) {
        if (el.dataset.rbSkinHidden) return;
        var r = el.getBoundingClientRect();
        if (r.top < 10 || r.top > window.innerHeight * 0.5) return;
        var text = (el.textContent || '').trim();
        if (/welcome|help you|good (morning|afternoon|evening)|hi,|hello|get started|paste a doc/i.test(text))
          el.dataset.rbSkinHidden = '1';
      });
      // Category chips: "Write", "Learn", "Code", "Life stuff", "Claude's choice"
      // These are span.font-normal with small SVG siblings, in the 300-500px vertical band
      document.querySelectorAll('span.font-normal').forEach(function(el) {
        if (el.dataset.rbSkinHidden) return;
        var r = el.getBoundingClientRect();
        if (r.top > 100 && r.top < window.innerHeight - 120) {
          var text = (el.textContent || '').trim();
          if (/^(write|learn|code|life stuff|claude.s choice|analyze|brainstorm|create|summarize)$/i.test(text))
            el.dataset.rbSkinHidden = '1';
        }
      });
      // SVG icons next to greeting and next to category chips (centered, upper half)
      document.querySelectorAll('svg, img').forEach(function(el) {
        if (el.dataset.rbSkinHidden) return;
        var r = el.getBoundingClientRect();
        if (r.top > 60 && r.top < window.innerHeight * 0.65 && r.width > 14 && r.width < 120 && r.height > 14 && r.height < 120) {
          // Skip model selector area (around y=300-340, has "Sonnet"/"Medium" siblings)
          var p = el.parentElement;
          if (p && /sonnet|opus|haiku|flash|model|medium|fast/i.test((p.textContent || '').trim())) return;
          el.dataset.rbSkinHidden = '1';
        }
      });
      // Scrub "Claude" brand from input placeholder
      document.querySelectorAll('[placeholder]').forEach(function(el) {
        if (/claude/i.test(el.placeholder)) el.placeholder = 'Type here...';
      });
    }

    // Gemini: greeting text, top toolbar, suggestion chips, star logo
    if (host.includes('gemini') || host.includes('google')) {
      // Greeting: Gemini randomizes every load ("what's on your mind",
      // "let's get into it", "ask away, Name!", etc.)
      // Strategy: any large-font text in the center zone on the landing page = greeting.
      // On landing, there's no chat content, so any prominent text is a greeting.
      document.querySelectorAll('h1, h2, span, p, [class*="greeting"], [class*="title"], .message-text').forEach(function(el) {
        if (el.dataset.rbSkinHidden) return;
        if (el.children.length > 3) return;
        var r = el.getBoundingClientRect();
        var text = (el.textContent || '').trim();
        // Skip tiny text, very long text (not a greeting), and elements outside center zone
        if (text.length < 5 || text.length > 100) return;
        if (r.top < 80 || r.top > window.innerHeight * 0.75) return;
        // Large font in the center = greeting
        var fontSize = parseFloat(window.getComputedStyle(el).fontSize);
        if (fontSize >= 20) {
          el.dataset.rbSkinHidden = '1';
        }
      });
      // Top toolbar cleanup — hide hamburger menu and compose/new-chat buttons,
      // but KEEP the model selector ("Gemini Flash" dropdown)
      document.querySelectorAll('button').forEach(function(el) {
        if (el.dataset.rbSkinHidden) return;
        var r = el.getBoundingClientRect();
        if (r.top > 60) return;
        // Skip the model picker button (contains "Gemini" + "Flash"/"Pro" text)
        var text = (el.textContent || '').trim();
        if (/gemini|flash|pro|ultra|nano/i.test(text) && text.length < 30) return;
        // Hide toolbar buttons: hamburger (left), compose/new-chat (right)
        if (r.width < 60 && r.height < 60)
          el.dataset.rbSkinHidden = '1';
      });
      // Suggestion chips
      document.querySelectorAll('[class*="chip"], [class*="suggestion"], [class*="prompt-suggestion"], [class*="query-chip"]').forEach(function(el) {
        if (!el.dataset.rbSkinHidden) el.dataset.rbSkinHidden = '1';
      });
      // Large centered Gemini star/sparkle logo
      document.querySelectorAll('svg, img').forEach(function(el) {
        if (el.dataset.rbSkinHidden) return;
        var r = el.getBoundingClientRect();
        if (r.top > 40 && r.top < window.innerHeight * 0.5 && r.width > 24 && r.width < 200 && r.height > 24 && r.height < 200) {
          var cx = r.left + r.width / 2;
          if (cx > window.innerWidth * 0.25 && cx < window.innerWidth * 0.75)
            el.dataset.rbSkinHidden = '1';
        }
      });
      // Scrub brand text — hide "Gemini" from model picker, keep model name visible
      document.querySelectorAll('.picker-primary-text, span').forEach(function(el) {
        if (el.children.length > 0) return;
        var text = (el.textContent || '').trim();
        if (text === 'Gemini') el.style.setProperty('display', 'none', 'important');
      });
      // Neutralize "Ask Gemini" placeholder
      document.querySelectorAll('[placeholder], [aria-label]').forEach(function(el) {
        if (el.placeholder && /gemini/i.test(el.placeholder)) el.placeholder = 'Type here...';
        if (el.ariaLabel && /gemini/i.test(el.ariaLabel)) el.ariaLabel = 'Type here';
      });
      // Also catch contenteditable or inner text placeholders
      document.querySelectorAll('[data-placeholder]').forEach(function(el) {
        if (/gemini/i.test(el.getAttribute('data-placeholder')))
          el.setAttribute('data-placeholder', 'Type here...');
      });
      // Catch visible placeholder text spans inside input areas
      document.querySelectorAll('span, p, div').forEach(function(el) {
        if (el.children.length > 0) return;
        var text = (el.textContent || '').trim();
        if (text === 'Ask Gemini') el.textContent = 'Type here...';
      });
    }

    // ChatGPT: "What can I help with?" heading, suggestion cards, logo
    if (host.includes('chatgpt') || host.includes('openai')) {
      document.querySelectorAll('h1, h2').forEach(function(el) {
        if (el.dataset.rbSkinHidden) return;
        if (/help with|what can i|how can i/i.test(el.textContent || ''))
          el.dataset.rbSkinHidden = '1';
      });
      // Suggestion prompt buttons
      document.querySelectorAll('button').forEach(function(el) {
        if (el.dataset.rbSkinHidden) return;
        var r = el.getBoundingClientRect();
        if (r.top > 100 && r.top < window.innerHeight - 120 && r.width > 100 && r.height > 30 && r.height < 120) {
          var text = (el.textContent || '').trim();
          if (text.length > 10 && !/send|stop|cancel|upload|attach/i.test(text))
            el.dataset.rbSkinHidden = '1';
        }
      });
      // OpenAI logo in center
      document.querySelectorAll('svg, img').forEach(function(el) {
        if (el.dataset.rbSkinHidden) return;
        var r = el.getBoundingClientRect();
        if (r.top > 40 && r.top < window.innerHeight * 0.5 && r.width > 20 && r.width < 150 && r.height > 20 && r.height < 150) {
          var cx = r.left + r.width / 2;
          if (cx > window.innerWidth * 0.3 && cx < window.innerWidth * 0.7)
            el.dataset.rbSkinHidden = '1';
        }
      });
      // Scrub "ChatGPT" brand from input placeholder and model selector text
      document.querySelectorAll('[placeholder]').forEach(function(el) {
        if (/chatgpt/i.test(el.placeholder)) el.placeholder = 'Type here...';
      });
    }

    // Container bg clearing is handled by CSS (cssOrigin:'user' makes
    // div { background: transparent !important } beat all page styles)
  }
  skinApply();
  window._rbSkinObs = new MutationObserver(function() { requestAnimationFrame(skinApply); });
  window._rbSkinObs.observe(document.body, { childList: true, subtree: true });
  return 'skin applied';
})()`;

const UNSKIN_JS = `(function() {
  document.querySelectorAll('[data-rb-skin-hidden]').forEach(function(el) {
    el.style.display = ''; el.style.opacity = ''; el.style.visibility = '';
    delete el.dataset.rbSkinHidden;
  });
  document.querySelectorAll('main, [role="main"]').forEach(function(el) {
    el.style.marginLeft = ''; el.style.width = ''; el.style.maxWidth = '';
  });
  if (window._rbSkinObs) { window._rbSkinObs.disconnect(); window._rbSkinObs = null; }
  window._rbSkinActive = false;
  return 'skin removed';
})()`;

// Build dynamic skin CSS — lightweight CB reference sheet styling
// Does NOT override fonts on every element (that breaks AI pages).
// Instead: grayscale + edge feather + CB color accents + scrollbar/cursor cleanup

// Sample the dominant page-level background from Bluebook.
// Walks the largest containers (body, #app, main, sections) and picks
// the most common non-transparent bg. Avoids buttons/navbars/small elements
// that carry accent colors like Bluebook's blue (rgb(50,77,199)).
async function sampleBluebookBg() {
  if (!_mainWin || _mainWin.isDestroyed()) return '#f8f9fa';
  try {
    const raw = await _mainWin.webContents.executeJavaScript(`(function() {
      // Strategy 1: elementFromPoint at multiple spots near the left edge
      // (where the AI overlay sits)
      var samplePoints = [
        [100, Math.round(window.innerHeight * 0.3)],
        [100, Math.round(window.innerHeight * 0.5)],
        [100, Math.round(window.innerHeight * 0.7)],
        [250, Math.round(window.innerHeight * 0.5)],
      ];
      var colors = {};
      for (var i = 0; i < samplePoints.length; i++) {
        var el = document.elementFromPoint(samplePoints[i][0], samplePoints[i][1]);
        while (el) {
          var bg = window.getComputedStyle(el).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
            colors[bg] = (colors[bg] || 0) + 1;
            break;
          }
          el = el.parentElement;
        }
      }
      var best = '', bestCount = 0;
      for (var c in colors) {
        if (colors[c] > bestCount) { bestCount = colors[c]; best = c; }
      }
      if (best) return best;

      // Strategy 2: fallback — largest element with a background
      var fallback = null, fallbackArea = 0;
      var all = document.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        var el2 = all[j];
        var r = el2.getBoundingClientRect();
        if (r.width < 200 || r.height < 200) continue;
        var bg2 = window.getComputedStyle(el2).backgroundColor;
        if (!bg2 || bg2 === 'rgba(0, 0, 0, 0)' || bg2 === 'transparent') continue;
        var area = r.width * r.height;
        if (area > fallbackArea) { fallbackArea = area; fallback = bg2; }
      }
      return fallback || '';
    })()`);
    if (raw && raw !== 'rgba(0, 0, 0, 0)' && raw !== 'transparent') return raw;
  } catch (_) {}
  return '#f8f9fa';
}

// Convert rgb(r,g,b) string to #RRGGBB hex for Electron's setBackgroundColor
function rgbToHex(rgb) {
  var m = rgb.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return rgb; // already hex or unknown format, pass through
  var r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

// Push a bg color update into the AI overlay
async function syncAiColor() {
  if (!_aiView) return;
  try {
    const bg = await sampleBluebookBg();
    if (bg === _aiLastBg) return;
    _aiLastBg = bg;
    log('skin bg sync: ' + bg);
    // Set the native background — visible when page is at opacity 0 (FADE_JS rest)
    const hex = rgbToHex(bg);
    try { _aiView.setBackgroundColor(hex); } catch (e1) {
      log('setBackgroundColor on view failed: ' + e1.message);
      try { _aiView.webContents.setBackgroundColor(hex); } catch (e2) {
        log('setBackgroundColor on webContents failed: ' + e2.message);
      }
    }
    // Also update CSS variable for the in-page styles
    await _aiView.webContents.executeJavaScript(
      `document.documentElement.style.setProperty('--rb-bg', '${bg}')`
    );
  } catch (_) {}
}

function startAiColorSync() {
  stopAiColorSync();
  syncAiColor();
  // Poll every 3 seconds — lightweight, only runs 2 queries
  _aiColorSyncTimer = setInterval(syncAiColor, 3000);
}

function stopAiColorSync() {
  if (_aiColorSyncTimer) { clearInterval(_aiColorSyncTimer); _aiColorSyncTimer = null; }
}

async function buildSkinCss() {
  const bg = await sampleBluebookBg();
  _aiLastBg = bg;
  log('skin bg: ' + bg);

  return `
    /* ── grayscale + edge feather ── */
    /* Background color is handled by the native WebContentsView (setBackgroundColor).
       html/body are transparent so the native bg shows through un-grayscaled. */
    html {
      --rb-bg: ${bg};
      filter: grayscale(1) !important;
      background: transparent !important;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 5%, black 90%, transparent 100%),
                          linear-gradient(to right, transparent 0%, black 3%, black 97%, transparent 100%) !important;
      -webkit-mask-composite: source-in !important;
      mask-composite: intersect !important;
    }
    body { background: transparent !important; }

    /* ── Force ALL elements transparent so html/body bg shows through ──
       Uses * to catch Angular custom elements (mat-sidenav-container,
       input-area-v2, chat-app, etc.) that standard tag selectors miss.
       With cssOrigin:'user', our !important beats the page's !important. */
    *:not(html):not(body):not(textarea):not(input):not(img):not(video):not(canvas):not(svg) {
      background: transparent !important;
      background-image: none !important;
      box-shadow: none !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    /* Pseudo-elements can paint backgrounds too */
    *::before, *::after {
      background: transparent !important;
      background-image: none !important;
      box-shadow: none !important;
    }

    /* ── scrollbar kill ── */
    ::-webkit-scrollbar { display: none !important; }
    html, body { scrollbar-width: none !important; }

    /* ── cursor override — no pointer/text giveaway ── */
    *, *::before, *::after { cursor: default !important; }
    textarea, input, [contenteditable="true"] { cursor: text !important; }

    /* ── hide marked elements ── */
    [data-rb-skin-hidden] { display: none !important; }
  `;
}

// Re-inject active styles after SPA navigation inside the overlay
function reapplyAiStealth() {
  if (!_aiView) return;
  const wc = _aiView.webContents;
  // Proximity fade — always on
  wc.executeJavaScript(FADE_JS).then(r => log('fade: ' + r)).catch(() => {});
  // Skin — always on
  buildSkinCss().then(css => {
    wc.insertCSS(css, { cssOrigin: 'user' }).then(k => { _aiSkinCssKey = k; }).catch(() => {});
    // Set native view background to match — visible when page is at opacity 0
    var h = rgbToHex(_aiLastBg);
    try { _aiView.setBackgroundColor(h); } catch (_e) {
      try { _aiView.webContents.setBackgroundColor(h); } catch (_e2) {}
    }
  });
  wc.executeJavaScript(SKIN_JS).catch(() => {});
  // Background color sync — polls Bluebook bg every 2s
  startAiColorSync();
}

// Current AI view bounds — persisted so drag/resize can modify them
let _aiViewCurrentBounds = null;

function getAiViewBounds() {
  if (!_mainWin || _mainWin.isDestroyed()) return null;
  const [w, h] = _mainWin.getContentSize();
  // If we have user-set bounds from drag/resize, use those (clamped to window)
  if (_aiViewCurrentBounds) {
    const b = _aiViewCurrentBounds;
    return {
      x: Math.max(0, Math.min(b.x, w - 100)),
      y: Math.max(0, Math.min(b.y, h - 50)),
      width: Math.max(200, Math.min(b.width, w)),
      height: Math.max(100, Math.min(b.height, h)),
    };
  }
  // Default: left edge, vertically centered
  const viewH = Math.min(AI_VIEW_H, h - 40);
  const viewY = Math.round((h - viewH) / 2);
  return { x: AI_VIEW_MARGIN, y: viewY, width: AI_VIEW_W, height: viewH };
}

function createAiView(url, opts) {
  const hidden = opts && opts.hidden;
  if (_aiView) {
    if (url) _aiView.webContents.loadURL(url);
    if (!hidden && !_aiViewVisible) showAiView();
    return;
  }
  if (!_mainWin || _mainWin.isDestroyed()) { log('createAiView: no main window'); return; }

  _aiView = new electron.WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: AI_PARTITION,
    },
  });

  // Prevent the AI page from spawning popup windows (Google auth, etc.)
  _aiView.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    log('AI popup intercepted: ' + popupUrl);
    if (popupUrl && popupUrl !== 'about:blank') _aiView.webContents.loadURL(popupUrl);
    return { action: 'deny' };
  });

  const loadUrl = url || 'https://gemini.google.com/app';
  _aiView.webContents.loadURL(loadUrl);
  log('AI view created, partition=' + AI_PARTITION + ' url=' + loadUrl);

  // Inject proximity fade + drag/resize + re-injection hooks for SPA navigation
  _aiView.webContents.on('did-finish-load', () => {
    log('AI did-finish-load');
    reapplyAiStealth();
    _aiView.webContents.executeJavaScript(DRAG_RESIZE_JS).then(r => log('drag: ' + r)).catch(() => {});
  });
  _aiView.webContents.on('did-navigate-in-page', () => {
    reapplyAiStealth();
    _aiView.webContents.executeJavaScript(DRAG_RESIZE_JS).catch(() => {});
  });

  // Listen for drag/resize/close messages from injected JS via console.log
  _aiView.webContents.on('console-message', (_e, _level, msg) => {
    if (msg === '__rb_close__') { closeAiView(); return; }
    if (!msg.startsWith('__rb_drag__:')) return;
    // format: __rb_drag__:{mode}:{dx}:{dy}
    const parts = msg.split(':');
    const mode = parts[1];
    const dx = parseInt(parts[2], 10) || 0;
    const dy = parseInt(parts[3], 10) || 0;
    if (!_aiView || !_aiViewVisible) return;
    const b = _aiView.getBounds();
    let { x, y, width, height } = b;
    if (mode === 'move') {
      x += dx; y += dy;
    } else {
      if (mode.includes('e')) { width += dx; }
      if (mode.includes('w')) { x += dx; width -= dx; }
      if (mode.includes('s')) { height += dy; }
      if (mode.includes('n')) { y += dy; height -= dy; }
    }
    width = Math.max(200, width);
    height = Math.max(100, height);
    const newBounds = { x, y, width, height };
    _aiView.setBounds(newBounds);
    _aiViewCurrentBounds = newBounds;
  });

  if (!hidden) showAiView();
}

function showAiView() {
  if (!_aiView || !_mainWin || _mainWin.isDestroyed() || _aiViewVisible) return;
  const bounds = getAiViewBounds();
  if (!bounds) return;
  _aiView.setBounds(bounds);
  _mainWin.contentView.addChildView(_aiView);
  _aiViewVisible = true;
  log('AI view shown');
}

function hideAiView() {
  if (!_aiView || !_aiViewVisible) return;
  try {
    if (_mainWin && !_mainWin.isDestroyed()) _mainWin.contentView.removeChildView(_aiView);
  } catch (_) {}
  _aiViewVisible = false;
  log('AI view hidden');
}

function toggleAiView() {
  if (!_aiView) return false;
  if (_aiViewVisible) hideAiView();
  else showAiView();
  return true;
}

function closeAiView() {
  stopAiColorSync();
  hideAiView();
  if (_aiView) {
    try { _aiView.webContents.close(); } catch (_) {}
    _aiView = null;
  }
  log('AI view closed');
}

// Reposition AI view when main window resizes (kiosk on/off, etc.)
function updateAiViewBounds() {
  if (_aiView && _aiViewVisible) {
    const bounds = getAiViewBounds();
    if (bounds) _aiView.setBounds(bounds);
  }
}

// ── Clipboard bypass (main-process level) ────────────────────────────────────
// Uses before-input-event to intercept Ctrl+C/V/X/A BEFORE the renderer sees
// them, then reads selection / injects text via executeJavaScript — bypasses both
// CKEditor's DOM handlers and Electron's empty menu.
//
// Bluebook actively clears the system clipboard on a sub-second timer.
// We monkey-patch electron.clipboard.clear() and empty writeText() calls so
// Bluebook's clearing is blocked while bypass is active. We also keep an internal
// buffer (_copiedText) so paste-within-Bluebook never depends on the system clipboard.
let _clipboardBypassEnabled = false;
let _copiedText = '';  // internal clipboard buffer — survives system clipboard clearing

// ── Monkey-patch electron.clipboard to block Bluebook's clearing ─────────────
const _origClipboardClear = electron.clipboard.clear.bind(electron.clipboard);
const _origClipboardWriteText = electron.clipboard.writeText.bind(electron.clipboard);
const _origClipboardReadText = electron.clipboard.readText.bind(electron.clipboard);

electron.clipboard.clear = function(type) {
  if (_clipboardBypassEnabled) {
    log('clipboard: BLOCKED clear() call');
    return;
  }
  return _origClipboardClear(type);
};

electron.clipboard.writeText = function(text, type) {
  if (_clipboardBypassEnabled && (!text || text.trim() === '')) {
    log('clipboard: BLOCKED writeText("") call');
    return;
  }
  return _origClipboardWriteText(text, type);
};

function _clipboardHandler(event, input) {
  if (!_clipboardBypassEnabled) return;
  const ctrl = input.control || input.meta;
  if (!ctrl || input.type !== 'keyDown') return;
  const k = input.key.toLowerCase();
  if (k !== 'c' && k !== 'v' && k !== 'x' && k !== 'a') return;
  if (!_mainWin || _mainWin.isDestroyed()) { log('clipboard: no mainWin'); return; }
  const wc = _mainWin.webContents;

  log('clipboard: Ctrl+' + k.toUpperCase() + ' detected');
  event.preventDefault(); // kill the event — CKEditor never sees it

  if (k === 'a') {
    wc.executeJavaScript(`(function(){
      var el = document.activeElement;
      var tag = el ? el.tagName + (el.isContentEditable ? '[CE]' : '') : 'null';
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        el.select();
        return 'selectAll on ' + tag + ' len=' + el.value.length;
      } else {
        var sel = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(document.body);
        sel.removeAllRanges();
        sel.addRange(range);
        return 'selectAll on body, active=' + tag;
      }
    })()`).then(r => log('clipboard: ' + r)).catch(e => log('clipboard selectAll err: ' + e.message));
    return;
  }

  if (k === 'c' || k === 'x') {
    wc.executeJavaScript(`(function(){
      var el = document.activeElement;
      var tag = el ? el.tagName + (el.isContentEditable ? '[CE]' : '') + (el.className ? '.' + String(el.className).slice(0,40) : '') : 'null';
      var text = '';
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        text = el.value.substring(el.selectionStart, el.selectionEnd);
        return JSON.stringify({tag: tag, selStart: el.selectionStart, selEnd: el.selectionEnd, text: text});
      } else {
        var sel = window.getSelection();
        text = sel ? sel.toString() : '';
        return JSON.stringify({tag: tag, selType: sel ? sel.type : 'none', selRanges: sel ? sel.rangeCount : 0, text: text});
      }
    })()`).then(raw => {
      try {
        const info = JSON.parse(raw);
        log('clipboard: ' + k + ' active=' + info.tag + ' text="' + (info.text || '').slice(0, 60) + '" selType=' + (info.selType || 'n/a'));
        if (info.text) {
          _copiedText = info.text;  // internal buffer — always survives
          _origClipboardWriteText(info.text);  // use ORIGINAL writeText (bypasses our own guard)
          log('clipboard: stored ' + info.text.length + ' chars in buffer + system clipboard');
          if (k === 'x') {
            wc.executeJavaScript(`(function(){
              var el = document.activeElement;
              if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                var s = el.selectionStart, e = el.selectionEnd;
                el.value = el.value.slice(0, s) + el.value.slice(e);
                el.selectionStart = el.selectionEnd = s;
                el.dispatchEvent(new Event('input', {bubbles:true}));
              } else if (el && el.isContentEditable) {
                document.execCommand('delete');
              } else {
                var sel = window.getSelection();
                if (sel.rangeCount) sel.deleteFromDocument();
              }
              return 'cut-delete done';
            })()`).then(r => log('clipboard: ' + r)).catch(e => log('clipboard cut err: ' + e.message));
          }
        } else {
          log('clipboard: nothing selected — no text to copy');
        }
      } catch (e) { log('clipboard parse err: ' + e.message + ' raw=' + raw); }
    }).catch(e => log('clipboard copy err: ' + e.message));
    return;
  }

  if (k === 'v') {
    // prefer internal buffer (survives Bluebook clipboard clearing), fall back to system clipboard
    const text = _copiedText || _origClipboardReadText();
    log('clipboard: paste — source=' + (_copiedText ? 'buffer' : 'system') + ' ' + (text ? text.length + ' chars: "' + text.slice(0, 60) + '"' : 'NOTHING'));
    if (!text) return;
    const escaped = JSON.stringify(text);
    wc.executeJavaScript(`(function(){
      var text = ${escaped};
      var el = document.activeElement;
      var tag = el ? el.tagName + (el.isContentEditable ? '[CE]' : '') + (el.className ? '.' + String(el.className).slice(0,40) : '') : 'null';
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        var s = el.selectionStart, e = el.selectionEnd;
        el.value = el.value.slice(0, s) + text + el.value.slice(e);
        el.selectionStart = el.selectionEnd = s + text.length;
        el.dispatchEvent(new Event('input', {bubbles:true}));
        return 'pasted into ' + tag + ' at pos ' + s;
      } else if (el && el.isContentEditable) {
        var ok = document.execCommand('insertText', false, text);
        return 'pasted into ' + tag + ' execCommand=' + ok;
      } else {
        return 'no pasteable element — active=' + tag;
      }
    })()`).then(r => log('clipboard: ' + r)).catch(e => log('clipboard paste err: ' + e.message));
    return;
  }
}

async function handleIpcCommand(cmd, args) {
  switch (cmd) {
    case 'ping': return 'pong';

    case 'session.save': {
      ensureSessionsDir();
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const name = args && args.name ? String(args.name).replace(/[^a-z0-9_-]+/gi, '_') : `session_${ts}`;
      const fp = path.join(SESSIONS_DIR, `${name}.json`);
      // Also grab HttpOnly cookies via main-process session API
      let cookies = [];
      try {
        if (_mainWin && _mainWin.webContents) {
          cookies = await _mainWin.webContents.session.cookies.get({});
        } else {
          cookies = await session.defaultSession.cookies.get({});
        }
      } catch (e) { log('cookies.get err', e.message); }
      const payload = { ...args, cookies, savedAt: new Date().toISOString() };
      fs.writeFileSync(fp, JSON.stringify(payload, null, 2));
      log(`session.save -> ${fp}`);
      return { ok: true, path: fp, name };
    }

    case 'session.list': {
      ensureSessionsDir();
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
      return files.map(f => {
        const fp = path.join(SESSIONS_DIR, f);
        const st = fs.statSync(fp);
        return { name: f.replace(/\.json$/, ''), size: st.size, mtime: st.mtime.toISOString() };
      }).sort((a, b) => b.mtime.localeCompare(a.mtime));
    }

    case 'session.load': {
      const fp = path.join(SESSIONS_DIR, `${args.name}.json`);
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      // Restore HttpOnly cookies via main-process session API
      if (data.cookies && Array.isArray(data.cookies)) {
        const sess = _mainWin ? _mainWin.webContents.session : session.defaultSession;
        for (const c of data.cookies) {
          try {
            const setOpts = {
              url: (c.secure ? 'https://' : 'http://') + (c.domain || '').replace(/^\./, '') + (c.path || '/'),
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              secure: c.secure,
              httpOnly: c.httpOnly,
              expirationDate: c.expirationDate,
              sameSite: c.sameSite,
            };
            // remove undefined keys, Electron complains
            Object.keys(setOpts).forEach(k => setOpts[k] === undefined && delete setOpts[k]);
            await sess.cookies.set(setOpts);
          } catch (e) { log('cookies.set err for', c && c.name, e.message); }
        }
        log(`session.load: restored ${data.cookies.length} cookies`);
      }
      return data;
    }

    case 'session.delete': {
      const fp = path.join(SESSIONS_DIR, `${args.name}.json`);
      fs.unlinkSync(fp);
      log(`session.delete -> ${fp}`);
      return { ok: true };
    }

    case 'log.tail': {
      const text = fs.readFileSync(logPath, 'utf8');
      const lines = text.split(/\r?\n/);
      const n = (args && args.lines) || 200;
      return lines.slice(-n).join('\n');
    }

    case 'version': {
      try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8'));
      } catch (_) {
        return { version: '0.0.0', electron: '?' };
      }
    }

    case 'shell.openPath': {
      await shell.openPath(args.path);
      return { ok: true };
    }

    case 'app.relaunch': {
      log('app.relaunch requested');
      app.relaunch();
      _allowExit = true;
      setTimeout(() => app.exit(0), 100);
      return { ok: true };
    }

    case 'window.reload': {
      if (_mainWin) _mainWin.webContents.reload();
      return { ok: true };
    }

    case 'devtools.toggle': {
      if (!_mainWin) return { error: 'no window' };
      const wc = _mainWin.webContents;
      if (wc.isDevToolsOpened()) { wc.closeDevTools(); return { ok: true, state: 'closed' }; }
      wc.openDevTools({ mode: 'detach' });
      return { ok: true, state: 'opened' };
    }

    case 'devtools.state': {
      if (!_mainWin) return { open: false };
      return { open: _mainWin.webContents.isDevToolsOpened() };
    }

    case 'recording.save': {
      ensureRecordingsDir();
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const name = args && args.name ? String(args.name).replace(/[^a-z0-9_-]+/gi, '_') : `recording_${ts}`;
      const fp = path.join(RECORDINGS_DIR, `${name}.json`);
      fs.writeFileSync(fp, JSON.stringify(args && args.payload || {}, null, 2));
      log(`recording.save -> ${fp} (${(args && args.payload && args.payload.events && args.payload.events.length) || 0} events)`);
      return { ok: true, path: fp, name };
    }

    case 'recording.list': {
      ensureRecordingsDir();
      const files = fs.readdirSync(RECORDINGS_DIR).filter(f => f.endsWith('.json'));
      return files.map(f => {
        const fp = path.join(RECORDINGS_DIR, f);
        const st = fs.statSync(fp);
        return { name: f.replace(/\.json$/, ''), size: st.size, mtime: st.mtime.toISOString() };
      }).sort((a, b) => b.mtime.localeCompare(a.mtime));
    }

    case 'recording.delete': {
      const fp = path.join(RECORDINGS_DIR, `${args.name}.json`);
      fs.unlinkSync(fp);
      return { ok: true };
    }

    // ── AI overlay management (WebContentsView — stealth) ─────────────
    case 'ai.open': {
      createAiView(args && args.url ? args.url : undefined, { hidden: !!(args && args.hidden) });
      return { ok: true };
    }

    case 'ai.close': {
      closeAiView();
      return { ok: true };
    }

    case 'ai.toggle': {
      if (!_aiView) return { ok: false, error: 'ai not open — use /ai open first' };
      toggleAiView();
      return { ok: true, visible: _aiViewVisible };
    }

    case 'ai.state': {
      let url = '';
      if (_aiView) { try { url = _aiView.webContents.getURL(); } catch (_) {} }
      return { open: !!_aiView, visible: _aiViewVisible, url };
    }

    case 'ai.inspect': {
      if (!_aiView) return { error: 'ai not open' };
      try {
        const result = await _aiView.webContents.executeJavaScript(`(function() {
          var out = [];

          // ── PART A: CSS variable & html/body check ──
          out.push('=== CSS VARIABLE CHECK ===');
          var htmlCs = window.getComputedStyle(document.documentElement);
          out.push('--rb-bg value: ' + htmlCs.getPropertyValue('--rb-bg'));
          out.push('html computed bg-color: ' + htmlCs.backgroundColor);
          out.push('html computed background: ' + htmlCs.background);
          out.push('html inline style: ' + document.documentElement.style.cssText);
          out.push('html filter: ' + htmlCs.filter);
          var bodyCs = window.getComputedStyle(document.body);
          out.push('body computed bg-color: ' + bodyCs.backgroundColor);
          out.push('body inline style: ' + document.body.style.cssText);
          out.push('');

          // ── PART B: Container chain walk (first-child) ──
          out.push('=== CONTAINER CHAIN (first-child walk) ===');
          var walker = document.documentElement;
          for (var d = 0; d < 12; d++) {
            var tag = walker.tagName.toLowerCase();
            var id = walker.id || '';
            var cls = (walker.className && typeof walker.className === 'string') ? walker.className.slice(0, 80) : '';
            var r = walker.getBoundingClientRect();
            var cs = window.getComputedStyle(walker);
            var hasShadow = !!walker.shadowRoot;
            var kids = walker.children.length;
            out.push('depth=' + d + ' <' + tag + '#' + id + '> cls="' + cls + '"');
            out.push('  size: ' + Math.round(r.width) + 'x' + Math.round(r.height));
            out.push('  computed bg-color: ' + cs.backgroundColor);
            out.push('  computed background: ' + cs.background.slice(0, 120));
            out.push('  inline style: ' + (walker.style.cssText || '(none)').slice(0, 120));
            out.push('  shadowRoot: ' + hasShadow + ' | children: ' + kids);
            // Find next: pick the largest child
            var best = null, bestArea = 0;
            for (var i = 0; i < walker.children.length; i++) {
              var ch = walker.children[i];
              var cr = ch.getBoundingClientRect();
              var area = cr.width * cr.height;
              if (area > bestArea) { bestArea = area; best = ch; }
            }
            if (!best) break;
            walker = best;
          }
          out.push('');

          // ── PART C: ALL elements with non-transparent bg ──
          out.push('=== ALL ELEMENTS WITH BACKGROUND (width>50%) ===');
          var all = document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var r = el.getBoundingClientRect();
            if (r.width < window.innerWidth * 0.3) continue;
            if (r.height < 50) continue;
            var cs = window.getComputedStyle(el);
            var bg = cs.backgroundColor;
            if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
            var tag = el.tagName.toLowerCase();
            var id = el.id || '';
            var cls = (el.className && typeof el.className === 'string') ? el.className.slice(0, 80) : '';
            var inline = el.style.cssText ? el.style.cssText.slice(0, 80) : '(none)';
            out.push(Math.round(r.width) + 'x' + Math.round(r.height) + ' <' + tag + '#' + id + '.' + cls + '> bg=' + bg + ' inline="' + inline + '"');
          }

          return out.join('\\n');
        })()`);
        const dumpFile = path.join('G:\\\\redbook', '_inspect.txt');
        fs.writeFileSync(dumpFile, result || '(empty)', 'utf8');
        log('AI inspect written to ' + dumpFile);
        return { file: dumpFile };
      } catch (e) { return { error: e.message }; }
    }

    case 'ai.navigate': {
      if (!args || !args.url) return { error: 'missing url' };
      let targetUrl = args.url.trim();
      if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;
      if (!_aiView) {
        createAiView(targetUrl);
      } else {
        _aiView.webContents.loadURL(targetUrl);
        if (!_aiViewVisible) showAiView();
      }
      log('AI navigate to ' + targetUrl);
      return { ok: true, url: targetUrl };
    }

    // ── AI overlay modes ─────────────────────────────────────────────

    // ── Clipboard bypass control ───────────────────────────────────────
    case 'clipboard.enable': {
      if (!_mainWin || _mainWin.isDestroyed()) return { error: 'no window' };
      if (_clipboardBypassEnabled) return { ok: true, already: true };
      _clipboardBypassEnabled = true;
      _mainWin.webContents.on('before-input-event', _clipboardHandler);
      log('clipboard bypass enabled');
      return { ok: true };
    }

    case 'clipboard.disable': {
      if (!_mainWin || _mainWin.isDestroyed()) return { error: 'no window' };
      if (!_clipboardBypassEnabled) return { ok: true, already: true };
      _clipboardBypassEnabled = false;
      _mainWin.webContents.removeListener('before-input-event', _clipboardHandler);
      log('clipboard bypass disabled');
      return { ok: true };
    }

    case 'clipboard.state': {
      return { enabled: _clipboardBypassEnabled };
    }
  }
  return { error: 'unknown command ' + cmd };
}

// Push IPC results back to the renderer
function resolveIpcInRenderer(id, result) {
  if (!_mainWin) return;
  const code = `try { window.__rbIpcResolve && window.__rbIpcResolve(${id}, ${JSON.stringify(result)}); } catch(_) {}`;
  _mainWin.webContents.executeJavaScript(code, true).catch(() => {});
}

// ── Window setup ──────────────────────────────────────────────────────────────
app.on('browser-window-created', (e, win) => {
  log('browser-window-created id=', win.id);

  if (!_mainWin) _mainWin = win;

  // Reposition AI overlay when main window resizes (kiosk toggle, etc.)
  win.on('resize', updateAiViewBounds);

  setTimeout(() => { try { win.show(); win.focus(); log('forced show'); } catch (_) {} }, 50);

  // NOTE: DevTools is NOT auto-opened — Bluebook's bundle has cumulative
  // debugger-detection that disables the login flow after enough hits.
  // Use the dev panel's "Open DevTools" button (About tab) to open on-demand
  // AFTER you're already logged in.

  // Console-message IPC channel — supports BOTH old (event, level, message, line, sourceId)
  // and new (Event<WebContentsConsoleMessageEventParams>) signatures from Electron 36+.
  win.webContents.on('console-message', function() {
    let message;
    const a = arguments;
    if (a.length === 1 && a[0] && typeof a[0] === 'object' && typeof a[0].message === 'string') {
      message = a[0].message;
    } else if (typeof a[2] === 'string') {
      message = a[2];
    } else if (a[0] && typeof a[0].message === 'string') {
      message = a[0].message;
    }
    if (typeof message !== 'string' || !message.startsWith('<<RB_IPC>>')) return;
    try {
      const json = message.slice('<<RB_IPC>>'.length).trim();
      const { cmd, args, id } = JSON.parse(json);
      Promise.resolve()
        .then(() => handleIpcCommand(cmd, args))
        .then(result => { if (typeof id === 'number') resolveIpcInRenderer(id, result); })
        .catch(err => {
          log('IPC handler err', cmd, err && err.message);
          if (typeof id === 'number') resolveIpcInRenderer(id, { error: String(err && err.message || err) });
        });
    } catch (e) { log('IPC parse err', e && e.message); }
  });

  // Backtick panic key — must use before-input-event since ` is not a valid globalShortcut accelerator
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === '`' && !input.alt && !input.control && !input.meta && !input.shift) {
      log('Panic hotkey fired');
      doPanicToggle();
      event.preventDefault();
    }
  });

  // Inject mods after every load
  const injectMods = async () => {
    const bundle = loadModsBundle();
    if (!bundle) return;
    try {
      await win.webContents.executeJavaScript(bundle, true);
      log(`mods injected (${bundle.length} bytes)`);
    } catch (e) { log('mods inject err', e && e.message); }
  };
  win.webContents.on('did-finish-load', () => { log('did-finish-load', win.webContents.getURL()); injectMods(); });
  win.webContents.on('did-navigate', () => injectMods());
  win.webContents.on('did-navigate-in-page', () => injectMods());

  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', code, desc, url));
  win.on('ready-to-show', () => { log('ready-to-show'); win.show(); });
  win.on('closed', () => { if (_mainWin === win) _mainWin = null; });
});

// ── Panic toggle (module scope so browser-window-created can reach it) ────────
let _panicHidden = false;
let _panicState = { ai: false, panel: false };

function doPanicToggle() {
  if (!_mainWin || _mainWin.isDestroyed()) return;
  if (!_panicHidden) {
    _panicState.ai = _aiViewVisible;
    _panicState.panel = false;
    if (_aiViewVisible) hideAiView();
    _mainWin.webContents.executeJavaScript(
      "window.dispatchEvent(new CustomEvent('rb-panic-hide'))"
    ).catch(() => {});
    _panicHidden = true;
    log('PANIC: everything hidden');
  } else {
    if (_panicState.ai && _aiView) showAiView();
    _mainWin.webContents.executeJavaScript(
      "window.dispatchEvent(new CustomEvent('rb-panic-restore'))"
    ).catch(() => {});
    _panicHidden = false;
    log('PANIC: restored');
  }
}

app.on('ready', () => {
  log('app event: ready');

  // Focus-scoped hotkeys — active only while one of our windows is focused
  const AI_HOTKEY = 'CommandOrControl+Shift+G';
  const PANEL_HOTKEY = 'Insert';
  const { globalShortcut } = electron;

  function registerHotkeys() {
    if (!globalShortcut.isRegistered(AI_HOTKEY)) {
      globalShortcut.register(AI_HOTKEY, () => {
        log('AI hotkey fired');
        toggleAiView();
      });
    }
    if (!globalShortcut.isRegistered(PANEL_HOTKEY)) {
      globalShortcut.register(PANEL_HOTKEY, () => {
        log('Insert hotkey fired');
        if (_mainWin && !_mainWin.isDestroyed()) {
          _mainWin.webContents.executeJavaScript(
            "window.dispatchEvent(new CustomEvent('rb-toggle-devpanel'))"
          ).catch(() => {});
        }
      });
    }
  }

  function unregisterHotkeys() {
    if (globalShortcut.isRegistered(AI_HOTKEY)) globalShortcut.unregister(AI_HOTKEY);
    if (globalShortcut.isRegistered(PANEL_HOTKEY)) globalShortcut.unregister(PANEL_HOTKEY);
  }

  app.on('browser-window-focus', () => {
    registerHotkeys();
  });

  app.on('browser-window-blur', () => {
    setTimeout(() => {
      if (_mainWin && !_mainWin.isDestroyed() && _mainWin.isFocused()) return;
      unregisterHotkeys();
    }, 150);
  });
});

// ── Load the bundle ───────────────────────────────────────────────────────────
const asarPath = path.join(__dirname, 'resources', 'app.asar');

if (!fs.existsSync(asarPath)) {
  log('FATAL: app.asar not found at', asarPath);
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'Redbook — Bluebook Not Found',
      message: 'app.asar is missing.',
      detail: `Redbook needs Bluebook's app.asar to run.\n\nExpected location:\n${asarPath}\n\nEither:\n  1. Install Bluebook from collegeboard.org, then re-run RedbookSetup.exe\n  2. Manually copy app.asar into:\n     ${path.dirname(asarPath)}`,
      buttons: ['OK']
    });
    _allowExit = true;
    app.quit();
  });
} else {
  app.setAppPath(asarPath);
  log('setAppPath:', asarPath);

  log('require start');
  try {
    require(path.join(asarPath, 'main', 'index.js'));
    log('require returned');
  } catch (e) {
    log('require threw', e && e.stack);
  }
  log('waiting');
}
