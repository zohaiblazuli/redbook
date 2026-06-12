/*
 * Redbook Console — floating TUI window for Bluebook diagnostics.
 * Triggered by the Insert key (or Ctrl+Shift+D fallback).
 * Idempotent — survives reruns from did-navigate.
 */
'use strict';

if (!window.__rbDevPanelInstalled) {
  window.__rbDevPanelInstalled = true;
  initDevPanel();
}

function initDevPanel() {
  // ─── IPC primitive (console-message channel to _run.js) ────────────────────
  const __ipcWaits = new Map();
  let __ipcCounter = 0;
  window.__rbIpcResolve = (id, data) => {
    const w = __ipcWaits.get(id);
    if (w) { __ipcWaits.delete(id); w(data); }
  };
  function rbIpc(cmd, args, opts) {
    const timeout = (opts && opts.timeout) || 10000;
    return new Promise((resolve) => {
      const id = ++__ipcCounter;
      __ipcWaits.set(id, resolve);
      let payload;
      try { payload = JSON.stringify({ cmd, args, id }); }
      catch (e) { __ipcWaits.delete(id); resolve({ error: 'stringify: ' + e.message }); return; }
      try { console.log('<<RB_IPC>>' + payload); }
      catch (e) { __ipcWaits.delete(id); resolve({ error: 'console.log: ' + e.message }); return; }
      setTimeout(() => {
        if (__ipcWaits.has(id)) {
          __ipcWaits.delete(id);
          resolve({ error: 'timeout after ' + timeout + 'ms (payload was ' + payload.length + ' bytes)' });
        }
      }, timeout);
    });
  }

  // ─── Bridge surface (from preload recon) ───────────────────────────────────
  const BRIDGE_API = [
    { cat: 'Window / UI', items: [
      { name: 'enterKioskMode',       kind: 'action' },
      { name: 'exitKioskMode',        kind: 'action' },
      { name: 'enterFullscreenMode',  kind: 'action' },
      { name: 'emptyMenu',            kind: 'action' },
      { name: 'preventSleep',         kind: 'setter' },
      { name: 'quit',                 kind: 'action' },
    ]},
    { cat: 'Device / System', items: [
      { name: 'version',                       kind: 'value' },
      { name: 'getDeviceInfo',                 kind: 'getter' },
      { name: 'getDeviceId',                   kind: 'getter' },
      { name: 'getAnalyticsInfo',              kind: 'getter' },
      { name: 'systemCheck',                   kind: 'getter' },
      { name: 'getDefaultKeyboardLanguage',    kind: 'getter' },
      { name: 'getAvailableKeyboardLanguages', kind: 'getter' },
      { name: 'setKeyboardLanguage',           kind: 'setter' },
      { name: 'noCheckin',                     kind: 'value' },
    ]},
    { cat: 'Updates', items: [
      { name: 'checkUpdateRequired',  kind: 'getter' },
      { name: 'installUpdate',        kind: 'action' },
      { name: 'updateReady',          kind: 'action' },
      { name: 'onUpdateAvailable',    kind: 'event' },
      { name: 'onUpdateChecking',     kind: 'event' },
      { name: 'onUpdateDownloaded',   kind: 'event' },
      { name: 'onUpdateError',        kind: 'event' },
      { name: 'onUpdateNotAvailable', kind: 'event' },
    ]},
    { cat: 'RMT', items: [
      { name: 'getRMT',           kind: 'getter' },
      { name: 'setRMT',           kind: 'setter' },
      { name: 'clearRMT',         kind: 'action' },
      { name: 'setRosterEntryId', kind: 'setter' },
    ]},
    { cat: 'Security & Lockdown', items: [
      { name: 'performSecurityCheck',          kind: 'setter' },
      { name: 'requestRestrictedApps',         kind: 'action' },
      { name: 'onRestrictedAppsReceived',      kind: 'event' },
      { name: 'onSecurityViolationDetected',   kind: 'event' },
      { name: 'onDebuggerDetected',            kind: 'event' },
      { name: 'onGrammarlyDetected',           kind: 'event' },
      { name: 'onHModStatus',                  kind: 'event' },
      { name: 'onVirtualMachineDetected',      kind: 'event' },
      { name: 'onVirtualMachineSuspected',     kind: 'event' },
      { name: 'onRemoteDesktopConnectionDetected', kind: 'event' },
      { name: 'onLockdownNewProcess',          kind: 'event' },
      { name: 'onLockdownWindowResized',       kind: 'event' },
      { name: 'onLowBattery',                  kind: 'event' },
      { name: 'onWindowFocusChanged',          kind: 'event' },
      { name: 'onSegmentUpdateSuccess',        kind: 'event' },
      { name: 'onKeyboardLayoutChanged',       kind: 'event' },
      { name: 'terminateGrammarly',            kind: 'action' },
      { name: 'clearClipboard',                kind: 'action' },
      { name: 'unlockAccountAsStudent',        kind: 'action' },
    ]},
    { cat: 'Telemetry', items: [
      { name: 'setSentryUser',           kind: 'setter' },
      { name: 'setTelemetryStatus',      kind: 'setter' },
      { name: 'onAnalyticsReceived',     kind: 'event' },
      { name: 'onPDFSaved',              kind: 'event' },
      { name: 'printPDF',                kind: 'setter' },
      { name: 'captureScreen',           kind: 'setter' },
    ]},
    { cat: 'Lifecycle', items: [
      { name: 'appListenersReady',       kind: 'action' },
      { name: 'rendererReady',           kind: 'action' },
      { name: 'openUrl',                 kind: 'setter' },
      { name: 'onDeviceInfoReceived',    kind: 'event' },
    ]},
  ];

  function detectBridge() {
    const fingerprint = ['enterKioskMode', 'exitKioskMode', 'version', 'systemCheck'];
    for (const key of Object.getOwnPropertyNames(window)) {
      try {
        const v = window[key];
        if (!v || typeof v !== 'object') continue;
        if (fingerprint.every(fp => fp in v)) return { key, obj: v };
      } catch (_) {}
    }
    return null;
  }

  // ─── Remove legacy drawer host if present ───────────────────────────────────
  try {
    const legacy = document.getElementById('redbook-devpanel-host');
    if (legacy) legacy.remove();
  } catch (_) {}

  // ─── Console window mount ───────────────────────────────────────────────────
  const CON_HOST_ID = 'redbook-console-host';
  let host = document.getElementById(CON_HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = CON_HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
    document.documentElement.appendChild(host);
  }
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        --cn-bg: #08090b;
        --cn-surface: #0e1014;
        --cn-border: #1a1d23;
        --cn-border-hi: #262a32;
        --cn-text: #e4e6ea;
        --cn-dim: #71757d;
        --cn-faint: #3f434b;
        --cn-accent: #ef4444;
        --cn-accent-dim: #991b1b;
        --cn-success: #86efac;
        --cn-warn: #fde047;
        --cn-error: #fb7185;
        --cn-info: #f87171;
        --cn-str: #fde047;
        --cn-num: #fb923c;
        --cn-key: #c4b5fd;
      }
      * {
        box-sizing: border-box;
        font-family: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, ui-monospace, monospace;
      }
      .win {
        position: fixed;
        background: var(--cn-bg);
        color: var(--cn-text);
        border: 1px solid var(--cn-border);
        box-shadow: 0 8px 32px rgba(0,0,0,0.65);
        display: none;
        flex-direction: column;
        pointer-events: auto;
        user-select: text;
      }
      .win.open { display: flex; }
      .titlebar {
        display: flex; align-items: center; gap: 10px;
        padding: 6px 10px;
        background: var(--cn-surface);
        border-bottom: 1px solid var(--cn-border);
        font-size: 11px;
        cursor: move;
        flex-shrink: 0;
        user-select: none;
      }
      .tb-brand { color: var(--cn-accent); font-weight: 700; letter-spacing: 0.5px; }
      .tb-brand::before { content: '卐  '; }
      .tb-meta { color: var(--cn-dim); flex: 1; font-size: 10px; }
      .tb-status { display: flex; gap: 4px; align-items: center; }
      .tb-dot {
        width: 7px; height: 7px;
        background: var(--cn-faint);
        transition: background 0.2s;
      }
      .tb-dot.on { background: var(--cn-accent); }
      .tb-dot.err { background: var(--cn-error); }
      .tb-btn {
        background: transparent; border: 1px solid var(--cn-border);
        color: var(--cn-dim);
        width: 20px; height: 20px;
        font-size: 12px; line-height: 1;
        cursor: pointer; font-family: inherit;
        display: flex; align-items: center; justify-content: center;
        padding: 0;
      }
      .tb-btn:hover { border-color: var(--cn-accent); color: var(--cn-accent); }
      .scrollback {
        flex: 1; min-height: 0;
        overflow-y: auto; overflow-x: hidden;
        padding: 10px 12px;
        font-size: 11px;
        line-height: 1.5;
        scrollbar-width: thin;
        scrollbar-color: var(--cn-border) transparent;
      }
      .scrollback::-webkit-scrollbar { width: 6px; }
      .scrollback::-webkit-scrollbar-thumb { background: var(--cn-border); }
      .win.dense .scrollback { line-height: 1.3; }
      .log { white-space: pre-wrap; word-break: break-word; margin: 0; padding: 1px 0; }
      .echo { color: var(--cn-dim); }
      .dim { color: var(--cn-dim); }
      .faint { color: var(--cn-faint); }
      .brand { color: var(--cn-accent); }
      .banner {
        margin: 0; padding: 0;
        line-height: 1.2; font-size: 11px;
        color: var(--cn-accent);
        white-space: pre;
      }
      pre.box, pre.json, pre.table, pre.log-tail {
        margin: 4px 0; padding: 0;
        font-size: 11px;
        white-space: pre;
        color: var(--cn-text);
        font-family: inherit;
      }
      .json .jk { color: var(--cn-key); }
      .json .js { color: var(--cn-str); }
      .json .jn { color: var(--cn-num); }
      .json .jb { color: var(--cn-accent); }
      .tag-ok   { color: var(--cn-success); }
      .tag-warn { color: var(--cn-warn); }
      .tag-err  { color: var(--cn-error); }
      .tag-info { color: var(--cn-info); }
      .kv-k    { color: var(--cn-dim); }
      .kv-v    { color: var(--cn-text); }
      .kv-v.ok   { color: var(--cn-success); }
      .kv-v.warn { color: var(--cn-warn); }
      .kv-v.err  { color: var(--cn-error); }
      .kv-dots { color: var(--cn-faint); }
      .cmd-name { color: var(--cn-text); }
      .kind-action { color: var(--cn-accent); }
      .kind-getter { color: var(--cn-success); }
      .kind-setter { color: var(--cn-warn); }
      .kind-event  { color: var(--cn-info); }
      .kind-value  { color: var(--cn-dim); }
      .spin { color: var(--cn-accent); display: inline-block; width: 1em; }

      .input-row {
        display: flex; align-items: center;
        padding: 8px 12px;
        border-top: 1px solid var(--cn-border);
        background: var(--cn-surface);
        font-size: 12px;
        flex-shrink: 0;
      }
      .input-prompt {
        color: var(--cn-accent);
        margin-right: 8px;
        user-select: none;
      }
      .input-wrap {
        position: relative; flex: 1;
        height: 18px;
        overflow: hidden;
      }
      .input-display {
        position: absolute; top: 0; left: 0;
        margin: 0; padding: 0;
        white-space: pre;
        pointer-events: none;
        font-family: inherit; font-size: 12px;
        line-height: 18px;
        color: var(--cn-text);
      }
      .input-ghost { color: var(--cn-faint); }
      .input-text {
        position: absolute; inset: 0;
        width: 100%; height: 100%;
        background: transparent;
        border: none; outline: none;
        color: transparent;
        caret-color: var(--cn-accent);
        font-family: inherit; font-size: 12px;
        padding: 0; margin: 0;
        line-height: 18px;
      }
      .input-text:focus { outline: none; }

      .ac-region { position: relative; flex-shrink: 0; }
      .ac-dropdown {
        position: absolute;
        bottom: 100%;
        left: 0; right: 0;
        max-height: 200px;
        overflow-y: auto;
        background: var(--cn-surface);
        border: 1px solid var(--cn-border-hi);
        border-bottom: none;
        z-index: 10;
        font-size: 12px;
        scrollbar-width: thin;
        scrollbar-color: var(--cn-border-hi) transparent;
      }
      .ac-item {
        display: flex;
        align-items: center;
        padding: 4px 12px;
        cursor: pointer;
        color: var(--cn-text);
        gap: 12px;
      }
      .ac-item .ac-cmd {
        color: var(--cn-accent);
        white-space: nowrap;
        flex-shrink: 0;
      }
      .ac-item .ac-cmd .ac-match {
        color: var(--cn-text);
        font-weight: 600;
      }
      .ac-item .ac-help {
        color: var(--cn-dim);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
      }
      .ac-item.active {
        background: var(--cn-border);
      }
      .ac-item:hover:not(.active) {
        background: rgba(255,255,255,0.03);
      }
      .ac-item.arg-hint .ac-prefix {
        color: var(--cn-dim);
        margin-right: 2px;
      }
      .ac-item.arg-hint .ac-arg {
        color: var(--cn-accent);
        font-weight: 600;
      }
      .ac-group-header {
        padding: 3px 12px 1px;
        font-size: 10px;
        color: var(--cn-faint);
        letter-spacing: 0.5px;
        border-top: 1px solid var(--cn-border);
        user-select: none;
      }
      .ac-group-header:first-child { border-top: none; }

      .shortcuts {
        display: flex; gap: 14px;
        padding: 5px 12px;
        background: var(--cn-surface);
        border-top: 1px solid var(--cn-border);
        font-size: 10px;
        color: var(--cn-dim);
        flex-shrink: 0;
        user-select: none;
      }
      .shortcuts code {
        color: var(--cn-text);
        font-family: inherit;
        border: 1px solid var(--cn-border);
        padding: 0 4px;
        margin-right: 4px;
      }

      .resize-grip {
        position: absolute; bottom: 0; right: 0;
        width: 14px; height: 14px;
        cursor: nwse-resize;
        background:
          linear-gradient(135deg,
            transparent 0%, transparent 45%,
            var(--cn-border) 45%, var(--cn-border) 55%,
            transparent 55%, transparent 70%,
            var(--cn-border) 70%, var(--cn-border) 80%,
            transparent 80%);
      }
    </style>

    <div class="win" role="dialog" aria-label="Redbook Console">
      <div class="titlebar">
        <span class="tb-brand">redbook</span>
        <span class="tb-meta">v0.9.6 · console</span>
        <span class="tb-status">
          <span class="tb-dot status-store" title="store"></span>
          <span class="tb-dot status-bridge" title="bridge"></span>
          <span class="tb-dot status-rec" title="recorder"></span>
        </span>
        <button class="tb-btn tb-close" title="Hide (Esc)">×</button>
      </div>
      <div class="scrollback"></div>
      <div class="ac-region">
        <div class="ac-dropdown" style="display:none"></div>
        <div class="input-row">
          <span class="input-prompt">›</span>
          <div class="input-wrap">
            <pre class="input-display"><span class="input-typed"></span><span class="input-ghost"></span></pre>
            <input class="input-text" type="text" autocomplete="off" spellcheck="false" />
          </div>
        </div>
      </div>
      <div class="shortcuts">
        <span><code>Tab</code>complete</span>
        <span><code>↑↓</code>history</span>
        <span><code>Ctrl+L</code>clear</span>
        <span><code>Esc</code>hide</span>
      </div>
      <div class="resize-grip"></div>
    </div>
  `;

  const $ = sel => shadow.querySelector(sel);
  const win = $('.win');
  const scrollback = $('.scrollback');
  const input = $('.input-text');
  const inputTyped = $('.input-typed');
  const inputGhost = $('.input-ghost');
  const titlebar = $('.titlebar');
  const grip = $('.resize-grip');
  const acDropdown = $('.ac-dropdown');
  const statusStore = $('.status-store');
  const statusBridge = $('.status-bridge');
  const statusRec = $('.status-rec');

  // ─── Storage keys ──────────────────────────────────────────────────────────
  const IDENTITY_KEY = 'redbook-identity-name';
  const RECT_KEY = 'redbook-console-rect';
  const HISTORY_KEY = 'redbook-console-history';
  const DENSE_KEY = 'redbook-console-dense';

  // ─── State ─────────────────────────────────────────────────────────────────
  let identity = '';
  let inputMode = 'command'; // 'command' | 'identity'
  let history = [];
  let historyIdx = -1;
  let denseMode = false;
  try { identity = localStorage.getItem(IDENTITY_KEY) || ''; } catch (_) {}
  try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (_) { history = []; }
  try { denseMode = localStorage.getItem(DENSE_KEY) === '1'; } catch (_) {}

  // ─── Window rect persistence ──────────────────────────────────────────────
  function loadRect() {
    try {
      const r = JSON.parse(localStorage.getItem(RECT_KEY) || 'null');
      if (r && typeof r.w === 'number') return r;
    } catch (_) {}
    return { w: 720, h: 440, x: Math.max(0, window.innerWidth - 720 - 16), y: Math.max(0, window.innerHeight - 440 - 16) };
  }
  function saveRect() {
    try {
      const r = { x: parseInt(win.style.left||'0'), y: parseInt(win.style.top||'0'), w: win.offsetWidth, h: win.offsetHeight };
      localStorage.setItem(RECT_KEY, JSON.stringify(r));
    } catch (_) {}
  }
  const rect = loadRect();
  win.style.left = rect.x + 'px';
  win.style.top = rect.y + 'px';
  win.style.width = rect.w + 'px';
  win.style.height = rect.h + 'px';
  if (denseMode) win.classList.add('dense');

  // ─── Scrollback API ────────────────────────────────────────────────────────
  function _esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function highlightJson(s) {
    return _esc(s)
      .replace(/(&quot;(?:\\.|[^&\\])*?&quot;)(\s*:)/g, '<span class="jk">$1</span>$2')
      .replace(/:\s*(&quot;(?:\\.|[^&\\])*?&quot;)/g, ': <span class="js">$1</span>')
      .replace(/:\s*(-?\d+\.?\d*)/g, ': <span class="jn">$1</span>')
      .replace(/:\s*(true|false|null)/g, ': <span class="jb">$1</span>');
  }
  function scrollToBottom() { scrollback.scrollTop = scrollback.scrollHeight; }
  const con = {
    raw(html) {
      const div = document.createElement('div');
      div.className = 'log';
      div.innerHTML = html;
      scrollback.appendChild(div);
      scrollToBottom();
      return div;
    },
    println(text, cls)   { return this.raw(`<span class="${cls||'txt'}">${_esc(text)}</span>`); },
    printDim(text)       { return this.raw(`<span class="dim">${_esc(text)}</span>`); },
    printEcho(text)      { return this.raw(`<span class="echo">› ${_esc(text)}</span>`); },
    printOk(text)        { return this.raw(`<span class="tag-ok">[OK]</span>   ${_esc(text)}`); },
    printWarn(text)      { return this.raw(`<span class="tag-warn">[WARN]</span> ${_esc(text)}`); },
    printErr(text)       { return this.raw(`<span class="tag-err">[ERR]</span>  ${_esc(text)}`); },
    printInfo(text)      { return this.raw(`<span class="tag-info">[INFO]</span> ${_esc(text)}`); },
    printKV(rows) {
      const lines = rows.map(([k, v, cls]) => {
        const ks = String(k);
        const dots = '.'.repeat(Math.max(2, 24 - ks.length));
        return `<span class="kv-k">${_esc(ks)}</span><span class="kv-dots">${dots}</span><span class="kv-v ${cls||''}">${_esc(String(v))}</span>`;
      });
      return this.raw(lines.join('<br>'));
    },
    printBox(title, lines) {
      const w = Math.max(36, ...lines.map(l => l.length)) + 2;
      const top = '┌─ ' + title + ' ' + '─'.repeat(Math.max(0, w - title.length - 4)) + '┐';
      const bot = '└' + '─'.repeat(w - 2) + '┘';
      const mid = lines.map(l => '│ ' + l + ' '.repeat(Math.max(0, w - 4 - l.length)) + ' │').join('\n');
      return this.raw(`<pre class="box dim">${_esc(top)}\n<span class="txt">${_esc(mid)}</span>\n${_esc(bot)}</pre>`);
    },
    printJson(obj) {
      let s;
      try { s = JSON.stringify(obj, null, 2); }
      catch (_) { s = String(obj); }
      return this.raw(`<pre class="json">${highlightJson(s)}</pre>`);
    },
    printTable(headers, rows) {
      const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]||'').length)));
      const hr = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
      const ln = '─'.repeat(hr.length);
      const data = rows.map(r => r.map((v, i) => String(v||'').padEnd(widths[i])).join('  ')).join('\n');
      return this.raw(`<pre class="table"><span class="kv-k">${_esc(hr)}</span>\n<span class="faint">${_esc(ln)}</span>\n${_esc(data)}</pre>`);
    },
    spinner(text) {
      const div = this.raw(`<span class="spin">⠋</span> ${_esc(text)}`);
      const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
      let i = 0;
      let iv = setInterval(() => {
        i = (i+1) % frames.length;
        const s = div.querySelector('.spin');
        if (s) s.textContent = frames[i];
      }, 80);
      return {
        ok(msg)  { clearInterval(iv); div.innerHTML = `<span class="tag-ok">[OK]</span>   ${_esc(msg||text)}`; },
        err(msg) { clearInterval(iv); div.innerHTML = `<span class="tag-err">[ERR]</span>  ${_esc(msg||text)}`; },
        info(msg){ clearInterval(iv); div.innerHTML = `<span class="tag-info">[INFO]</span> ${_esc(msg||text)}`; },
      };
    },
    blank() { return this.raw('&nbsp;'); },
    clear() { scrollback.innerHTML = ''; showBanner(); },
  };

  // ─── Banner + identity ─────────────────────────────────────────────────────
  function showBanner() {
    const verBb = (function() { try { return (detectBridge()?.obj?.version) || '0.9.6'; } catch (_) { return '0.9.6'; } })();
    con.raw(`<pre class="banner">  █   █████
  █   █        ____          _  _                 _
  █   █       |  _ \\  ___  _| || |__    ___   ___ | | __
  █   █       | |_) |/ _ \\/ _\` || '_ \\  / _ \\ / _ \\| |/ /
  █████████   |  _ &lt;|  __/ (_| || |_) || (_) || (_) |   &lt;
      █   █   |_| \\_\\\\___|\\__,_||_.__/  \\___/  \\___/|_|\\_\\
      █   █
      █   █
  █████   █</pre>`);
    con.raw(`<span class="dim">              v0.9.6 console · bluebook ${_esc(verBb)}</span>`);
    con.blank();
    if (identity) {
      con.println('Welcome back, ' + identity + '.');
      con.printDim('Type /help to see what I can do.');
      inputMode = 'command';
    } else {
      con.println('What should I call you?');
      inputMode = 'identity';
    }
    con.blank();
  }

  // ─── Visibility + hotkey ───────────────────────────────────────────────────
  function showWin() {
    win.classList.add('open');
    host.style.pointerEvents = 'auto';
    setTimeout(() => input.focus(), 50);
  }
  function hideWin() {
    win.classList.remove('open');
    host.style.pointerEvents = 'none';
  }
  function toggleWin() { if (win.classList.contains('open')) hideWin(); else showWin(); }

  if (!window.__rbHotkeyInstalled) {
    window.__rbHotkeyInstalled = true;
    const handler = (e) => {
      const isInsert = (e.key === 'Insert' || e.keyCode === 45);
      const isCtrlShiftD = (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd');
      if (isInsert || isCtrlShiftD) {
        e.preventDefault(); e.stopPropagation();
        window.dispatchEvent(new CustomEvent('rb-toggle-devpanel'));
      }
    };
    window.addEventListener('keydown', handler, true);
    document.addEventListener('keydown', handler, true);
    document.documentElement.addEventListener('keydown', handler, true);
  }
  window.addEventListener('rb-toggle-devpanel', toggleWin);

  // ─── Input handling + dropdown autocomplete ────────────────────────────────
  let acIndex = 0;
  let acMatches = []; // array of { text, score, help, group, indices }
  let acVisible = false;
  let acMode = 'command'; // 'command' = matching command names, 'args' = showing argument hints
  let acArgCmd = ''; // the resolved command key when in arg mode (e.g. 'patch')

  // Argument hints for commands that take sub-arguments
  const COMMAND_ARGS = {
    'patch': [
      { arg: 'on',     help: 'Enable security patch' },
      { arg: 'off',    help: 'Disable security patch' },
      { arg: 'status', help: 'Show patch status & intercept log' },
    ],
    'kiosk': [
      { arg: 'on',  help: 'Enter kiosk mode' },
      { arg: 'off', help: 'Exit kiosk mode' },
    ],
    'theme': [
      { arg: 'redbook',  help: 'Dark red theme' },
      { arg: 'bluebook', help: 'Default Bluebook theme' },
    ],
    'exam.spoof': [
      { arg: 'on',     help: 'Enable dispatch interceptor' },
      { arg: 'off',    help: 'Disable dispatch interceptor' },
      { arg: 'target', help: 'Set target asmtEventTypeCd' },
    ],
    'ai': [
      { arg: 'open',   help: 'Open Gemini AI window' },
      { arg: 'claude', help: 'Open Claude AI window' },
      { arg: 'close',  help: 'Close AI window' },
      { arg: 'toggle', help: 'Show/hide AI window' },
      { arg: 'status', help: 'Check AI window state' },
      { arg: 'url',    help: 'Navigate to a different AI' },
    ],
  };

  // ── Fuzzy matcher ──────────────────────────────────────────────────────────
  // Returns { score, indices } or null if no match.
  //   Exact prefix → 1000+  |  Word-boundary subseq → 500+  |  Char subseq → 100+
  function fuzzyScore(query, target) {
    const q = query.toLowerCase();
    const t = target.toLowerCase();
    // 1. Exact prefix — best score
    if (t.startsWith(q)) {
      const indices = [];
      for (let k = 0; k < q.length; k++) indices.push(k);
      return { score: 1000 + (target.length - q.length), indices };
    }
    // 2. Word-boundary subsequence (letters match at / or space boundaries)
    const boundaries = [0];
    for (let k = 1; k < t.length; k++) {
      if (t[k - 1] === ' ' || t[k - 1] === '/') boundaries.push(k);
    }
    let bi = 0;
    let qi = 0;
    const wbIndices = [];
    while (qi < q.length && bi < boundaries.length) {
      const pos = boundaries[bi];
      if (pos < t.length && t[pos] === q[qi]) {
        wbIndices.push(pos);
        qi++;
      }
      bi++;
    }
    // Fall through to char-subseq if word-boundary didn't consume all query chars,
    // but keep trying from each boundary match forward within the word
    if (qi < q.length) {
      // retry: for each boundary, try to match a run of query chars
      qi = 0;
      wbIndices.length = 0;
      let ti = 0;
      for (let k = 0; k < q.length; k++) {
        while (ti < t.length && t[ti] !== q[k]) ti++;
        if (ti >= t.length) break;
        wbIndices.push(ti);
        ti++;
        qi = k + 1;
      }
      if (qi === q.length) {
        // Check if most matches land on boundaries — if so, score higher
        const onBoundary = wbIndices.filter(idx => boundaries.includes(idx)).length;
        const bonus = onBoundary >= 2 ? 500 : 100;
        return { score: bonus + (target.length - q.length), indices: wbIndices };
      }
      return null; // no subsequence match at all
    }
    return { score: 500 + (target.length - q.length), indices: wbIndices };
  }

  // Build highlighted HTML for a command string given matched char indices
  function highlightMatches(text, indices) {
    if (!indices || indices.length === 0) return _esc(text);
    const set = new Set(indices);
    let html = '';
    let inMatch = false;
    for (let i = 0; i < text.length; i++) {
      const isMatch = set.has(i);
      if (isMatch && !inMatch) { html += '<span class="ac-match">'; inMatch = true; }
      else if (!isMatch && inMatch) { html += '</span>'; inMatch = false; }
      html += _esc(text[i]);
    }
    if (inMatch) html += '</span>';
    return html;
  }

  function syncInput() {
    inputTyped.textContent = input.value;
    updateAutocomplete();
  }

  function updateAutocomplete() {
    const v = input.value;
    if (inputMode !== 'command' || !v.startsWith('/')) {
      hideAutocomplete();
      inputGhost.textContent = '';
      return;
    }

    // Check if we're past a complete command and into argument territory
    const stripped = v.slice(1); // remove leading /
    const tokens = stripped.split(/\s+/);

    // Try to resolve the typed text to a known command (greedy match, depth=2 like runCommand)
    let matchedCmd = null;
    let argStart = '';
    for (let i = Math.min(tokens.length, 2); i >= 1; i--) {
      const tryPath = tokens.slice(0, i).join('.');
      if (commands[tryPath]) {
        // Check if there's a space after the command portion
        const cmdText = '/' + tokens.slice(0, i).join(' ');
        if (v.length > cmdText.length && v[cmdText.length] === ' ') {
          matchedCmd = tryPath;
          argStart = v.slice(cmdText.length + 1); // text after command + space
          break;
        }
        // No space yet — still in command-name completion mode
        break;
      }
    }

    // Argument mode: command is fully typed + space pressed
    if (matchedCmd && COMMAND_ARGS[matchedCmd] && COMMAND_ARGS[matchedCmd].length > 0) {
      acMode = 'args';
      acArgCmd = matchedCmd;
      const hints = COMMAND_ARGS[matchedCmd];
      const cmdDisplay = '/' + matchedCmd.replace(/\./g, ' ');
      acMatches = [];
      for (const h of hints) {
        if (argStart && !h.arg.toLowerCase().startsWith(argStart.toLowerCase())) continue;
        if (h.arg === argStart) continue; // already fully typed
        acMatches.push({
          text: cmdDisplay + ' ' + h.arg,
          score: 1000,
          help: h.help,
          group: '',
          indices: [],
          arg: h.arg,
        });
      }
      if (acMatches.length === 0) {
        hideAutocomplete();
        inputGhost.textContent = '';
        return;
      }
      acIndex = 0;
      renderDropdown();
      inputGhost.textContent = acMatches[0].text.slice(v.length);
      return;
    }

    // Command mode: fuzzy-match command names
    acMode = 'command';
    acArgCmd = '';
    const paths = listCommandPaths();
    const scored = [];
    for (const p of paths) {
      if (p === v) continue; // don't match exact current input
      const result = fuzzyScore(v, p);
      if (!result) continue;
      const cmdKey = p.slice(1).replace(/ /g, '.');
      const help = commands[cmdKey] ? commands[cmdKey].help || '' : '';
      // Derive group from the first token (session, exam, security, etc.)
      const firstDot = cmdKey.indexOf('.');
      const group = firstDot > 0 ? cmdKey.slice(0, firstDot) : '';
      scored.push({ text: p, score: result.score, help, group, indices: result.indices });
    }
    scored.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
    acMatches = scored;
    if (acMatches.length === 0) {
      hideAutocomplete();
      inputGhost.textContent = '';
      return;
    }
    acIndex = 0;
    renderDropdown();
    // Ghost text: show completion for selected match only if it's a prefix match
    const sel = acMatches[0];
    if (sel.text.toLowerCase().startsWith(v.toLowerCase())) {
      inputGhost.textContent = sel.text.slice(v.length);
    } else {
      inputGhost.textContent = '';
    }
  }

  function renderDropdown() {
    const limit = Math.min(acMatches.length, 12);
    let html = '';

    if (acMode === 'args') {
      // Argument hints — show dim command prefix + highlighted arg + help
      const cmdDisplay = '/' + acArgCmd.replace(/\./g, ' ');
      for (let i = 0; i < limit; i++) {
        const m = acMatches[i];
        html += '<div class="ac-item arg-hint' + (i === acIndex ? ' active' : '') + '" data-idx="' + i + '">'
          + '<span class="ac-cmd"><span class="ac-prefix">' + _esc(cmdDisplay) + ' </span><span class="ac-arg">' + _esc(m.arg) + '</span></span>'
          + (m.help ? '<span class="ac-help">' + _esc(m.help) + '</span>' : '')
          + '</div>';
      }
    } else {
      // Command mode — grouped by namespace
      const groups = [];
      const groupMap = {};
      for (let i = 0; i < limit; i++) {
        const m = acMatches[i];
        const g = m.group || '_top';
        if (!groupMap[g]) { groupMap[g] = []; groups.push(g); }
        groupMap[g].push(i);
      }
      const multiGroup = groups.length > 1;
      for (const g of groups) {
        if (multiGroup) {
          const label = g === '_top' ? 'commands' : g;
          html += '<div class="ac-group-header">' + _esc(label) + '</div>';
        }
        for (const i of groupMap[g]) {
          const m = acMatches[i];
          html += '<div class="ac-item' + (i === acIndex ? ' active' : '') + '" data-idx="' + i + '">'
            + '<span class="ac-cmd">' + highlightMatches(m.text, m.indices) + '</span>'
            + (m.help ? '<span class="ac-help">' + _esc(m.help) + '</span>' : '')
            + '</div>';
        }
      }
    }

    if (acMatches.length > limit) {
      html += '<div class="ac-item" style="color:var(--cn-dim);pointer-events:none;justify-content:center">+'
        + (acMatches.length - limit) + ' more</div>';
    }
    acDropdown.innerHTML = html;
    acDropdown.style.display = 'block';
    acVisible = true;
    const activeEl = acDropdown.querySelector('.ac-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }

  // Event delegation — single handler, attached once
  acDropdown.addEventListener('mousedown', (ev) => {
    const item = ev.target.closest('.ac-item[data-idx]');
    if (!item) return;
    ev.preventDefault();
    const idx = parseInt(item.dataset.idx);
    if (idx >= 0 && idx < acMatches.length) {
      input.value = acMatches[idx].text;
      hideAutocomplete();
      syncInput();
      input.focus();
    }
  });

  function hideAutocomplete() {
    acDropdown.style.display = 'none';
    acDropdown.innerHTML = '';
    acVisible = false;
    acIndex = 0;
  }

  function navHistory(dir) {
    if (history.length === 0) return;
    if (dir < 0) {
      if (historyIdx < history.length - 1) historyIdx++;
      input.value = history[history.length - 1 - historyIdx];
    } else {
      if (historyIdx > 0) { historyIdx--; input.value = history[history.length - 1 - historyIdx]; }
      else { historyIdx = -1; input.value = ''; }
    }
    syncInput();
  }
  function pushHistory(line) {
    if (history[history.length - 1] === line) return;
    history.push(line);
    if (history.length > 50) history.shift();
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (_) {}
    historyIdx = -1;
  }

  // Helper: update ghost text for the currently selected match
  function updateGhost() {
    if (!acMatches.length) { inputGhost.textContent = ''; return; }
    const sel = acMatches[acIndex];
    if (sel.text.toLowerCase().startsWith(input.value.toLowerCase())) {
      inputGhost.textContent = sel.text.slice(input.value.length);
    } else {
      inputGhost.textContent = '';
    }
  }

  input.addEventListener('input', syncInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (acVisible && acMatches.length > 0) {
        input.value = acMatches[acIndex].text;
      }
      const line = input.value;
      input.value = '';
      hideAutocomplete();
      syncInput();
      handleSubmit(line);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (acVisible && acMatches.length > 0) {
        const sel = acMatches[acIndex];
        // Two-stage: if we're in command mode and this command has args, complete to command + space
        if (acMode === 'command') {
          const cmdKey = sel.text.slice(1).replace(/ /g, '.');
          if (COMMAND_ARGS[cmdKey] && COMMAND_ARGS[cmdKey].length > 0) {
            input.value = sel.text + ' ';
            hideAutocomplete();
            syncInput(); // triggers arg-mode dropdown
            return;
          }
        }
        input.value = sel.text;
        hideAutocomplete();
        syncInput();
      } else if (inputGhost.textContent) {
        input.value += inputGhost.textContent;
        syncInput();
      }
    } else if (e.key === 'ArrowRight' && input.selectionStart === input.value.length && inputGhost.textContent) {
      e.preventDefault();
      input.value += inputGhost.textContent; syncInput();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (acVisible) {
        acIndex = Math.max(0, acIndex - 1);
        renderDropdown();
        updateGhost();
      } else {
        navHistory(-1);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (acVisible) {
        acIndex = Math.min(acMatches.length - 1, acIndex + 1);
        renderDropdown();
        updateGhost();
      } else {
        navHistory(1);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (acVisible) { hideAutocomplete(); inputGhost.textContent = ''; }
      else { hideWin(); }
    } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault(); con.clear();
    }
  });
  // Click anywhere in the window focuses the input (so dragging works on titlebar).
  win.addEventListener('mousedown', (e) => {
    if (e.target === input) return;
    if (e.target.closest('.titlebar') || e.target.closest('.resize-grip') || e.target.closest('.tb-btn')) return;
    setTimeout(() => input.focus(), 0);
  });

  function handleSubmit(line) {
    const trimmed = line.trim();
    if (inputMode === 'identity') {
      if (!trimmed) return;
      identity = trimmed;
      try { localStorage.setItem(IDENTITY_KEY, identity); } catch (_) {}
      con.printEcho(line);
      con.println('Pleased to meet you, ' + identity + '.');
      con.printDim('Type /help to see what I can do.');
      con.blank();
      inputMode = 'command';
      return;
    }
    if (!trimmed) { con.printEcho(''); return; }
    pushHistory(trimmed);
    con.printEcho(trimmed);
    scrollToBottom();
    if (!trimmed.startsWith('/')) {
      con.printErr('not a command. start with /. type /help to list commands.');
      con.blank();
      return;
    }
    runCommand(trimmed);
  }

  // ─── Window drag ──────────────────────────────────────────────────────────
  (function() {
    let dragStart = null;
    titlebar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.classList && e.target.classList.contains('tb-btn')) return;
      dragStart = { mx: e.clientX, my: e.clientY, wx: parseInt(win.style.left||'0'), wy: parseInt(win.style.top||'0') };
    });
    document.addEventListener('pointermove', (e) => {
      if (!dragStart) return;
      const sw = window.innerWidth, sh = window.innerHeight;
      const ww = win.offsetWidth,   wh = win.offsetHeight;
      let nx = dragStart.wx + (e.clientX - dragStart.mx);
      let ny = dragStart.wy + (e.clientY - dragStart.my);
      if (Math.abs(nx) < 12) nx = 0;
      if (Math.abs(nx + ww - sw) < 12) nx = sw - ww;
      if (Math.abs(ny) < 12) ny = 0;
      if (Math.abs(ny + wh - sh) < 12) ny = sh - wh;
      nx = Math.max(0, Math.min(nx, sw - 60));
      ny = Math.max(0, Math.min(ny, sh - 32));
      win.style.left = nx + 'px';
      win.style.top  = ny + 'px';
    });
    document.addEventListener('pointerup', () => {
      if (dragStart) { dragStart = null; saveRect(); }
    });
  })();

  (function() {
    let resStart = null;
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      resStart = { mx: e.clientX, my: e.clientY, w: win.offsetWidth, h: win.offsetHeight };
    });
    document.addEventListener('pointermove', (e) => {
      if (!resStart) return;
      const nw = Math.max(480, Math.min(window.innerWidth * 0.9,  resStart.w + (e.clientX - resStart.mx)));
      const nh = Math.max(280, Math.min(window.innerHeight * 0.85, resStart.h + (e.clientY - resStart.my)));
      win.style.width  = nw + 'px';
      win.style.height = nh + 'px';
    });
    document.addEventListener('pointerup', () => {
      if (resStart) { resStart = null; saveRect(); }
    });
  })();

  $('.tb-close').addEventListener('click', hideWin);

  // ─── Status indicator updater ─────────────────────────────────────────────
  function updateStatus() {
    const R = window.__rbRec || {};
    const flags = R.flags || {};
    statusStore.classList.remove('on', 'err');
    if (flags.storeStatus === 'attached') statusStore.classList.add('on');
    else if (flags.storeStatus === 'not-found') statusStore.classList.add('err');
    statusStore.title = 'store: ' + (flags.storeStatus || 'idle');
    statusBridge.classList.remove('on');
    if ((flags.bridgeStatus || '').includes('tapped')) statusBridge.classList.add('on');
    statusBridge.title = 'bridge: ' + (flags.bridgeStatus || 'idle');
    statusRec.classList.remove('on');
    if (R.running) statusRec.classList.add('on');
    statusRec.title = 'recorder: ' + (R.running ? 'running (' + (R.events||[]).length + ' events)' : 'idle');
  }
  setInterval(updateStatus, 1000);

  // ─── Command registry ─────────────────────────────────────────────────────
  const commands = {};
  function registerCommand(path, handler, help) {
    commands[path] = { handler, help };
  }
  function listCommandPaths() {
    return Object.keys(commands).map(p => '/' + p.replace(/\./g, ' ')).sort();
  }
  function runCommand(line) {
    const tokens = line.slice(1).trim().split(/\s+/);
    for (let i = Math.min(tokens.length, 2); i >= 1; i--) {
      const path = tokens.slice(0, i).join('.');
      if (commands[path]) {
        Promise.resolve()
          .then(() => commands[path].handler(tokens.slice(i)))
          .catch(e => con.printErr('handler error: ' + (e && e.message || e)))
          .finally(() => con.blank());
        return;
      }
    }
    con.printErr('unknown command: ' + tokens[0]);
    con.printDim('type /help to see available commands.');
    con.blank();
  }

  // ─── Bridge holder ─────────────────────────────────────────────────────────
  let _bridge = null;
  function bridge() { if (!_bridge) _bridge = detectBridge(); return _bridge; }

  // ─── Command handlers ─────────────────────────────────────────────────────
  registerCommand('help', (args) => {
    if (args.length) {
      const path = args.join('.');
      const c = commands[path];
      if (!c) { con.printErr('no help for: /' + args.join(' ')); return; }
      con.println('/' + args.join(' '));
      con.printDim('  ' + (c.help || '(no description)'));
      return;
    }
    con.println('Available commands:');
    con.blank();
    const paths = Object.keys(commands).sort();
    for (const p of paths) {
      const path = '/' + p.replace(/\./g, ' ');
      con.raw(`  <span class="cmd-name">${_esc(path.padEnd(28))}</span><span class="dim">${_esc(commands[p].help || '')}</span>`);
    }
  }, 'List all commands. Use /help <cmd> for one.');

  registerCommand('clear', () => con.clear(), 'Clear scrollback');

  registerCommand('who', () => {
    con.printKV([
      ['identity', identity || '(none — type /name <name>)'],
      ['url', location.href.slice(0, 70)],
      ['bluebook', bridge()?.obj?.version || '(unknown)'],
    ]);
  }, 'Show current identity + Bluebook URL');

  registerCommand('name', (args) => {
    if (!args.length) {
      con.println('identity: ' + (identity || '(none)'));
      con.printDim('use /name <name> to change');
      return;
    }
    identity = args.join(' ');
    try { localStorage.setItem(IDENTITY_KEY, identity); } catch (_) {}
    con.printOk('identity set to: ' + identity);
  }, 'Set your display name');

  registerCommand('version', () => {
    con.printKV([
      ['redbook console', '0.9.6'],
      ['bluebook',        bridge()?.obj?.version || '(unknown)'],
      ['bridge',          bridge() ? 'window.' + bridge().key : '(not detected)'],
      ['user agent',      navigator.userAgent.match(/Electron\/[^ ]+/)?.[0] || navigator.userAgent.slice(0, 50)],
    ]);
  }, 'Show version info');

  registerCommand('dense', () => {
    denseMode = !denseMode;
    try { localStorage.setItem(DENSE_KEY, denseMode ? '1' : '0'); } catch (_) {}
    win.classList.toggle('dense', denseMode);
    con.printOk('dense mode: ' + (denseMode ? 'on' : 'off'));
  }, 'Toggle dense scrollback');

  // (bridge.*, state.* commands removed — developer-only)

  registerCommand('session.save', async (args) => {
    const name = args.join('_') || undefined;
    const sp = con.spinner('saving session...');
    const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return o; };
    try {
      const r = await rbIpc('session.save', {
        name, url: location.href,
        localStorage: dump(localStorage), sessionStorage: dump(sessionStorage),
      });
      if (r && r.error) sp.err(r.error);
      else sp.ok('saved -> ' + (r.path || JSON.stringify(r)));
    } catch (e) { sp.err(e.message); }
  }, 'Save session (storage + cookies)');

  registerCommand('session.list', async () => {
    const list = await rbIpc('session.list');
    if (!Array.isArray(list) || list.length === 0) { con.printDim('(no saved sessions)'); return; }
    con.printTable(['name', 'size', 'saved'], list.map(s => [s.name, (s.size/1024).toFixed(1) + 'K', s.mtime.slice(0,19).replace('T',' ')]));
  }, 'List saved sessions');

  registerCommand('session.load', async (args) => {
    if (!args.length) { con.printErr('usage: /session load <name>'); return; }
    const sp = con.spinner('loading session...');
    try {
      const data = await rbIpc('session.load', { name: args[0] });
      if (data.error) { sp.err(data.error); return; }
      if (data.localStorage) { localStorage.clear(); for (const [k,v] of Object.entries(data.localStorage)) localStorage.setItem(k, v); }
      if (data.sessionStorage) { sessionStorage.clear(); for (const [k,v] of Object.entries(data.sessionStorage)) sessionStorage.setItem(k, v); }
      sp.ok('storage + cookies restored. reloading in 400ms...');
      setTimeout(() => { if (data.url) location.href = data.url; else location.reload(); }, 400);
    } catch (e) { sp.err(e.message); }
  }, 'Restore a session and reload');

  registerCommand('session.delete', async (args) => {
    if (!args.length) { con.printErr('usage: /session delete <name>'); return; }
    try { await rbIpc('session.delete', { name: args[0] }); con.printOk('deleted ' + args[0]); }
    catch (e) { con.printErr(e.message); }
  }, 'Delete a saved session');

  registerCommand('security.check', () => {
    const br = bridge(); if (!br) { con.printErr('bridge not detected'); return; }
    try { br.obj.performSecurityCheck?.({}); con.printOk('performSecurityCheck dispatched (results via on* events; toasts will appear on detections)'); }
    catch (e) { con.printErr(e.message); }
  }, 'Run performSecurityCheck');

  registerCommand('security.restricted', () => {
    const br = bridge(); if (!br) { con.printErr('bridge not detected'); return; }
    try { br.obj.requestRestrictedApps?.(); con.printOk('requestRestrictedApps dispatched'); }
    catch (e) { con.printErr(e.message); }
  }, 'Probe for restricted apps');

  // (security.kiosk/unlock/clearclip/killgrammarly removed — use /kiosk and /patch)

  registerCommand('kiosk', (args) => {
    const br = bridge(); if (!br) { con.printErr('bridge not detected'); return; }
    const mode = (args[0] || '').toLowerCase();
    if (mode === 'on') { try { br.obj.enterKioskMode?.(); con.printOk('entered kiosk mode'); } catch (e) { con.printErr(e.message); } }
    else if (mode === 'off') { try { br.obj.exitKioskMode?.(); con.printOk('exited kiosk mode'); } catch (e) { con.printErr(e.message); } }
    else {
      const isKiosk = document.fullscreenElement ? 'likely on' : 'likely off';
      con.printKV([['kiosk state', isKiosk]]);
      con.printDim('usage: /kiosk on|off');
    }
  }, 'Toggle kiosk mode (on/off)');

  registerCommand('exam.start', () => {
    if (window.__rbRec && window.__rbRec.running) { con.printWarn('recorder already running'); return; }
    installRecorder();
    const R = window.__rbRec;
    R.events = [];
    R.categories = { fetch:0, ws:0, dispatch:0, bridge:0, ipc:0, console:0, window:0, dom:0, storage:0 };
    R.startTs = performance.now();
    R.running = true;
    con.printOk('recorder started');
    con.printDim('store: ' + (R.flags?.storeStatus || '?') + ' · bridge: ' + (R.flags?.bridgeStatus || '?'));
  }, 'Start the exam flow recorder');

  registerCommand('exam.stop', () => {
    if (!window.__rbRec || !window.__rbRec.running) { con.printWarn('recorder not running'); return; }
    window.__rbRec.running = false;
    con.printOk('recorder stopped (' + window.__rbRec.events.length + ' events buffered)');
  }, 'Stop the recorder');

  registerCommand('exam.clear', () => {
    if (!window.__rbRec) { con.printWarn('recorder not installed'); return; }
    window.__rbRec.events = [];
    window.__rbRec.categories = { fetch:0, ws:0, dispatch:0, bridge:0, ipc:0, console:0, window:0, dom:0, storage:0 };
    con.printOk('event buffer cleared');
  }, 'Reset event buffer');

  registerCommand('exam.status', () => {
    const R = window.__rbRec || { events: [], categories: {}, flags: {} };
    con.printKV([
      ['running', String(!!R.running), R.running ? 'ok' : ''],
      ['events',  (R.events || []).length],
      ['store',   R.flags?.storeStatus || 'idle'],
      ['bridge',  R.flags?.bridgeStatus || 'idle'],
    ]);
    const cats = R.categories || {};
    con.blank();
    con.printDim('── event counts ──');
    const rows = Object.entries(cats).map(([k, v]) => [k, v]);
    if (rows.length) con.printTable(['category', 'count'], rows);
  }, 'Recorder status snapshot');

  registerCommand('exam.save', async (args) => {
    const name = args.join('_') || ('exam_' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-'));
    const R = window.__rbRec || {};
    const sp = con.spinner('saving recording...');
    try {
      const payload = {
        meta: {
          startedAt: R.startTs ? new Date(Date.now() - (performance.now() - R.startTs)).toISOString() : new Date().toISOString(),
          url: location.href,
          eventCount: (R.events || []).length,
          categories: { ...(R.categories || {}) },
          spoof: {
            enabled: !!SPOOF.enabled,
            targetEventTypeCd: SPOOF.targetEventTypeCd,
            dispatchRewriteCount: SPOOF.dispatchRewriteCount || 0,
            dispatchRewrites: (SPOOF.dispatchRewrites || []).slice(0, 20),
            fetchRewriteCount: SPOOF.fetchRewriteCount || 0,
            fetchRewrites: (SPOOF.fetchRewrites || []).slice(0, 20),
          },
          flags: R.flags,
        },
        events: R.events || [],
      };
      let size;
      try { size = JSON.stringify(payload).length; }
      catch (e) { sp.err('stringify: ' + e.message); return; }
      const timeout = Math.max(15000, Math.ceil(size / 1024) * 50);
      const r = await rbIpc('recording.save', { name, payload }, { timeout });
      if (r && r.error) sp.err(r.error + ' (~' + (size/1024).toFixed(1) + ' KB)');
      else sp.ok('saved -> ' + r.path + ' (' + (R.events || []).length + ' events, ' + (size/1024).toFixed(1) + ' KB)');
    } catch (e) { sp.err(e.message); }
  }, 'Save recording to file');

  registerCommand('exam.list', async () => {
    const list = await rbIpc('recording.list');
    if (!Array.isArray(list) || list.length === 0) { con.printDim('(no saved recordings)'); return; }
    con.printTable(['name', 'size', 'saved'], list.map(s => [s.name, (s.size/1024).toFixed(1) + 'K', s.mtime.slice(0,19).replace('T',' ')]));
  }, 'List saved recordings');

  registerCommand('exam.spoof', (args) => {
    const mode = (args[0] || '').toLowerCase();
    if (mode === 'on') {
      SPOOF.enabled = true; installSpoofer();
      con.printOk('spoofer enabled (target asmtEventTypeCd=' + SPOOF.targetEventTypeCd + ')');
    } else if (mode === 'off') {
      SPOOF.enabled = false;
      con.printOk('spoofer disabled');
    } else if (mode === 'target') {
      if (!args[1]) { con.printErr('usage: /exam spoof target <code>'); return; }
      const code = parseInt(args[1]);
      if (isNaN(code)) { con.printErr('invalid code'); return; }
      SPOOF.targetEventTypeCd = code;
      con.printOk('target asmtEventTypeCd = ' + code);
    } else {
      con.printKV([
        ['enabled',                String(!!SPOOF.enabled), SPOOF.enabled ? 'ok' : ''],
        ['target asmtEventTypeCd', SPOOF.targetEventTypeCd],
        ['dispatch rewrites',      SPOOF.dispatchRewriteCount || 0],
        ['fetch rewrites',         SPOOF.fetchRewriteCount || 0],
      ]);
      con.printDim('usage: /exam spoof on|off|target <code>');
      con.printDim('codes: 1=OPERATIONAL 2=PILOT_IN_SCHOOL 3=PILOT_WEEKEND 4=ABBREVIATED_PRACTICE 5=AP_MAKEUP 6=AP_EXCEPTION 7=SCHOOL_DAY_MAKEUP');
    }
  }, 'Toggle dispatch interceptor; set target event type');

  // (exam.dispatch, sentry.debug, sentry.user removed — developer-only)

  registerCommand('theme', (args) => {
    const next = (args[0] || '').toLowerCase();
    if (!next) {
      con.println('current: ' + (localStorage.getItem('redbook-theme') || 'default'));
      con.printDim('usage: /theme bluebook|redbook');
      return;
    }
    if (next !== 'bluebook' && next !== 'redbook') { con.printErr('usage: /theme bluebook|redbook'); return; }
    const themeName = next === 'redbook' ? 'redbook' : 'default';
    if (typeof window.__rbApplyTheme === 'function') { window.__rbApplyTheme(themeName); con.printOk('applied: ' + next); }
    else con.printErr('theme apply function not exposed');
  }, 'Apply a theme');

  registerCommand('devtools', async () => {
    const sp = con.spinner('toggling devtools');
    try {
      const r = await rbIpc('devtools.toggle');
      if (r && r.error) sp.err(r.error);
      else sp.ok('devtools ' + (r.state || 'toggled'));
    } catch (e) { sp.err(e.message); }
  }, 'Toggle Chrome DevTools (use AFTER login)');

  registerCommand('log', async (args) => {
    const n = parseInt(args[0]) || 50;
    const sp = con.spinner('fetching log tail');
    try {
      const text = await rbIpc('log.tail', { lines: n });
      sp.ok('last ' + n + ' lines:');
      con.raw('<pre class="log-tail dim">' + _esc(text) + '</pre>');
    } catch (e) { sp.err(e.message); }
  }, 'Tail _run.log');

  registerCommand('relaunch', async () => {
    if (!confirm('Relaunch the entire app? Unsaved exam state will be lost.')) return;
    await rbIpc('app.relaunch');
  }, 'Relaunch the Bluebook app');

  // ─── /ai command ──────────────────────────────────────────────────────────
  registerCommand('ai', async (args) => {
    const mode = (args[0] || '').toLowerCase();
    if (mode === 'open' || !mode) {
      const sp = con.spinner('opening gemini…');
      const r = await rbIpc('ai.open');
      if (r && r.error) sp.err(r.error);
      else sp.ok('gemini opened — Ctrl+Shift+G to toggle');
    } else if (mode === 'claude') {
      const sp = con.spinner('opening claude…');
      const r = await rbIpc('ai.open', { url: 'https://claude.ai' });
      if (r && r.error) sp.err(r.error);
      else sp.ok('claude opened — Ctrl+Shift+G to toggle');
    } else if (mode === 'close') {
      const sp = con.spinner('closing gemini…');
      const r = await rbIpc('ai.close');
      if (r && r.error) sp.err(r.error);
      else sp.ok('gemini closed');
    } else if (mode === 'toggle') {
      const r = await rbIpc('ai.toggle');
      if (r && r.error) con.printErr(r.error);
      else con.printOk('gemini ' + (r.visible ? 'shown' : 'hidden'));
    } else if (mode === 'status') {
      const r = await rbIpc('ai.state');
      con.printKV([
        ['window', r.open ? 'open' : 'closed', r.open ? 'ok' : ''],
        ['visible', r.open ? String(r.visible) : '-'],
        ['url', r.url || '-'],
      ]);
    } else if (mode === 'url') {
      const url = args.slice(1).join(' ');
      if (!url) { con.printErr('usage: /ai url <url>'); return; }
      const sp = con.spinner('navigating…');
      const r = await rbIpc('ai.navigate', { url });
      if (r && r.error) sp.err(r.error);
      else sp.ok('navigated → ' + url);
    } else {
      con.printErr('usage: /ai open|close|toggle|status|url');
    }
  }, 'Open Gemini AI in a side window');

  // ─── /patch command ────────────────────────────────────────────────────────
  function patchShowBadge() {
    if (PATCH.badgeEl) return;
    const statusBar = shadow.querySelector('.tb-status');
    if (!statusBar) return;
    const badge = document.createElement('span');
    badge.className = 'tb-patch-badge';
    badge.textContent = 'PATCH ✓';
    badge.title = 'Click to disable security patch';
    badge.style.cssText = 'background:rgba(239,68,68,0.15);border:1px solid #991b1b;color:#ef4444;'
      + 'font-size:9px;padding:1px 6px;cursor:pointer;margin-left:4px;font-weight:700;letter-spacing:0.3px;';
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      doPatchOff();
    });
    statusBar.appendChild(badge);
    PATCH.badgeEl = badge;
  }

  function patchHideBadge() {
    if (PATCH.badgeEl) {
      PATCH.badgeEl.remove();
      PATCH.badgeEl = null;
    }
  }

  // ── Clipboard bypass: IPC to main process (before-input-event + webContents.copy) ──
  function installClipboardBypass() {
    if (PATCH._clipboardInstalled) return;
    rbIpc('clipboard.enable');

    // Suppress bridge.clearClipboard() — prevents Bluebook from wiping clipboard
    const br = detectBridge();
    if (br && typeof br.obj.clearClipboard === 'function' && !PATCH._origClearClipboard) {
      PATCH._origClearClipboard = br.obj.clearClipboard;
      br.obj.clearClipboard = function() {
        if (PATCH.enabled) {
          patchLog('clipboard', 'clearClipboard suppressed');
          return;
        }
        return PATCH._origClearClipboard.apply(this, arguments);
      };
    }

    PATCH._clipboardInstalled = true;
  }

  function removeClipboardBypass() {
    if (!PATCH._clipboardInstalled) return;
    rbIpc('clipboard.disable');
    // Restore original clearClipboard
    const br = detectBridge();
    if (br && PATCH._origClearClipboard) {
      br.obj.clearClipboard = PATCH._origClearClipboard;
      PATCH._origClearClipboard = null;
    }
    PATCH._clipboardInstalled = false;
  }

  function patchDisable() {
    PATCH.enabled = false;
    removePatchDomObserver();
    removeFocusSuppressor();
    removeClipboardBypass();
    patchHideBadge();
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Unified progress box renderer used by both /patch on and /patch off
  const SPIN_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  function patchBox(title) {
    // Single box: title line + status message + progress bar — all in one div
    const box = con.raw('');
    box.style.cssText = 'border:1px solid #1a1d23;background:#0e1014;padding:8px 12px;margin:2px 0;';
    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'color:#ef4444;font-weight:700;font-size:11px;margin-bottom:6px;';
    titleEl.textContent = '卐  ' + title;
    const msgEl = document.createElement('div');
    msgEl.style.cssText = 'color:#e4e6ea;font-size:10px;margin-bottom:6px;min-height:13px;';
    const barWrap = document.createElement('div');
    barWrap.style.cssText = 'font-size:10px;line-height:1;';
    box.appendChild(titleEl);
    box.appendChild(msgEl);
    box.appendChild(barWrap);
    let spinIv = null;
    let spinIdx = 0;
    return {
      el: box,
      setMsg(text) { msgEl.innerHTML = '<span style="color:#ef4444">' + SPIN_FRAMES[0] + '</span> ' + _esc(text); spinIdx = 0; if (!spinIv) { spinIv = setInterval(() => { spinIdx = (spinIdx+1)%SPIN_FRAMES.length; const s = msgEl.querySelector('span'); if (s) s.textContent = SPIN_FRAMES[spinIdx]; }, 80); } scrollToBottom(); },
      setBar(pct) {
        const w = 30;
        const filled = Math.round((pct / 100) * w);
        const empty = w - filled;
        barWrap.innerHTML = '<span style="color:#71757d">' + String(Math.round(pct)).padStart(3) + '%</span> '
          + '<span style="color:#ef4444">' + '━'.repeat(filled) + '</span>'
          + '<span style="color:#3f434b">' + '━'.repeat(empty) + '</span>';
        scrollToBottom();
      },
      done(text) { if (spinIv) { clearInterval(spinIv); spinIv = null; } msgEl.innerHTML = '<span style="color:#86efac">✓</span> ' + _esc(text); this.setBar(100); scrollToBottom(); },
      err(text) { if (spinIv) { clearInterval(spinIv); spinIv = null; } msgEl.innerHTML = '<span style="color:#fb7185">✗</span> ' + _esc(text); scrollToBottom(); },
    };
  }

  async function doPatchOn() {
    if (PATCH.enabled) { con.printWarn('patch is already active. /patch off to disable.'); return; }
    if (!REC.installed) installRecorder();

    const pb = patchBox('SECURITY PATCH');
    pb.setBar(0);

    // Step 1: dispatch filter
    pb.setMsg('attaching dispatch filter…');
    pb.setBar(5);
    await delay(300);
    if (!window.__rbStore) { const store = findReduxStore(); if (store) window.__rbStore = store; }
    pb.setBar(15);
    await delay(200);

    // Step 2: telemetry filter
    pb.setMsg('hooking telemetry filter…');
    pb.setBar(25);
    await delay(300);
    pb.setBar(40);
    await delay(200);

    // Step 3: focus/resize suppressor — prevent Bluebook from reacting to AI window
    pb.setMsg('hooking focus suppressor…');
    pb.setBar(45);
    await delay(200);
    installFocusSuppressor();
    pb.setBar(50);
    await delay(150);

    // Step 4: DOM suppressor
    pb.setMsg('installing dom suppressor…');
    pb.setBar(50);
    await delay(200);
    installPatchDomObserver();
    pb.setBar(53);
    await delay(150);

    // Step 5: clipboard bypass
    pb.setMsg('enabling clipboard bypass…');
    pb.setBar(55);
    await delay(200);
    installClipboardBypass();
    pb.setBar(58);
    await delay(150);

    // Enable
    PATCH.enabled = true;

    // Step 6: verify
    pb.setMsg('verifying patch…');
    pb.setBar(60);
    await delay(200);
    const br = bridge();
    if (br && typeof br.obj.performSecurityCheck === 'function') {
      try { br.obj.performSecurityCheck({}); } catch (_) {}
    }
    pb.setBar(70);
    await delay(800);
    pb.setBar(85);
    await delay(800);
    pb.setBar(95);
    await delay(300);

    // Complete
    pb.done('security patch active — /patch off to disable');
    patchShowBadge();
  }

  async function doPatchOff() {
    if (!PATCH.enabled) { con.printWarn('patch is not active'); return; }
    const bd = PATCH.blockedDispatches;
    const bt = PATCH.blockedTelemetry;
    const bdom = PATCH.blockedDom;

    const pb = patchBox('DISABLING PATCH');
    pb.setBar(0);

    // Step 1: remove dispatch filter
    pb.setMsg('removing dispatch filter…');
    pb.setBar(10);
    await delay(300);
    pb.setBar(25);
    await delay(200);

    // Step 2: remove telemetry filter
    pb.setMsg('removing telemetry filter…');
    pb.setBar(35);
    await delay(300);
    pb.setBar(50);
    await delay(200);

    // Step 3: remove DOM suppressor
    pb.setMsg('disconnecting dom suppressor…');
    pb.setBar(55);
    await delay(200);
    pb.setBar(70);
    await delay(200);

    // Disable
    patchDisable();

    // Step 4: re-scan
    pb.setMsg('re-scanning security state…');
    pb.setBar(75);
    await delay(200);
    const brOff = bridge();
    if (brOff) {
      try { brOff.obj.performSecurityCheck?.({}); } catch (_) {}
      try { brOff.obj.requestRestrictedApps?.(); } catch (_) {}
    }
    pb.setBar(90);
    await delay(500);
    pb.setBar(95);
    await delay(300);

    // Complete
    pb.done('patch disabled — blocked ' + bd + ' dispatches, ' + bt + ' telemetry, ' + bdom + ' dom');
  }

  registerCommand('patch', async (args) => {
    const mode = (args[0] || '').toLowerCase();
    if (mode === 'off') return doPatchOff();
    if (mode === 'on' || !mode) return doPatchOn();
    if (mode === 'status') {
      con.printKV([
        ['enabled', String(PATCH.enabled), PATCH.enabled ? 'ok' : ''],
        ['dispatch filter', PATCH.enabled ? 'armed (' + SECURITY_ACTION_PATTERNS.length + ' patterns)' : 'off'],
        ['telemetry filter', PATCH.enabled ? 'armed (' + SECURITY_TELEMETRY_PATTERNS.length + ' patterns)' : 'off'],
        ['focus suppressor', Object.keys(_focusOriginals).length > 0 ? 'active (' + Object.keys(_focusOriginals).length + ' hooks)' : 'off'],
        ['clipboard bypass', PATCH._clipboardInstalled ? 'active' : 'off'],
        ['dom suppressor', PATCH.domObserver ? 'active' : 'off'],
        ['dispatches blocked', PATCH.blockedDispatches],
        ['telemetry blocked', PATCH.blockedTelemetry],
        ['dom nodes hidden', PATCH.blockedDom],
      ]);
      if (PATCH.log.length) {
        con.blank();
        con.printDim('── recent intercepts ──');
        const recent = PATCH.log.slice(-10);
        for (const entry of recent) {
          const ts = new Date(entry.t).toTimeString().slice(0, 8);
          con.raw('<span class="dim">' + ts + '</span> <span class="tag-' + (entry.layer === 'dispatch' ? 'info' : entry.layer === 'telemetry' ? 'err' : 'ok') + '">[' + _esc(entry.layer) + ']</span> ' + _esc(entry.detail));
        }
      }
      return;
    }
    con.printErr('usage: /patch on|off|status');
  }, 'Security patch control');

  // (patch.on, patch.off, patch.status removed — use /patch on|off|status via argument autocomplete)

  registerCommand('hide', () => hideWin(), 'Hide the console window');

  // ─── Boot ──────────────────────────────────────────────────────────────────
  showBanner();
  syncInput();

  // ─── Recorder data store + helpers (preserved) ─────────────────────────────
  const REC = window.__rbRec || (window.__rbRec = {
    events: [], running: false,
    startTs: 0,
    categories: { fetch:0, ws:0, dispatch:0, bridge:0, ipc:0, console:0, window:0, dom:0, storage:0 },
    flags: { storeStatus: 'idle', bridgeStatus: 'idle', wrappedOnMethods: [] },
    installed: false,
    listeners: [],
    max: 5000,
  });
  function recPush(cat, type, data) {
    if (!REC.running) return;
    if (REC.events.length >= REC.max) return;
    const ev = {
      t: REC.startTs ? performance.now() - REC.startTs : 0,
      cat, type, data: safeClone(data),
    };
    REC.events.push(ev);
    REC.categories[cat] = (REC.categories[cat] || 0) + 1;
  }
  function safeClone(v) {
    if (v == null) return v;
    try {
      const s = JSON.stringify(v, (k, val) => {
        if (typeof val === 'function') return '[function]';
        if (val instanceof Error) return { name: val.name, message: val.message, stack: (val.stack || '').split('\n').slice(0, 4).join('\n') };
        if (typeof val === 'string' && val.length > 2000) return val.slice(0, 2000) + `…[+${val.length - 2000} chars]`;
        return val;
      });
      return JSON.parse(s);
    } catch (e) {
      try { return String(v).slice(0, 400); } catch (_) { return '[unserializable]'; }
    }
  }

  function installRecorder() {
    if (REC.installed) return;
    REC.installed = true;

    // ── fetch wrapper ─────────────────────────────────────────────────────
    const realFetch = window.fetch.bind(window);
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const body = init && init.body;
      let reqBody = null;
      try {
        if (typeof body === 'string') reqBody = body.slice(0, 2000);
        else if (body) reqBody = '[non-string body: ' + (body.constructor && body.constructor.name) + ']';
      } catch (_) {}
      const isGql = /\/graphql/i.test(url);
      let opName = null;
      if (isGql && typeof body === 'string') {
        try {
          const j = JSON.parse(body);
          opName = j.operationName || (j.query || '').match(/(?:query|mutation|subscription)\s+(\w+)/)?.[1] || null;
        } catch (_) {}
      }
      // PATCH: intercept security telemetry before it leaves the renderer
      if (PATCH.enabled && isGql && opName === 'SendTelemetry' && isSecurityTelemetry(typeof body === 'string' ? body : '')) {
        PATCH.blockedTelemetry++;
        patchLog('telemetry', 'SendTelemetry');
        recPush('fetch', '@@RB/patch-blocked-telemetry', { url: url.slice(0, 300), opName });
        return new Response(JSON.stringify({ data: { sendTelemetry: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const t0 = performance.now();
      recPush('fetch', 'request', { url: url.slice(0, 300), method, opName, body: reqBody });
      try {
        const res = await realFetch(input, init);
        const dt = performance.now() - t0;
        let respPreview = null;
        try {
          if (isGql) {
            const clone = res.clone();
            const txt = await clone.text();
            respPreview = txt.length > 2000 ? txt.slice(0, 2000) + `…[+${txt.length - 2000}]` : txt;
          }
        } catch (_) {}
        recPush('fetch', 'response', { url: url.slice(0, 300), opName, status: res.status, dt: Math.round(dt), body: respPreview });
        return res;
      } catch (e) {
        recPush('fetch', 'error', { url: url.slice(0, 300), error: String(e && e.message || e) });
        throw e;
      }
    };
    REC.listeners.push({ name: 'fetch', off: () => { window.fetch = realFetch; } });

    // ── XHR wrapper ───────────────────────────────────────────────────────
    const XOP = XMLHttpRequest.prototype.open;
    const XSEND = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__rb = { method, url, t0: performance.now() };
      return XOP.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
      const meta = this.__rb || {};
      recPush('fetch', 'xhr-send', { url: (meta.url || '').slice(0, 300), method: meta.method, body: typeof body === 'string' ? body.slice(0, 500) : null });
      this.addEventListener('loadend', () => {
        recPush('fetch', 'xhr-done', { url: (meta.url || '').slice(0, 300), status: this.status, dt: Math.round(performance.now() - meta.t0) });
      });
      return XSEND.apply(this, arguments);
    };
    REC.listeners.push({ name: 'xhr', off: () => {
      XMLHttpRequest.prototype.open = XOP;
      XMLHttpRequest.prototype.send = XSEND;
    }});

    // ── WebSocket wrapper ─────────────────────────────────────────────────
    const realWS = window.WebSocket;
    function RecWS(url, protocols) {
      const ws = protocols === undefined ? new realWS(url) : new realWS(url, protocols);
      recPush('ws', 'open', { url: String(url).slice(0, 200) });
      ws.addEventListener('message', e => recPush('ws', 'message', { url: String(url).slice(0, 200), data: typeof e.data === 'string' ? e.data.slice(0, 800) : '[binary]' }));
      ws.addEventListener('close', () => recPush('ws', 'close', { url: String(url).slice(0, 200) }));
      ws.addEventListener('error', () => recPush('ws', 'error', { url: String(url).slice(0, 200) }));
      const realSend = ws.send.bind(ws);
      ws.send = function(d) { recPush('ws', 'send', { data: typeof d === 'string' ? d.slice(0, 800) : '[binary]' }); return realSend(d); };
      return ws;
    }
    RecWS.prototype = realWS.prototype;
    RecWS.CONNECTING = realWS.CONNECTING; RecWS.OPEN = realWS.OPEN;
    RecWS.CLOSING = realWS.CLOSING;       RecWS.CLOSED = realWS.CLOSED;
    window.WebSocket = RecWS;
    REC.listeners.push({ name: 'ws', off: () => { window.WebSocket = realWS; } });

    // ── Redux store wrap (with spoofer interceptor) ───────────────────────
    REC.flags = REC.flags || { storeStatus: 'searching', bridgeStatus: 'pending', wrappedOnMethods: [] };
    let storeWrapped = false;
    function tryWrapStore() {
      if (storeWrapped) return true;
      const store = findReduxStore();
      if (!store || typeof store.dispatch !== 'function') return false;
      const realDispatch = store.dispatch.bind(store);
      store.dispatch = function(action) {
        // PATCH: silently drop security-related Redux actions
        if (PATCH.enabled && action && typeof action === 'object' && isSecurityAction(action)) {
          PATCH.blockedDispatches++;
          patchLog('dispatch', action.type);
          return action; // swallow — return action so callers don't crash on undefined
        }
        if (SPOOF && SPOOF.enabled && action && typeof action === 'object') {
          try { action = applyDispatchSpoof(action); }
          catch (e) { recPush('dispatch', '@@RB/spoof-error', String(e && e.message || e)); }
        }
        try {
          if (action && typeof action === 'object') {
            const type = action.type || '[no-type]';
            recPush('dispatch', String(type).slice(0, 120), {
              payload: action.payload !== undefined ? action.payload : action,
              meta: action.meta,
            });
          } else {
            recPush('dispatch', '[fn-action]', null);
          }
        } catch (_) {}
        return realDispatch(action);
      };
      window.__rbStore = store;
      storeWrapped = true;
      REC.flags.storeStatus = 'attached';
      let keys = [];
      try { keys = Object.keys(store.getState() || {}); } catch (_) {}
      recPush('dispatch', '@@RB/store-attached', { keys });
      REC.listeners.push({ name: 'dispatch', off: () => {
        try { store.dispatch = realDispatch; } catch (_) {}
        storeWrapped = false;
      }});
      return true;
    }
    function applyDispatchSpoof(action) {
      if (action.type !== 'registrations/ADD_REGISTRATION') return action;
      const reg = action.payload && action.payload.registration;
      if (!reg || !reg.event) return action;
      const before = reg.event.asmtEventTypeCd;
      if (typeof before !== 'number') return action;
      const after = SPOOF.targetEventTypeCd;
      if (before === after) return action;
      let cloned;
      try { cloned = JSON.parse(JSON.stringify(action)); }
      catch (_) { return action; }
      cloned.payload.registration.event.asmtEventTypeCd = after;
      SPOOF.dispatchRewriteCount = (SPOOF.dispatchRewriteCount || 0) + 1;
      SPOOF.dispatchRewrites = SPOOF.dispatchRewrites || [];
      if (SPOOF.dispatchRewrites.length < 20) SPOOF.dispatchRewrites.push({
        type: action.type, regId: reg.id, before, after, time: new Date().toISOString().slice(11, 23),
      });
      recPush('dispatch', '@@RB/spoof-rewrite', { type: action.type, regId: reg.id, field: 'event.asmtEventTypeCd', before, after });
      try { window.__rbToast && window.__rbToast('ok', 'spoof rewrite fired', 'event.asmtEventTypeCd', `${before} -> ${after}  on ${reg.id}`); } catch (_) {}
      return cloned;
    }
    if (!tryWrapStore()) {
      REC.flags.storeStatus = 'searching';
      const startedAt = Date.now();
      const tk = setInterval(() => {
        if (tryWrapStore()) { clearInterval(tk); return; }
        if (Date.now() - startedAt > 30000) {
          clearInterval(tk);
          REC.flags.storeStatus = 'not-found';
        }
      }, 250);
    }

    // ── Bridge tap ────────────────────────────────────────────────────────
    const br = detectBridge();
    if (br) {
      window.__rbBridge = br.obj;
      const onMethods = Object.keys(br.obj).filter(k => /^on[A-Z]/.test(k) && typeof br.obj[k] === 'function');
      const tapped = [];
      for (const k of onMethods) {
        try {
          br.obj[k].call(br.obj, function(...args) {
            recPush('bridge', k, args.length === 1 ? args[0] : args);
          });
          tapped.push(k);
        } catch (e) {
          recPush('bridge', '@@RB/tap-fail', { name: k, err: String(e && e.message || e) });
        }
      }
      REC.flags.wrappedOnMethods = tapped;
      REC.flags.bridgeStatus = tapped.length ? ('tapped ' + tapped.length + ' on* methods') : 'tap-failed';
      recPush('bridge', '@@RB/bridge-tapped', { count: tapped.length, methods: tapped });

      let outboundWrapped = 0;
      for (const k of Object.keys(br.obj)) {
        if (/^on[A-Z]/.test(k)) continue;
        const real = br.obj[k];
        if (typeof real !== 'function') continue;
        const wrap = function(...args) {
          recPush('bridge', '→' + k, args.length === 1 ? args[0] : args);
          try { const r = real.apply(this, args); if (r !== undefined) recPush('bridge', '←' + k, r); return r; }
          catch (e) { recPush('bridge', '!' + k, String(e && e.message || e)); throw e; }
        };
        let ok = false;
        try { Object.defineProperty(br.obj, k, { value: wrap, configurable: true, writable: true }); ok = (br.obj[k] === wrap); } catch (_) {}
        if (!ok) { try { br.obj[k] = wrap; ok = (br.obj[k] === wrap); } catch (_) {} }
        if (ok) outboundWrapped++;
      }
      REC.flags.bridgeStatus += '; outbound wrapped ' + outboundWrapped;
      REC.listeners.push({ name: 'bridge', off: () => {} });
    } else {
      REC.flags.bridgeStatus = 'no-bridge-found';
    }

    // ── ipcRenderer (when accessible) ─────────────────────────────────────
    try {
      const ipc = window.require && window.require('electron').ipcRenderer;
      if (ipc && !ipc.__rbWrapped) {
        ipc.__rbWrapped = true;
        const ron = ipc.on.bind(ipc), rinvoke = ipc.invoke.bind(ipc), rsend = ipc.send.bind(ipc);
        ipc.on = function(channel, listener) {
          return ron(channel, function(ev, ...args) {
            recPush('ipc', '←' + channel, args.length === 1 ? args[0] : args);
            return listener && listener(ev, ...args);
          });
        };
        ipc.invoke = function(channel, ...args) {
          recPush('ipc', '→' + channel, args.length === 1 ? args[0] : args);
          return rinvoke(channel, ...args);
        };
        ipc.send = function(channel, ...args) {
          recPush('ipc', '⇒' + channel, args.length === 1 ? args[0] : args);
          return rsend(channel, ...args);
        };
        REC.listeners.push({ name: 'ipc', off: () => { try { ipc.on = ron; ipc.invoke = rinvoke; ipc.send = rsend; ipc.__rbWrapped = false; } catch(_){} } });
      }
    } catch (_) {}

    // ── Console wrapper ───────────────────────────────────────────────────
    const cLog = console.log, cWarn = console.warn, cErr = console.error, cInfo = console.info;
    function isOurNoise(a) {
      if (!a || !a.length) return false;
      const first = a[0];
      if (typeof first !== 'string') return false;
      return first.startsWith('[redbook]') || first.startsWith('<<RB_IPC>>');
    }
    console.log  = function(...a) { try { if (!isOurNoise(a)) recPush('console', 'log',   summarizeArgs(a)); } catch(_){}; return cLog.apply(this, a); };
    console.warn = function(...a) { try { if (!isOurNoise(a)) recPush('console', 'warn',  summarizeArgs(a)); } catch(_){}; return cWarn.apply(this, a); };
    console.error= function(...a) { try { if (!isOurNoise(a)) recPush('console', 'error', summarizeArgs(a)); } catch(_){}; return cErr.apply(this, a); };
    console.info = function(...a) { try { if (!isOurNoise(a)) recPush('console', 'info',  summarizeArgs(a)); } catch(_){}; return cInfo.apply(this, a); };
    REC.listeners.push({ name: 'console', off: () => { console.log = cLog; console.warn = cWarn; console.error = cErr; console.info = cInfo; } });

    // ── Window events ─────────────────────────────────────────────────────
    const winEvents = ['focus','blur','visibilitychange','resize','pagehide','pageshow','beforeunload','online','offline'];
    const onWinEv = (e) => recPush('window', e.type, {
      vis: document.visibilityState,
      hasFocus: document.hasFocus(),
      size: { w: innerWidth, h: innerHeight, sw: screen.width, sh: screen.height },
    });
    for (const t of winEvents) window.addEventListener(t, onWinEv, true);
    document.addEventListener('visibilitychange', onWinEv, true);
    REC.listeners.push({ name: 'window', off: () => {
      for (const t of winEvents) window.removeEventListener(t, onWinEv, true);
      document.removeEventListener('visibilitychange', onWinEv, true);
    }});

    // ── DOM mutation (kiosk/exam/lockdown markers) ────────────────────────
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type !== 'childList') continue;
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const id  = n.id || '';
          const tid = n.getAttribute?.('data-testid') || '';
          const cls = typeof n.className === 'string' ? n.className : '';
          const blob = (id + ' ' + tid + ' ' + cls).toLowerCase();
          if (/exam|kiosk|lockdown|waiting|security|proctor|fullscreen|warn|violation/.test(blob)) {
            recPush('dom', 'mount', { tag: n.tagName, id, testId: tid, cls: cls.slice(0, 80) });
          }
        }
      }
    });
    try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
    REC.listeners.push({ name: 'dom', off: () => { try { mo.disconnect(); } catch(_){} }});

    // ── Storage writes ────────────────────────────────────────────────────
    const lsSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(k, v) {
      const which = this === localStorage ? 'localStorage' : (this === sessionStorage ? 'sessionStorage' : '?');
      recPush('storage', which, { key: k, valuePreview: typeof v === 'string' ? v.slice(0, 200) : String(v).slice(0, 200) });
      return lsSet.call(this, k, v);
    };
    REC.listeners.push({ name: 'storage', off: () => { Storage.prototype.setItem = lsSet; } });
  }

  function summarizeArgs(a) {
    return a.map(x => {
      if (x == null) return x;
      if (typeof x === 'string') return x.length > 300 ? x.slice(0, 300) + '…' : x;
      if (typeof x === 'object') { try { const s = JSON.stringify(x); return s.length > 300 ? s.slice(0, 300) + '…' : s; } catch (_) { return '[object]'; } }
      return String(x);
    });
  }

  // ─── Redux store finder (React fiber walking) ──────────────────────────────
  function findReduxStore() {
    function isStore(o) {
      return o && typeof o.dispatch === 'function' && typeof o.getState === 'function'
          && (typeof o.subscribe === 'function' || typeof o.replaceReducer === 'function');
    }
    if (window.__rbStore && isStore(window.__rbStore)) return window.__rbStore;
    if (isStore(window.store)) return window.store;
    if (isStore(window.__store)) return window.__store;
    for (const k of ['__REDUX_DEVTOOLS_EXTENSION_STORE__','__REDUX_DEVTOOLS_STORE__']) if (window[k] && isStore(window[k])) return window[k];
    try {
      const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (hook && hook.renderers) {
        for (const [, r] of hook.renderers) {
          if (!r || !r.findFiberByHostInstance) continue;
          const probes = document.querySelectorAll('div,main,body');
          for (let i = 0; i < probes.length && i < 200; i++) {
            try {
              const f = r.findFiberByHostInstance(probes[i]);
              if (f) { const found = scanFiberUp(f); if (found) return found; }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
    try {
      const all = document.getElementsByTagName('*');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const keys = Object.keys(el);
        for (const k of keys) {
          if (!(k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$') || k.startsWith('__reactContainer$'))) continue;
          let f = el[k];
          if (f && f.stateNode && f.stateNode.current) f = f.stateNode.current;
          const found = scanFiberUp(f);
          if (found) return found;
        }
      }
    } catch (_) {}
    return null;

    function scanFiberUp(start) {
      const seen = new Set();
      let f = start;
      let steps = 0;
      while (f && steps++ < 5000 && !seen.has(f)) {
        seen.add(f);
        const candidate = pickStoreFromFiber(f);
        if (candidate) return candidate;
        f = f.return;
      }
      const queue = [start];
      while (queue.length && steps++ < 10000) {
        const fi = queue.shift();
        if (!fi || seen.has(fi)) continue;
        seen.add(fi);
        const candidate = pickStoreFromFiber(fi);
        if (candidate) return candidate;
        if (fi.child)   queue.push(fi.child);
        if (fi.sibling) queue.push(fi.sibling);
      }
      return null;
    }
    function pickStoreFromFiber(f) {
      try {
        const slots = [f.memoizedProps, f.memoizedState, f.stateNode, f.pendingProps];
        for (const slot of slots) {
          if (!slot || typeof slot !== 'object') continue;
          if (isStore(slot)) return slot;
          if (isStore(slot.store)) return slot.store;
          if (slot.value && isStore(slot.value)) return slot.value;
          if (slot.value && isStore(slot.value.store)) return slot.value.store;
          if (slot.memoizedState) {
            let hs = slot.memoizedState;
            let n = 0;
            while (hs && n++ < 50) {
              if (isStore(hs.memoizedState)) return hs.memoizedState;
              if (hs.memoizedState && isStore(hs.memoizedState.store)) return hs.memoizedState.store;
              hs = hs.next;
            }
          }
        }
      } catch (_) {}
      return null;
    }
  }

  // ─── Security Patch ─────────────────────────────────────────────────────────
  const PATCH = window.__rbPatch || (window.__rbPatch = {
    enabled: false,
    blockedDispatches: 0,
    blockedTelemetry: 0,
    blockedDom: 0,
    domObserver: null,
    badgeEl: null,
    log: [],
  });

  const SECURITY_ACTION_PATTERNS = [
    'SECURITY_VIOLATION','GRAMMARLY','DEBUGGER_DETECTED','VIRTUAL_MACHINE',
    'RESTRICTED_APP','LOCKDOWN','REMOTE_DESKTOP','HMOD','LOW_BATTERY',
    'SECURITY','VIOLATION','DETECTED','RESTRICTED','PROCESS_LIST',
    'CLIPBOARD','COPY','PASTE','CUT',
  ];
  // Deep check: match action type AND stringify the full action for security keywords
  const SECURITY_PAYLOAD_RE = /grammarly|security.?violation|debugger.?detect|virtual.?machine|restricted.?app|remote.?desktop|lockdown|hmod|process.?list|violation.?type|security.?check|security.?event|clipboard|copy.?event|paste.?event|cut.?event|clipboard.?clear/i;
  function isSecurityAction(action) {
    const type = (action.type || '').toUpperCase();
    if (SECURITY_ACTION_PATTERNS.some(p => type.includes(p))) return true;
    // Deep payload scan — catches actions with security data in payload
    try {
      const s = JSON.stringify(action);
      if (s.length < 5000 && SECURITY_PAYLOAD_RE.test(s)) return true;
    } catch (_) {}
    return false;
  }

  const SECURITY_TELEMETRY_PATTERNS = [
    'SECURITY','VIOLATION','GRAMMARLY','DEBUGGER','VIRTUAL_MACHINE',
    'RESTRICTED','LOCKDOWN','REMOTE_DESKTOP','HMOD',
    'CLIPBOARD','COPY','PASTE','CUT',
  ];
  function isSecurityTelemetry(bodyStr) {
    if (!bodyStr || typeof bodyStr !== 'string') return false;
    const u = bodyStr.toUpperCase();
    return SECURITY_TELEMETRY_PATTERNS.some(p => u.includes(p));
  }

  function patchLog(layer, detail) {
    PATCH.log.push({ t: Date.now(), layer, detail: String(detail).slice(0, 120) });
    if (PATCH.log.length > 50) PATCH.log.shift();
  }

  // ── Aggressive DOM scrubber: content-based, not just selector-based ──
  const SCRUB_TEXT_RE = /grammarly|security.?violation|debugger.?detected|virtual.?machine|restricted.?app|remote.?desktop|close.?grammarly|terminate.?grammarly|security.?warning|detected.?on.?your|not.?allowed.?during/i;
  function patchScrubSecurityUI() {
    if (!PATCH.enabled) return;
    // 1. Check dialogs, modals, overlays, portals by role/attribute
    const selectors = '[role="dialog"],[role="alertdialog"],[data-testid*="modal"],[data-testid*="dialog"],[data-testid*="warning"],[data-testid*="alert"]';
    try {
      document.querySelectorAll(selectors).forEach(el => {
        const text = (el.textContent || '').slice(0, 600);
        if (SCRUB_TEXT_RE.test(text)) {
          el.style.setProperty('display', 'none', 'important');
          PATCH.blockedDom++;
          patchLog('dom-scrub', 'role/attr: ' + text.replace(/\s+/g, ' ').slice(0, 60));
        }
      });
    } catch (_) {}
    // 2. Check any fixed/absolute high-z overlay whose text mentions security
    try {
      const divs = document.querySelectorAll('div,section,aside');
      for (let i = 0; i < divs.length; i++) {
        const el = divs[i];
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
        const z = parseInt(cs.zIndex);
        if (isNaN(z) || z < 100) continue;
        const text = (el.textContent || '').slice(0, 600);
        if (SCRUB_TEXT_RE.test(text)) {
          el.style.setProperty('display', 'none', 'important');
          PATCH.blockedDom++;
          patchLog('dom-scrub', 'overlay z=' + z + ': ' + text.replace(/\s+/g, ' ').slice(0, 50));
        }
      }
    } catch (_) {}
    // 3. Also nuke any backdrop/dimmer that appeared (often siblings of modals)
    try {
      document.querySelectorAll('[class*="backdrop"],[class*="Backdrop"],[class*="overlay"],[class*="Overlay"]').forEach(el => {
        const sib = el.nextElementSibling || el.previousElementSibling;
        if (sib && sib.style.display === 'none') {
          el.style.setProperty('display', 'none', 'important');
        }
      });
    } catch (_) {}
  }

  function installPatchDomObserver() {
    if (PATCH.domObserver) return;
    PATCH.domObserver = new MutationObserver(muts => {
      if (!PATCH.enabled) return;
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          // Selector-based: check id, className, data-testid
          const blob = ((n.id || '') + ' ' + (n.getAttribute?.('data-testid') || '') + ' ' + (typeof n.className === 'string' ? n.className : '')).toLowerCase();
          if (/security|violation|grammarly|lockdown|restricted|debugger|modal|dialog/.test(blob)) {
            const text = (n.textContent || '').slice(0, 600);
            if (SCRUB_TEXT_RE.test(text) || /security|violation|grammarly|debugger|restricted/.test(blob)) {
              n.style.setProperty('display', 'none', 'important');
              PATCH.blockedDom++;
              patchLog('dom', blob.trim().slice(0, 80));
              continue;
            }
          }
          // Content-based: check textContent of any new element for security keywords
          if (n.children && n.children.length > 0) {
            const text = (n.textContent || '').slice(0, 600);
            if (SCRUB_TEXT_RE.test(text)) {
              // Verify it looks like a modal/overlay (not just a random div)
              const cs = getComputedStyle(n);
              if (cs.position === 'fixed' || cs.position === 'absolute' || n.getAttribute('role') === 'dialog' || n.getAttribute('role') === 'alertdialog') {
                n.style.setProperty('display', 'none', 'important');
                PATCH.blockedDom++;
                patchLog('dom-content', text.replace(/\s+/g, ' ').slice(0, 80));
              }
            }
          }
        }
      }
    });
    PATCH.domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function removePatchDomObserver() {
    if (PATCH.domObserver) {
      try { PATCH.domObserver.disconnect(); } catch (_) {}
      PATCH.domObserver = null;
    }
  }

  // ── Focus/resize suppressor: monkey-patch bridge on* methods so Bluebook's
  //    own callbacks get wrapped with our patch filter. This prevents kiosk mode
  //    from killing the AI window when focus changes. ──
  const FOCUS_SUPPRESS_METHODS = ['onWindowFocusChanged', 'onLockdownWindowResized'];
  const _focusOriginals = {}; // method name → original function

  function installFocusSuppressor() {
    const br = detectBridge();
    if (!br) return;
    for (const method of FOCUS_SUPPRESS_METHODS) {
      if (_focusOriginals[method]) continue; // already patched
      const orig = br.obj[method];
      if (typeof orig !== 'function') continue;
      _focusOriginals[method] = orig;
      br.obj[method] = function patchedRegister(callback) {
        // Wrap Bluebook's callback: when patch is active, swallow the event
        return orig.call(br.obj, function(...args) {
          if (PATCH.enabled) {
            PATCH.blockedDispatches++;
            patchLog('focus-suppress', method);
            [50, 150, 400, 800, 1500].forEach(function(ms) {
              setTimeout(patchScrubSecurityUI, ms);
            });
            return;
          }
          if (typeof callback === 'function') callback.apply(this, args);
        });
      };
    }
    // Also suppress the window blur/visibilitychange events that Bluebook's
    // renderer-side JS listens to directly (not via bridge)
    if (!PATCH._blurSuppressor) {
      PATCH._blurSuppressor = function(e) {
        if (PATCH.enabled) {
          e.stopImmediatePropagation();
          patchLog('focus-suppress', 'window.' + e.type);
        }
      };
      window.addEventListener('blur', PATCH._blurSuppressor, true);
      document.addEventListener('visibilitychange', PATCH._blurSuppressor, true);
    }
  }

  function removeFocusSuppressor() {
    const br = detectBridge();
    if (br) {
      for (const method of FOCUS_SUPPRESS_METHODS) {
        if (_focusOriginals[method]) {
          br.obj[method] = _focusOriginals[method];
          delete _focusOriginals[method];
        }
      }
    }
    if (PATCH._blurSuppressor) {
      window.removeEventListener('blur', PATCH._blurSuppressor, true);
      document.removeEventListener('visibilitychange', PATCH._blurSuppressor, true);
      PATCH._blurSuppressor = null;
    }
  }

  // ─── Exam Spoofer ──────────────────────────────────────────────────────────
  const SPOOF = window.__rbSpoof || (window.__rbSpoof = {
    enabled: false,
    targetEventTypeCd: 1,
    dispatchRewriteCount: 0,
    dispatchRewrites: [],
    fetchRewriteCount: 0,
    fetchRewrites: [],
  });

  function installSpoofer() {
    if (SPOOF.fetchInstalled) return;
    SPOOF.fetchInstalled = true;
    const realFetch = window.fetch.bind(window);
    window.fetch = async function(input, init) {
      const res = await realFetch(input, init);
      if (!SPOOF.enabled) return res;
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      try {
        const ct = res.headers.get('content-type') || '';
        if (!/json/i.test(ct)) return res;
        const cloned = res.clone();
        const txt = await cloned.text();
        if (!/asmtEventTypeCd/.test(txt)) return res;
        const re = /"asmtEventTypeCd"\s*:\s*(\d+)/g;
        let changes = 0;
        const after = txt.replace(re, (m, n) => {
          if (Number(n) === SPOOF.targetEventTypeCd) return m;
          changes++;
          return `"asmtEventTypeCd":${SPOOF.targetEventTypeCd}`;
        });
        if (changes === 0) return res;
        SPOOF.fetchRewriteCount += changes;
        if (SPOOF.fetchRewrites.length < 20) SPOOF.fetchRewrites.push({
          url: url.slice(0, 200), changes, time: new Date().toISOString().slice(11, 23),
        });
        recPush('fetch', '@@RB/spoof-fetch-rewrite', { url: url.slice(0, 200), changes, target: SPOOF.targetEventTypeCd });
        return new Response(after, { status: res.status, statusText: res.statusText, headers: res.headers });
      } catch (e) {
        return res;
      }
    };
  }

  function dispatchAction(type, payload) {
    const store = window.__rbStore || findReduxStore();
    if (!store) return { error: 'no store attached. start the recorder first: /exam start' };
    const action = { type };
    if (payload !== undefined) action.payload = payload;
    try { store.dispatch(action); return { ok: true, action }; }
    catch (e) { return { error: String(e && e.message || e) }; }
  }

  // ─── Toast notification system ─────────────────────────────────────────────
  const TOAST_HOST_ID = 'redbook-toasts-host';
  function ensureToastHost() {
    let h = document.getElementById(TOAST_HOST_ID);
    if (h && h.shadowRoot) return h;
    h = document.createElement('div');
    h.id = TOAST_HOST_ID;
    h.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483645;pointer-events:none;';
    document.documentElement.appendChild(h);
    const sh = h.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: 'JetBrains Mono','Cascadia Code',Consolas,ui-monospace,monospace; }
        .stack {
          position: fixed; bottom: 16px; left: 16px;
          display: flex; flex-direction: column-reverse; gap: 8px;
          pointer-events: none;
          max-width: 380px;
        }
        .toast {
          width: 360px;
          background: #08090b;
          border: 1px solid #1a1d23;
          border-left: 4px solid #ef4444;
          color: #e4e6ea;
          pointer-events: auto;
          transform: translateX(-110%);
          opacity: 0;
          transition: transform .18s linear, opacity .18s linear;
          cursor: pointer;
        }
        .toast.show { transform: translateX(0); opacity: 1; }
        .toast.warn { border-left-color: #fde047; }
        .toast.err  { border-left-color: #fb7185; }
        .toast.ok   { border-left-color: #86efac; }
        .toast .body { padding: 8px 10px; display: flex; flex-direction: column; gap: 3px; }
        .toast .head { font-size: 10px; font-weight: 700; color: #ef4444; text-transform: lowercase; }
        .toast.warn .head { color: #fde047; }
        .toast.err  .head { color: #fb7185; }
        .toast.ok   .head { color: #86efac; }
        .toast .name { font-size: 11px; color: #ef4444; word-break: break-all; }
        .toast .payload {
          font-size: 10px; color: #c4c7cc;
          word-break: break-all; white-space: pre-wrap;
          max-height: 60px; overflow: hidden;
          border-top: 1px dotted #1a1d23;
          padding-top: 4px; margin-top: 2px;
        }
        .toast .foot { font-size: 9px; color: #71757d; display: flex; justify-content: space-between; margin-top: 4px; }
        .toast:hover { border-color: #ef4444; }
      </style>
      <div class="stack"></div>
    `;
    return h;
  }
  function _toastEsc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  window.__rbToast = function(severity, label, eventName, payload) {
    try {
      const h = ensureToastHost();
      const stack = h.shadowRoot.querySelector('.stack');
      while (stack.children.length >= 5) stack.removeChild(stack.firstChild);
      const t = document.createElement('div');
      t.className = 'toast ' + (['ok','warn','err'].includes(severity) ? severity : 'warn');
      const ts = new Date().toTimeString().slice(0, 8);
      let preview = '';
      try { preview = typeof payload === 'string' ? payload : JSON.stringify(payload); }
      catch (_) { preview = String(payload); }
      if (preview === undefined || preview === 'undefined' || preview === 'null') preview = '';
      if (preview.length > 220) preview = preview.slice(0, 220) + '...';
      t.innerHTML = `
        <div class="body">
          <div class="head">[!] ${_toastEsc(label || 'detection')}</div>
          <div class="name">${_toastEsc(eventName || '')}</div>
          ${preview ? `<div class="payload">${_toastEsc(preview)}</div>` : ''}
          <div class="foot"><span>${ts}</span><span>click to dismiss</span></div>
        </div>
      `;
      stack.appendChild(t);
      requestAnimationFrame(() => t.classList.add('show'));
      const dismiss = () => {
        t.classList.remove('show');
        setTimeout(() => { try { stack.removeChild(t); } catch (_) {} }, 250);
      };
      t.addEventListener('click', dismiss);
      setTimeout(dismiss, 8000);
    } catch (e) {
      // swallow
    }
  };

  // ─── Security event watcher ────────────────────────────────────────────────
  const SECURITY_CHANNELS = {
    onGrammarlyDetected:               { sev: 'warn', label: 'grammarly detected' },
    onRestrictedAppsReceived:          { sev: 'warn', label: 'restricted apps', skipIfEmpty: true },
    onSecurityViolationDetected:       { sev: 'err',  label: 'security violation' },
    onDebuggerDetected:                { sev: 'err',  label: 'debugger detected' },
    onVirtualMachineDetected:          { sev: 'err',  label: 'vm detected' },
    onVirtualMachineSuspected:         { sev: 'warn', label: 'vm suspected' },
    onRemoteDesktopConnectionDetected: { sev: 'err',  label: 'rdp connection' },
    onLockdownNewProcess:              { sev: 'warn', label: 'new process' },
    onLockdownWindowResized:           { sev: 'warn', label: 'window resized' },
    onWindowFocusChanged:              { sev: 'warn', label: 'focus changed' },
    onHModStatus:                      { sev: 'warn', label: 'hmod status' },
    onLowBattery:                      { sev: 'ok',   label: 'low battery' },
  };
  const SECURITY_INSTALLED = new Set();
  function installSecurityWatch() {
    const br = detectBridge();
    if (!br) return false;
    let installedNew = 0;
    for (const [chan, cfg] of Object.entries(SECURITY_CHANNELS)) {
      if (SECURITY_INSTALLED.has(chan)) continue;
      const fn = br.obj[chan];
      if (typeof fn !== 'function') continue;
      try {
        fn.call(br.obj, function(...args) {
          // PATCH: suppress our own toast + schedule aggressive DOM cleanup
          if (PATCH.enabled) {
            PATCH.blockedDispatches++;
            patchLog('bridge', chan);
            // Schedule DOM scrub at multiple delays to catch React async renders
            [50, 150, 400, 800, 1500].forEach(function(ms) {
              setTimeout(patchScrubSecurityUI, ms);
            });
            return;
          }
          const payload = args.length === 1 ? args[0] : args;
          if (cfg.skipIfEmpty) {
            const list = Array.isArray(payload) ? payload
              : (payload && (payload.apps || payload.restrictedApps || payload.list));
            if (Array.isArray(list) && list.length === 0) return;
          }
          window.__rbToast(cfg.sev, cfg.label, chan, payload);
        });
        SECURITY_INSTALLED.add(chan);
        installedNew++;
      } catch (e) {
        // ignore
      }
    }
    return SECURITY_INSTALLED.size === Object.keys(SECURITY_CHANNELS).length;
  }
  if (!window.__rbSecurityWatchInstalled) {
    window.__rbSecurityWatchInstalled = true;
    const tryNow = () => installSecurityWatch();
    if (!tryNow()) {
      const started = Date.now();
      const iv = setInterval(() => {
        if (tryNow() || Date.now() - started > 30000) clearInterval(iv);
      }, 500);
    }
  }

  console.log('[redbook] console mounted (idle; press Insert to open)');
}
