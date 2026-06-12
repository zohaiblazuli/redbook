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
    return `(()=>{
      const __RB_CSS    = ${JSON.stringify(css)};
      const __RB_FLAGS  = ${JSON.stringify(flags)};
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
const AI_VIEW_W = 480;
const AI_VIEW_H = 700;
const AI_VIEW_MARGIN = 20;

function getAiViewBounds() {
  if (!_mainWin || _mainWin.isDestroyed()) return null;
  const [w, h] = _mainWin.getContentSize();
  const viewH = Math.min(AI_VIEW_H, h - 60);
  return { x: w - AI_VIEW_W - AI_VIEW_MARGIN, y: 30, width: AI_VIEW_W, height: viewH };
}

function createAiView(url) {
  if (_aiView) {
    if (url) _aiView.webContents.loadURL(url);
    if (!_aiViewVisible) showAiView();
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
  showAiView();
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
      createAiView(args && args.url ? args.url : undefined);
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
    // Unregister when all our windows lose focus (app is no longer active)
    setTimeout(() => {
      if (_mainWin && !_mainWin.isDestroyed() && _mainWin.isFocused()) return;
      unregisterHotkeys();
    }, 150);
  });
});

// ── Load the bundle ───────────────────────────────────────────────────────────
const asarPath = path.join(__dirname, 'resources', 'app.asar');
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
