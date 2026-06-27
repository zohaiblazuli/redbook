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
    // Fast path: known candidate names from common Electron preload patterns
    for (const key of ['electronAPI', 'api', 'bridge', 'nativeBridge', 'electron', 'app', 'dap', 'bluebook', 'bb']) {
      try {
        const v = window[key];
        if (v && typeof v === 'object' && fingerprint.every(fp => fp in v)) return { key, obj: v };
      } catch (_) {}
    }
    // Full scan
    for (const key of Object.getOwnPropertyNames(window)) {
      try {
        const v = window[key];
        if (!v || typeof v !== 'object') continue;
        if (fingerprint.every(fp => fp in v)) return { key, obj: v };
      } catch (_) {}
    }
    return null;
  }

  // Returns up to N candidate window properties that look like API objects
  // (used by the startup check to give debug context when bridge isn't found)
  function listWindowCandidates(max) {
    const out = [];
    for (const key of Object.getOwnPropertyNames(window)) {
      if (out.length >= (max || 12)) break;
      try {
        const v = window[key];
        if (!v || typeof v !== 'object') continue;
        // Skip DOM globals and obvious junk
        if (v === document || v === window || v === window.location) continue;
        if (v instanceof Element || v instanceof Node) continue;
        const proto = Object.getPrototypeOf(v);
        if (proto && proto.constructor && /^HTML/.test(proto.constructor.name)) continue;
        // Count function-valued properties
        let fnCount = 0;
        for (const k of Object.keys(v)) { try { if (typeof v[k] === 'function') fnCount++; } catch (_) {} }
        if (fnCount >= 1) out.push({ key, fnCount });
      } catch (_) {}
    }
    return out;
  }

  async function tryDetectBridgeWithRetry(maxMs) {
    const start = Date.now();
    while (Date.now() - start < (maxMs || 5000)) {
      const b = detectBridge();
      if (b) return b;
      await new Promise(r => setTimeout(r, 400));
    }
    return null;
  }

  // ─── Persistent status bar ───────────────────────────────────────────────
  const _sbState = {
    ipc:      { text: '...', cls: 'sb-pending' },
    bridge:   { text: '...', cls: 'sb-pending' },
    kiosk:    { text: '...', cls: 'sb-pending' },
    exam:     { text: 'off', cls: 'sb-ok' },
    bluebook: { text: '...', cls: 'sb-pending' },
    update:   { text: '...', cls: 'sb-pending' },
  };

  function _renderStatusBar() {
    try {
      const bar = shadow.querySelector('.status-bar');
      if (!bar) return;
      const pills = bar.querySelectorAll('.sb-pill');
      pills.forEach(pill => {
        const key = pill.getAttribute('data-key');
        if (!key || !_sbState[key]) return;
        const val = pill.querySelector('.sb-val');
        if (!val) return;
        val.textContent = _sbState[key].text;
        val.className = 'sb-val ' + (_sbState[key].cls || 'sb-pending');
      });
    } catch (_) {}
  }

  function _setSb(key, text, cls) {
    if (_sbState[key]) {
      _sbState[key].text = text;
      _sbState[key].cls = cls || 'sb-pending';
      _renderStatusBar();
    }
  }

  // ─── Startup procedure check ─────────────────────────────────────────────
  // Runs once on first devpanel open. Locks input, prints sequential checklist,
  // unlocks when all pass (or 30s total timeout).
  let _startupCheckDone = false;
  let _startupCheckRunning = false;

  function _lockInput(reason) {
    try {
      input.disabled = true;
      input.placeholder = reason || 'startup check running...';
      input.classList.add('locked');
    } catch (_) {}
  }

  function _unlockInput() {
    try {
      input.disabled = false;
      input.placeholder = '';
      input.classList.remove('locked');
      setTimeout(() => input.focus(), 50);
    } catch (_) {}
  }

  function _fmtBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024)    return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  async function runStartupCheck() {
    if (_startupCheckDone || _startupCheckRunning) return;
    _startupCheckRunning = true;
    _lockInput('startup check running...');

    // Wipe whatever boot showBanner() printed -- we'll re-print at the end
    // so the welcome banner / identity prompt / START button sit RIGHT above the input.
    try { scrollback.innerHTML = ''; } catch (_) {}

    con.raw('<span class="dim">════════════════════════════════════════════</span>');
    con.println('Redbook startup check', 'txt');
    con.raw('<span class="dim">────────────────────────────────────────────</span>');

    const globalDeadline = Date.now() + 30000;

    // ── Check 1: IPC channel ──
    con.raw('<span class="tag-info">[..]</span> IPC channel        <span class="dim">pinging _run.js...</span>');
    const t0 = Date.now();
    let healthResult = null;
    try {
      const pingPromise = rbIpc('health', {}, { timeout: 5000 });
      healthResult = await pingPromise;
    } catch (e) {
      healthResult = { error: e.message };
    }
    const ipcMs = Date.now() - t0;
    if (healthResult && !healthResult.error && healthResult.ok) {
      con.printOk(`IPC channel        responsive (${ipcMs}ms)`);
      _setSb('ipc', `OK ${ipcMs}ms`, 'sb-ok');
    } else {
      con.printErr(`IPC channel        ${healthResult && healthResult.error || 'no response'} (waited ${ipcMs}ms)`);
      _setSb('ipc', 'FAIL', 'sb-err');
    }

    // ── Check 2: Electron runtime ──
    if (healthResult && healthResult.electron) {
      con.printOk(`Electron           v${healthResult.electron} (node ${healthResult.node || '?'}, chrome ${healthResult.chrome || '?'})`);
    } else {
      con.printWarn('Electron           version unknown (no health data)');
    }

    // ── Check 3: app.asar ──
    if (healthResult && healthResult.asarExists) {
      const preload = healthResult.preloadExists ? 'preload found' : 'preload MISSING';
      const preloadCls = healthResult.preloadExists ? 'OK' : 'WARN';
      if (preloadCls === 'OK') {
        con.printOk(`app.asar           ${_fmtBytes(healthResult.asarSize)}, ${preload}`);
      } else {
        con.printWarn(`app.asar           ${_fmtBytes(healthResult.asarSize)}, ${preload}`);
      }
    } else if (healthResult && healthResult.error) {
      con.printErr('app.asar           cannot verify (IPC unavailable)');
    } else {
      con.printErr('app.asar           NOT FOUND');
    }

    // ── Check 4: Bridge detection with retry ──
    con.raw('<span class="tag-info">[..]</span> Bridge             <span class="dim">detecting... (up to 5s)</span>');
    const remaining = Math.max(1000, Math.min(5000, globalDeadline - Date.now()));
    const br = await tryDetectBridgeWithRetry(remaining);
    if (br) {
      let bbVersion = '(no version)';
      try { bbVersion = br.obj.version || bbVersion; } catch (_) {}
      con.printOk(`Bridge             window.${br.key} -- Bluebook ${bbVersion}`);
      _setSb('bridge', 'OK', 'sb-ok');
      _setSb('bluebook', String(bbVersion), 'sb-ok');
    } else {
      con.printErr('Bridge             not detected (5s timeout)');
      const cands = listWindowCandidates(10);
      if (cands.length) {
        const list = cands.map(c => `${c.key}(${c.fnCount})`).join(', ');
        con.printDim(`     window objects w/ methods: ${list}`);
      }
      con.printDim('     /kiosk uses native Electron and works without bridge.');
      con.printDim('     /security.* commands require bridge and will show errors.');
      _setSb('bridge', 'FAIL', 'sb-err');
      _setSb('bluebook', '?', 'sb-err');
    }

    // ── Kiosk state probe (quick, no retry) ──
    try {
      const ks = await rbIpc('kiosk.state', {}, { timeout: 2000 });
      if (ks && !ks.error) {
        _setSb('kiosk', ks.kiosk ? 'on' : 'off', ks.kiosk ? 'sb-warn' : 'sb-ok');
      } else {
        _setSb('kiosk', '?', 'sb-err');
      }
    } catch (_) { _setSb('kiosk', '?', 'sb-err'); }

    // ── Check 5: Update check ──
    con.raw('<span class="tag-info">[..]</span> Update             <span class="dim">checking GitHub...</span>');
    try {
      const upd = await rbIpc('update.check', {}, { timeout: 10000 });
      if (upd && upd.error) {
        con.printWarn(`Update             check failed: ${upd.error}`);
        _setSb('update', 'unknown', 'sb-warn');
      } else if (upd && upd.updateAvailable) {
        con.printInfo(`Update             v${upd.latest} available (you have v${upd.local})`);
        con.printDim('     run /update for release info, /update open to open the page');
        _setSb('update', `v${upd.latest} avail`, 'sb-info');
      } else if (upd && upd.ok) {
        con.printOk(`Update             latest (v${upd.local})`);
        _setSb('update', `v${upd.local}`, 'sb-ok');
      } else {
        con.printWarn('Update             no response');
        _setSb('update', '?', 'sb-warn');
      }
    } catch (e) {
      con.printWarn(`Update             error: ${e.message}`);
      _setSb('update', 'error', 'sb-warn');
    }

    con.raw('<span class="dim">════════════════════════════════════════════</span>');
    con.blank();

    _startupCheckDone = true;
    _startupCheckRunning = false;
    _unlockInput();

    // Show the welcome banner + identity prompt / provider select / START button
    // RIGHT HERE so they're always directly above the input row, never buried.
    try { showBanner(); } catch (e) { try { con.printErr('banner failed: ' + e.message); } catch (_) {} }
    scrollToBottom();
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
        /* v0.11.0 — Windows 11 glass palette. Token names kept the same so
           every existing rule that references --cn-* picks up the new look
           automatically. */
        --cn-bg:         rgba(20, 24, 32, 0.86);    /* dark tinted glass — Mica base */
        --cn-surface:    rgba(255, 255, 255, 0.05); /* raised tint */
        --cn-border:     rgba(255, 255, 255, 0.08); /* hairline */
        --cn-border-hi:  rgba(76, 194, 255, 0.28);  /* accent-tinted hover border */
        --cn-text:       #F3F3F3;                    /* Win11 dark-mode text */
        --cn-dim:        #A1A1A1;                    /* Win11 dark-mode secondary */
        --cn-faint:      #6E6E6E;                    /* tertiary */
        --cn-accent:     #4CC2FF;                    /* Win11 dark accent */
        --cn-accent-dim: rgba(76, 194, 255, 0.20);
        --cn-success:    #6CCB5F;                    /* Win11 system green */
        --cn-warn:       #FFC83D;                    /* Win11 amber */
        --cn-error:      #FF99A4;                    /* Win11 soft rose */
        --cn-info:       #4CC2FF;
        --cn-str:        #FFC83D;
        --cn-num:        #FFB454;
        --cn-key:        #9CDCFE;                    /* Win Terminal key blue */
        /* Typography */
        --cn-font-chrome:  'Segoe UI Variable', 'Segoe UI', system-ui, -apple-system, sans-serif;
        --cn-font-content: 'Cascadia Code', 'Cascadia Mono', 'Consolas', ui-monospace, monospace;
      }
      * {
        box-sizing: border-box;
        font-family: var(--cn-font-content);  /* default to content/monospace; chrome elements override per-class below */
      }
      .win {
        position: fixed;
        background: var(--cn-bg);
        color: var(--cn-text);
        border: 1px solid var(--cn-border);
        border-radius: 6px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.65);
        display: none;
        flex-direction: column;
        pointer-events: auto;
        user-select: text;
        overflow: hidden;
      }
      .win.open { display: flex; }
      .titlebar {
        display: flex; align-items: center; gap: 10px;
        padding: 6px 10px;
        background: var(--cn-surface);
        border-bottom: 1px solid var(--cn-border);
        border-left: 2px solid var(--cn-accent);
        font-size: 11px;
        cursor: move;
        flex-shrink: 0;
        user-select: none;
      }
      .tb-brand { color: var(--cn-accent); font-weight: 700; letter-spacing: 0.5px; }
      .tb-brand::before { content: '卐'; margin-right: 8px; }
      .tb-meta { color: var(--cn-dim); flex: 1; font-size: 10px; }
      .tb-status { display: flex; gap: 6px; align-items: center; }
      .tb-stat {
        font-family: inherit;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.5px;
        padding: 1px 5px;
        border: 1px solid var(--cn-border);
        color: var(--cn-dim);
        background: transparent;
        transition: color 0.2s, border-color 0.2s, background 0.2s;
      }
      .tb-stat.on  { color: var(--cn-success); border-color: var(--cn-success); background: rgba(74, 222, 128, 0.08); }
      .tb-stat.err { color: var(--cn-error);   border-color: var(--cn-error);   background: rgba(248, 113, 113, 0.08); }
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

      .status-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
        padding: 4px 12px;
        border-top: 1px solid var(--cn-border);
        background: var(--cn-surface);
        font-family: inherit;
        font-size: 11px;
        color: var(--cn-dim);
        flex-shrink: 0;
        user-select: none;
      }
      .sb-pill { white-space: nowrap; }
      .sb-val { font-weight: 600; padding-left: 4px; }
      .sb-ok      { color: var(--cn-success); }
      .sb-err     { color: var(--cn-error); }
      .sb-warn    { color: var(--cn-warn); }
      .sb-pending { color: var(--cn-dim); }
      .sb-info    { color: var(--cn-info); }

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

      /* ── Provider cards ── */
      .provider-row {
        display: flex; gap: 10px; justify-content: center;
        padding: 8px 0; margin: 4px 0;
      }
      .provider-card {
        display: flex; flex-direction: column; align-items: center;
        gap: 4px; padding: 12px 16px;
        border: 1px solid var(--cn-border);
        border-radius: 6px; cursor: pointer;
        color: var(--cn-dim); font-size: 11px;
        transition: border-color 0.2s, color 0.2s, background 0.2s;
        min-width: 100px; text-align: center;
        user-select: none;
      }
      .provider-card:hover {
        border-color: var(--cn-border-hi);
        color: var(--cn-text);
        background: var(--cn-surface);
      }
      .provider-card.selected {
        border-color: var(--cn-accent);
        color: var(--cn-accent);
        background: rgba(108, 126, 225, 0.08);
      }
      .provider-icon { width: 24px; height: 24px; object-fit: contain; filter: grayscale(1) brightness(1.5); transition: filter 0.2s; }
      .provider-card.selected .provider-icon { filter: none; }
      .provider-card:hover .provider-icon { filter: grayscale(0.3) brightness(1.2); }
      .provider-name { font-weight: 600; font-size: 12px; }

      /* ── Start button ── */
      .start-row { display: flex; justify-content: center; padding: 10px 0; }
      .start-btn {
        padding: 8px 32px; font-size: 13px; font-weight: 700;
        font-family: inherit; cursor: pointer;
        border: 1px solid var(--cn-accent); border-radius: 6px;
        background: transparent; color: var(--cn-accent);
        letter-spacing: 1px;
        transition: background 0.15s, transform 0.1s;
        user-select: none;
      }
      .start-btn:hover {
        animation: effortGlow 2s ease-in-out infinite;
        background: rgba(108, 126, 225, 0.1);
        transform: scale(1.02);
      }
      .start-btn:active { transform: scale(0.98); }
      @keyframes effortGlow {
        0%   { border-color: #6c7ee1; color: #6c7ee1; text-shadow: 0 0 8px rgba(108,126,225,0.3); }
        20%  { border-color: #818cf8; color: #818cf8; text-shadow: 0 0 8px rgba(129,140,248,0.3); }
        40%  { border-color: #a78bfa; color: #a78bfa; text-shadow: 0 0 8px rgba(167,139,250,0.3); }
        60%  { border-color: #c084fc; color: #c084fc; text-shadow: 0 0 8px rgba(192,132,252,0.3); }
        80%  { border-color: #f472b6; color: #f472b6; text-shadow: 0 0 8px rgba(244,114,182,0.3); }
        100% { border-color: #6c7ee1; color: #6c7ee1; text-shadow: 0 0 8px rgba(108,126,225,0.3); }
      }

      /* ── Progress bar ── */
      .progress-bar {
        display: inline-block; font-size: 11px;
      }
      .progress-fill { color: var(--cn-accent); }
      .progress-empty { color: var(--cn-faint); }
      .progress-label { color: var(--cn-info); font-weight: 600; }
      .progress-pct { color: var(--cn-text); }

      /* ═══════════════════════════════════════════════════════════════════════
         v0.11.0 — Windows 11 glass facelift (CSS-only).

         These rules are appended *after* the original ruleset so cascade
         order alone wins them. Every selector here targets a class that
         existed in v0.10.3 — no new HTML, no JS changes anywhere. To
         revert: delete this entire block.
         ═══════════════════════════════════════════════════════════════════════ */

      /* Window shell — Mica base glass */
      .win {
        background: var(--cn-bg);
        -webkit-backdrop-filter: blur(18px) saturate(140%);
        backdrop-filter: blur(18px) saturate(140%);
        border: 1px solid var(--cn-border);
        border-radius: 8px;
        box-shadow:
          0 12px 28px rgba(0,0,0,0.5),
          0 2px 4px rgba(0,0,0,0.4);
        color: var(--cn-text);
      }

      /* Titlebar — drop the swastika + accent-left stripe, Segoe UI chrome */
      .titlebar {
        background: transparent;
        border-bottom: 1px solid var(--cn-border);
        border-left: none;
        padding: 8px 12px;
        font-family: var(--cn-font-chrome);
        font-size: 12px;
      }
      .tb-brand {
        color: var(--cn-text);
        font-family: var(--cn-font-chrome);
        font-weight: 600;
        letter-spacing: 0;
      }
      .tb-brand::before { content: none; }  /* remove 卐 */
      .tb-meta {
        color: var(--cn-dim);
        font-family: var(--cn-font-chrome);
        font-size: 11px;
        font-weight: 400;
        padding: 1px 8px;
        background: rgba(255,255,255,0.04);
        border: 1px solid var(--cn-border);
        border-radius: 6px;
        flex: 0 0 auto;
        margin-right: 8px;
      }

      /* Status pills — chip aesthetic */
      .tb-status { gap: 6px; }
      .tb-stat {
        font-family: var(--cn-font-chrome);
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.04em;
        padding: 2px 10px;
        border-radius: 10px;
        border: 1px solid var(--cn-border);
        background: transparent;
        color: var(--cn-dim);
      }
      .tb-stat.on {
        color: var(--cn-accent);
        border-color: rgba(76,194,255,0.28);
        background: rgba(76,194,255,0.10);
      }
      .tb-stat.err {
        color: var(--cn-error);
        border-color: rgba(255,153,164,0.30);
        background: rgba(255,153,164,0.10);
      }

      /* Close button — Win11 hover behavior */
      .tb-btn {
        background: transparent;
        border: 1px solid transparent;
        color: var(--cn-dim);
        width: 24px;
        height: 22px;
        border-radius: 4px;
        font-family: var(--cn-font-chrome);
      }
      .tb-btn:hover {
        background: rgba(255,255,255,0.06);
        border-color: var(--cn-border);
        color: var(--cn-text);
      }

      /* Scrollback */
      .scrollback {
        padding: 12px 16px;
        font-family: var(--cn-font-content);
        font-size: 12px;
        scrollbar-color: rgba(255,255,255,0.10) transparent;
      }
      .scrollback::-webkit-scrollbar { width: 4px; }
      .scrollback::-webkit-scrollbar-track { background: transparent; }
      .scrollback::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.10); border-radius: 2px; }
      .scrollback::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.18); }

      /* ASCII banner — monochromatic accent (overrides inline rainbow spans) */
      .banner {
        font-family: var(--cn-font-content);
        color: var(--cn-accent);
      }
      .banner span[style*="color"] {
        color: var(--cn-accent) !important;
        text-shadow: 0 0 12px rgba(76,194,255,0.18);
      }

      /* Log tag colors — bracketed format preserved for column alignment */
      .tag-ok   { color: var(--cn-success); }
      .tag-warn { color: var(--cn-warn); }
      .tag-err  { color: var(--cn-error); }
      .tag-info { color: var(--cn-info); }

      /* Echo prompt */
      .echo { color: var(--cn-dim); }

      /* KV pairs */
      .kv-dots { color: var(--cn-faint); }

      /* Provider cards — Acrylic moment */
      .provider-row {
        gap: 12px;
        padding: 10px 0;
      }
      .provider-card {
        background: rgba(255,255,255,0.04);
        -webkit-backdrop-filter: blur(20px) saturate(140%);
        backdrop-filter: blur(20px) saturate(140%);
        border: 1px solid var(--cn-border);
        border-radius: 10px;
        padding: 14px 18px;
        font-family: var(--cn-font-chrome);
        color: var(--cn-dim);
        transition: border-color 180ms, background 180ms, transform 180ms;
      }
      .provider-card:hover {
        border-color: var(--cn-border-hi);
        background: rgba(255,255,255,0.06);
        transform: translateY(-1px);
        color: var(--cn-text);
      }
      .provider-card.selected {
        border-color: var(--cn-accent);
        background: rgba(76,194,255,0.10);
        color: var(--cn-text);
      }
      .provider-card .provider-icon {
        filter: grayscale(1) brightness(1.5) opacity(0.85);
        transition: filter 180ms;
      }
      .provider-card.selected .provider-icon { filter: none; }
      .provider-card .provider-name {
        font-family: var(--cn-font-chrome);
        font-weight: 500;
        font-size: 12px;
      }

      /* START button — biggest Acrylic moment, no rainbow */
      .start-row { padding: 12px 0; }
      .start-btn {
        background: linear-gradient(180deg, rgba(76,194,255,0.12), rgba(76,194,255,0.04));
        -webkit-backdrop-filter: blur(20px) saturate(140%);
        backdrop-filter: blur(20px) saturate(140%);
        border: 1px solid var(--cn-accent-dim);
        border-radius: 8px;
        color: var(--cn-accent);
        font-family: var(--cn-font-chrome);
        font-weight: 600;
        font-size: 13px;
        letter-spacing: 0.04em;
        padding: 10px 32px;
        transition: border-color 180ms, background 180ms, transform 100ms;
      }
      .start-btn:hover {
        animation: none;  /* kill effortGlow */
        border-color: var(--cn-accent);
        background: linear-gradient(180deg, rgba(76,194,255,0.18), rgba(76,194,255,0.06));
        transform: translateY(-1px);
        color: var(--cn-text);
      }
      .start-btn:active { transform: translateY(0); }
      @keyframes effortGlow { /* defused — kept as no-op so any stray reference is harmless */
        from { opacity: 1; } to { opacity: 1; }
      }

      /* Spinner */
      .spin { color: var(--cn-accent); }

      /* Footer status bar — chip pills */
      .status-bar {
        background: transparent;
        border-top: 1px solid var(--cn-border);
        font-family: var(--cn-font-chrome);
        font-size: 11px;
        gap: 8px;
        padding: 6px 12px;
      }
      .sb-pill {
        padding: 2px 10px;
        border-radius: 10px;
        border: 1px solid var(--cn-border);
        background: rgba(255,255,255,0.03);
        color: var(--cn-dim);
        font-size: 11px;
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
      }
      .sb-val {
        font-weight: 600;
        font-family: var(--cn-font-chrome);
      }
      .sb-ok      { color: var(--cn-success); }
      .sb-err     { color: var(--cn-error); }
      .sb-warn    { color: var(--cn-warn); }
      .sb-info    { color: var(--cn-accent); }
      .sb-pending { color: var(--cn-faint); }

      /* Shortcuts row — glass keycaps */
      .shortcuts {
        background: transparent;
        border-top: 1px solid var(--cn-border);
        font-family: var(--cn-font-chrome);
        font-size: 11px;
        color: var(--cn-dim);
        padding: 6px 12px;
        gap: 16px;
      }
      .shortcuts > span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .shortcuts code {
        background: var(--cn-surface);
        border: 1px solid var(--cn-border);
        border-radius: 4px;
        color: var(--cn-text);
        font-family: var(--cn-font-content);
        font-size: 10px;
        padding: 1px 6px;
        margin-right: 0;
        box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset;
      }

      /* Input row */
      .input-row {
        background: transparent;
        border-top: 1px solid var(--cn-border);
        padding: 10px 14px;
      }
      .input-prompt {
        color: var(--cn-accent);
        font-family: var(--cn-font-content);
        font-size: 14px;
        font-weight: 600;
      }
      .input-display {
        font-family: var(--cn-font-content);
        color: var(--cn-text);
      }
      .input-ghost { color: var(--cn-faint); }
      .input-text {
        font-family: var(--cn-font-content);
        caret-color: var(--cn-accent);
        color: transparent;
      }

      /* Autocomplete dropdown — second Acrylic moment */
      .ac-dropdown {
        background: rgba(20,24,32,0.78);
        -webkit-backdrop-filter: blur(24px) saturate(160%);
        backdrop-filter: blur(24px) saturate(160%);
        border: 1px solid var(--cn-border);
        border-bottom: none;
        border-radius: 8px 8px 0 0;
        box-shadow: 0 -8px 24px rgba(0,0,0,0.45);
        font-family: var(--cn-font-chrome);
        font-size: 12px;
        scrollbar-color: rgba(255,255,255,0.10) transparent;
      }
      .ac-item {
        padding: 5px 14px;
        color: var(--cn-text);
        font-family: var(--cn-font-chrome);
      }
      .ac-item .ac-cmd {
        color: var(--cn-accent);
        font-family: var(--cn-font-content);
      }
      .ac-item .ac-cmd .ac-match {
        color: var(--cn-text);
        font-weight: 600;
      }
      .ac-item .ac-help {
        color: var(--cn-dim);
        font-family: var(--cn-font-chrome);
      }
      .ac-item.active {
        background: rgba(76,194,255,0.12);
      }
      .ac-item:hover:not(.active) {
        background: rgba(255,255,255,0.04);
      }
      .ac-item.arg-hint .ac-arg { color: var(--cn-accent); }
      .ac-group-header {
        color: var(--cn-faint);
        font-family: var(--cn-font-chrome);
        border-top-color: var(--cn-border);
      }

      /* Resize grip — subtler */
      .resize-grip {
        opacity: 0.5;
      }

      /* Progress bar — keep existing structure, new accent colors via tokens */
      .progress-bar { font-family: var(--cn-font-content); }
      .progress-fill { color: var(--cn-accent); }
      .progress-empty { color: var(--cn-faint); }
      .progress-label { color: var(--cn-accent); font-weight: 600; }
      .progress-pct { color: var(--cn-text); }

      /* JSON syntax highlighting — pulled toward Win Terminal palette */
      .json .jk { color: var(--cn-key); }
      .json .js { color: var(--cn-str); }
      .json .jn { color: var(--cn-num); }
      .json .jb { color: var(--cn-accent); }

      /* Focus rings — keyboard-nav visible */
      .start-btn:focus-visible,
      .provider-card:focus-visible,
      .input-text:focus-visible,
      .tb-btn:focus-visible,
      .ac-item:focus-visible {
        outline: 2px solid var(--cn-accent);
        outline-offset: 2px;
      }

      /* Reduced motion — respect OS preference */
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          transition-duration: 0.01ms !important;
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
        }
      }
    </style>

    <div class="win" role="dialog" aria-label="Redbook Console">
      <div class="titlebar">
        <span class="tb-brand">redbook</span>
        <span class="tb-meta">v0.10.3 · console</span>
        <span class="tb-status">
          <span class="tb-stat status-store" title="store">STORE</span>
          <span class="tb-stat status-bridge" title="bridge">BRIDGE</span>
          <span class="tb-stat status-rec" title="recorder">REC</span>
        </span>
        <button class="tb-btn tb-close" title="Hide (Esc)">×</button>
      </div>
      <div class="scrollback"></div>
      <div class="status-bar">
        <span class="sb-pill" data-key="ipc">IPC:<b class="sb-val sb-pending">...</b></span>
        <span class="sb-pill" data-key="bridge">Bridge:<b class="sb-val sb-pending">...</b></span>
        <span class="sb-pill" data-key="kiosk">Kiosk:<b class="sb-val sb-pending">...</b></span>
        <span class="sb-pill" data-key="exam">Exam:<b class="sb-val sb-ok">off</b></span>
        <span class="sb-pill" data-key="bluebook">Bluebook:<b class="sb-val sb-pending">...</b></span>
        <span class="sb-pill" data-key="update">Update:<b class="sb-val sb-pending">...</b></span>
      </div>
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
  let inputMode = 'command'; // 'command' | 'identity' | 'startup'
  let history = [];
  let historyIdx = -1;
  let denseMode = false;
  let rbVersion = (typeof __RB_VERSION !== 'undefined') ? __RB_VERSION : { version: '0.0.0', electron: '?' };
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
    progress(label, pct) {
      pct = Math.max(0, Math.min(100, Math.round(pct)));
      const filled = Math.round(pct / 5);
      const empty = 20 - filled;
      return this.raw(
        `<span class="progress-bar"><span class="progress-label">[${_esc(label)}]</span> ` +
        `<span class="progress-fill">${'█'.repeat(filled)}</span>` +
        `<span class="progress-empty">${'░'.repeat(empty)}</span> ` +
        `<span class="progress-pct">${pct}%</span></span>`
      );
    },
    blank() { return this.raw('&nbsp;'); },
    clear() { scrollback.innerHTML = ''; showBanner(); },
  };

  // ─── Banner + identity + startup flow ──────────────────────────────────────
  let selectedProvider = 'claude';
  let startupPhase = false;
  const PROVIDER_LOGOS = {
    claude: 'data:image/webp;base64,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',
    gemini: 'data:image/png;base64,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',
    chatgpt: 'data:image/png;base64,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',
  };

  const bannerLines = [
    '  ██    ██████',
    '  ██    ██',
    '  ██    ██       ____          _  _                 _',
    '  ██    ██      |  _ \\  ___  _| || |__    ___   ___ | | __',
    '  ██████████    | |_) |/ _ \\/ _` || \'_ \\  / _ \\ / _ \\| |/ /',
    '      ██    ██  |  _ <|  __/ (_| || |_) || (_) || (_) |   <',
    '      ██    ██  |_| \\_\\\\___|\\__,_||_.__/  \\___/  \\___/|_|\\_\\',
    '      ██    ██',
    '  ██████    ██',
  ];
  const bannerColors = [
    '#60a5fa','#6c7ee1','#818cf8','#a78bfa','#c084fc',
    '#a78bfa','#818cf8','#6c7ee1','#60a5fa',
  ];

  function showBanner() {
    const verBb = (function() { try { return (detectBridge()?.obj?.version) || '0.9.6'; } catch (_) { return '0.9.6'; } })();
    const coloredLines = bannerLines.map((ln, i) =>
      `<span style="color:${bannerColors[i]}">${_esc(ln)}</span>`
    ).join('\n');
    con.raw(`<pre class="banner">${coloredLines}</pre>`);
    con.raw(`<span class="dim">              v${_esc(rbVersion.version)} console · bluebook ${_esc(verBb)}</span>`);
    con.blank();
    if (identity) {
      showProviderSelect();
    } else {
      con.println('What should I call you?');
      inputMode = 'identity';
      con.blank();
    }
  }

  function showProviderSelect() {
    startupPhase = true;
    inputMode = 'startup';
    con.printDim('Select AI provider:');
    con.blank();
    const row = con.raw(`<div class="provider-row">
      <div class="provider-card${selectedProvider==='claude'?' selected':''}" data-provider="claude">
        <img class="provider-icon" src="${PROVIDER_LOGOS.claude}" alt="">
        <span class="provider-name">Claude</span>
      </div>
      <div class="provider-card${selectedProvider==='gemini'?' selected':''}" data-provider="gemini">
        <img class="provider-icon" src="${PROVIDER_LOGOS.gemini}" alt="">
        <span class="provider-name">Gemini</span>
      </div>
      <div class="provider-card${selectedProvider==='chatgpt'?' selected':''}" data-provider="chatgpt">
        <img class="provider-icon" src="${PROVIDER_LOGOS.chatgpt}" alt="">
        <span class="provider-name">ChatGPT</span>
      </div>
    </div>`);
    row.addEventListener('click', (e) => {
      const card = e.target.closest('.provider-card');
      if (!card) return;
      selectedProvider = card.dataset.provider;
      row.querySelectorAll('.provider-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });
    con.blank();
    const startRow = con.raw(`<div class="start-row"><button class="start-btn">▶  START</button></div>`);
    startRow.querySelector('.start-btn').addEventListener('click', () => doStartup());
    con.blank();
    con.printDim('or type /help for commands');
  }

  async function doStartup() {
    if (!startupPhase) return;
    startupPhase = false;
    con.blank();

    // 1. Auto-patch via internal command handler
    const patchCmd = commands['patch'];
    if (patchCmd) {
      try { await patchCmd.handler(['on']); } catch (_) { con.printErr('patch failed'); }
    } else {
      con.printWarn('patch command not registered yet');
    }

    // 2. Open AI hidden
    const providerUrl = AI_PROVIDERS[selectedProvider] || 'https://claude.ai';
    const sp2 = con.spinner('loading ' + selectedProvider + '…');
    try {
      const r2 = await rbIpc('ai.open', { url: providerUrl, hidden: true });
      if (r2 && r2.error) sp2.err(r2.error);
      else sp2.ok(selectedProvider + ' ready — ` to panic hide, Ctrl+Shift+G to toggle');
    } catch (_) { sp2.err('ai IPC failed'); }

    con.blank();
    con.println('Welcome back, ' + identity + '.');
    con.printDim('Type /help to see what I can do.');
    inputMode = 'command';
    con.blank();
  }

  // ─── Visibility + hotkey ───────────────────────────────────────────────────
  function showWin() {
    win.classList.add('open');
    host.style.pointerEvents = 'auto';
    setTimeout(() => input.focus(), 50);
    // Run startup procedure check on first open
    if (!_startupCheckDone && !_startupCheckRunning) {
      runStartupCheck().catch(e => { try { con.printErr('startup check crashed: ' + e.message); } catch (_) {} });
    }
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

  // ─── Panic hide/restore ────────────────────────────────────────────────────
  let _panicWasOpen = false;
  window.addEventListener('rb-panic-hide', () => {
    _panicWasOpen = winEl.classList.contains('open');
    if (_panicWasOpen) hideWin();
    // Dismiss all toasts
    try {
      const th = document.getElementById('redbook-toasts-host');
      if (th && th.shadowRoot) {
        const stack = th.shadowRoot.querySelector('.stack');
        if (stack) stack.innerHTML = '';
      }
    } catch (_) {}
  });
  window.addEventListener('rb-panic-restore', () => {
    if (_panicWasOpen) showWin();
    _panicWasOpen = false;
  });

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
      { arg: 'claude',       help: 'Open Claude' },
      { arg: 'gemini',       help: 'Open Gemini' },
      { arg: 'chatgpt',      help: 'Open ChatGPT' },
      { arg: 'close',        help: 'Close AI window' },
      { arg: 'inspect',      help: 'Dump AI overlay DOM' },
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
    if (inputMode === 'startup') {
      // During startup, only allow /help and /ai commands
      if (trimmed.startsWith('/')) {
        con.printEcho(line);
        const parts = trimmed.slice(1).split(/\s+/);
        const cmd = parts[0].toLowerCase();
        if (cmd === 'help') { dispatch('help', parts.slice(1)); }
        else { con.printDim('press START to begin, or select a provider'); }
      }
      return;
    }
    if (inputMode === 'identity') {
      if (!trimmed) return;
      identity = trimmed;
      try { localStorage.setItem(IDENTITY_KEY, identity); } catch (_) {}
      con.printEcho(line);
      con.println('Pleased to meet you, ' + identity + '.');
      con.blank();
      showProviderSelect();
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
    if (flags.storeStatus === 'attached')      { statusStore.classList.add('on');  statusStore.textContent = 'STORE OK'; }
    else if (flags.storeStatus === 'not-found'){ statusStore.classList.add('err'); statusStore.textContent = 'STORE !'; }
    else                                       {                                   statusStore.textContent = 'STORE'; }
    statusStore.title = 'store: ' + (flags.storeStatus || 'idle');

    statusBridge.classList.remove('on');
    if ((flags.bridgeStatus || '').includes('tapped')) { statusBridge.classList.add('on'); statusBridge.textContent = 'BRIDGE OK'; }
    else                                               {                                  statusBridge.textContent = 'BRIDGE'; }
    statusBridge.title = 'bridge: ' + (flags.bridgeStatus || 'idle');

    statusRec.classList.remove('on');
    if (R.running) { statusRec.classList.add('on'); statusRec.textContent = 'REC ' + ((R.events||[]).length); }
    else           {                                statusRec.textContent = 'REC'; }
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
      ['redbook',         'v' + rbVersion.version, 'ok'],
      ['electron',        'v' + rbVersion.electron],
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

  registerCommand('kiosk', async (args) => {
    const mode = (args[0] || '').toLowerCase();
    if (mode === 'on') {
      let nativeOk = false, bridgeOk = false;
      const r = await rbIpc('kiosk.on');
      if (!r.error) nativeOk = true;
      const br = bridge();
      if (br) { try { br.obj.enterKioskMode?.(); bridgeOk = true; } catch (_) {} }
      if (nativeOk || bridgeOk) {
        const via = [nativeOk && 'native', bridgeOk && 'bridge'].filter(Boolean).join(' + ');
        con.printOk('kiosk on (' + via + ')');
        _setSb('kiosk', 'on', 'sb-warn');
      } else {
        con.printErr('kiosk failed: native IPC ' + (r.error || '?') + ', bridge not detected');
      }
    } else if (mode === 'off') {
      let nativeOk = false, bridgeOk = false;
      const r = await rbIpc('kiosk.off');
      if (!r.error) nativeOk = true;
      const br = bridge();
      if (br) { try { br.obj.exitKioskMode?.(); bridgeOk = true; } catch (_) {} }
      if (nativeOk || bridgeOk) {
        const via = [nativeOk && 'native', bridgeOk && 'bridge'].filter(Boolean).join(' + ');
        con.printOk('kiosk off (' + via + ')');
        _setSb('kiosk', 'off', 'sb-ok');
      } else {
        con.printErr('kiosk off failed: native IPC ' + (r.error || '?') + ', bridge not detected');
      }
    } else {
      const r = await rbIpc('kiosk.state');
      const nativeState = r.error ? '(unknown: ' + r.error + ')' : (r.kiosk ? 'on' : 'off');
      const fsState = r.error ? '?' : (r.fullscreen ? 'yes' : 'no');
      const heuristic = document.fullscreenElement ? 'likely on' : 'likely off';
      con.printKV([
        ['kiosk (native)',    nativeState],
        ['fullscreen (native)', fsState],
        ['kiosk (heuristic)', heuristic],
      ]);
      con.printDim('usage: /kiosk on|off');
      if (!r.error) _setSb('kiosk', r.kiosk ? 'on' : 'off', r.kiosk ? 'sb-warn' : 'sb-ok');
    }
  }, 'Toggle kiosk mode (on/off) -- engages both native Electron + bridge lockdown');

  registerCommand('update', async (args) => {
    const sub = (args[0] || 'check').toLowerCase();
    if (sub === 'open') {
      const r = await rbIpc('update.check', {}, { timeout: 10000 });
      if (r.error) { con.printErr('cannot fetch release: ' + r.error); return; }
      const url = r.releaseUrl || 'https://github.com/zohaiblazuli/redbook/releases';
      const o = await rbIpc('shell.openExternal', { url });
      if (o.error) { con.printErr('open failed: ' + o.error); con.printDim('URL: ' + url); }
      else con.printOk('opened release page in default browser');
      return;
    }
    if (sub === 'install' || sub === 'apply') {
      con.printDim('checking GitHub for latest release...');
      const check = await rbIpc('update.check', {}, { timeout: 10000 });
      if (check.error) { con.printErr('cannot fetch release: ' + check.error); return; }
      if (!check.updateAvailable) { con.printOk('already on latest (v' + check.local + ')'); return; }
      if (!check.assetUrl) { con.printErr('release has no downloadable asset'); return; }

      con.printInfo(`installing v${check.latest} (you have v${check.local})`);
      con.printDim('asset: ' + check.assetUrl);
      con.printDim('Redbook will quit and relaunch automatically when install completes.');
      con.blank();

      // One progress line that we mutate in place
      const lastLine = con.raw('<span class="tag-info">[..]</span> downloading...');
      window.__rbUpdateProgress = function(p) {
        try {
          const mb = (p.bytes ? p.bytes/1048576 : 0).toFixed(1);
          const totalMb = p.total ? (p.total/1048576).toFixed(1) : '?';
          let text = '';
          if (p.phase === 'downloading') {
            text = `<span class="tag-info">[..]</span> downloading... ${p.pct}% (${mb}/${totalMb} MB)`;
          } else if (p.phase === 'downloaded') {
            text = `<span class="tag-ok">[OK]</span>   downloaded ${mb} MB`;
          } else if (p.phase === 'spawning') {
            text = `<span class="tag-info">[..]</span> launching installer (silent)...`;
          }
          if (text && lastLine) lastLine.innerHTML = text;
        } catch (_) {}
      };

      try {
        const r = await rbIpc('update.install', { assetUrl: check.assetUrl }, { timeout: 600000 });
        if (r.error) { con.printErr('install failed: ' + r.error); return; }
        con.printOk('installer running. Redbook will close shortly and relaunch when done.');
      } catch (e) {
        con.printErr('install crashed: ' + e.message);
      } finally {
        delete window.__rbUpdateProgress;
      }
      return;
    }
    con.printDim('checking GitHub releases...');
    const r = await rbIpc('update.check', {}, { timeout: 10000 });
    if (r.error) {
      con.printErr('update check failed: ' + r.error);
      _setSb('update', 'error', 'sb-warn');
      return;
    }
    con.printKV([
      ['installed', 'v' + r.local],
      ['latest',    'v' + r.latest],
      ['status',    r.updateAvailable ? 'UPDATE AVAILABLE' : 'up to date'],
      ['published', r.publishedAt ? r.publishedAt.slice(0,10) : '?'],
    ]);
    if (r.updateAvailable) {
      _setSb('update', `v${r.latest} avail`, 'sb-info');
      con.blank();
      con.printDim('release notes:');
      con.raw('<pre class="box dim">' + _esc(r.body || '(empty)') + '</pre>');
      con.blank();
      con.printDim('Download: ' + (r.assetUrl || r.releaseUrl));
      con.printDim('Run /update open to open the release page in your browser.');
    } else {
      _setSb('update', `v${r.local}`, 'sb-ok');
    }
  }, 'Check for Redbook updates. /update | /update install | /update open');

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

  registerCommand('exam.on', async () => doExamOn(), 'Activate full exam-day mode (kiosk + patch + spoof + bridge lockdown)');
  registerCommand('exam.off', async () => doExamOff(), 'Deactivate exam-day mode and restore normal state');

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
  // Syntax: /ai {name}   or   /ai close   or   /ai
  const AI_PROVIDERS = {
    claude:  'https://claude.ai',
    gemini:  'https://gemini.google.com/app',
    chatgpt: 'https://chatgpt.com',
  };

  registerCommand('ai', async (args) => {
    const a0 = (args[0] || '').toLowerCase();

    // /ai  →  status
    if (!a0) {
      const r = await rbIpc('ai.state');
      con.printKV([
        ['window', r.open ? 'open' : 'closed', r.open ? 'ok' : ''],
        ['visible', r.open ? String(r.visible) : '-'],
        ['url', r.url || '-'],
      ]);
      return;
    }

    // /ai close
    if (a0 === 'close') {
      const sp = con.spinner('closing…');
      const r = await rbIpc('ai.close');
      if (r && r.error) sp.err(r.error);
      else sp.ok('ai closed');
      return;
    }

    // /ai inspect  →  dump visible DOM elements to file
    if (a0 === 'inspect') {
      const sp = con.spinner('inspecting…');
      const r = await rbIpc('ai.inspect');
      if (r && r.error) { sp.err(r.error); return; }
      sp.ok('DOM dump written to: ' + (r.file || 'G:\\redbook\\_inspect.txt'));
      return;
    }

    // /ai {name}  →  open provider (hidden by default)
    if (AI_PROVIDERS[a0]) {
      const url = AI_PROVIDERS[a0];
      const sp = con.spinner('loading ' + a0 + '…');
      const r = await rbIpc('ai.open', { url: url, hidden: true });
      if (r && r.error) { sp.err(r.error); return; }
      sp.ok(a0 + ' ready — ` to panic hide, Ctrl+Shift+G to toggle');
      return;
    }

    // /ai {url}  →  custom URL (contains . or ://)
    if (a0.includes('.') || a0.includes('://')) {
      const url = args.join(' ');
      const sp = con.spinner('opening…');
      const r = await rbIpc('ai.navigate', { url: url });
      if (r && r.error) sp.err(r.error);
      else sp.ok('opened → ' + (r.url || url));
      return;
    }

    con.printErr('usage: /ai {claude|gemini|chatgpt|<url>|close|inspect}');
  }, 'AI overlay — /ai claude, /ai gemini, /ai close');

  // ─── /patch command ────────────────────────────────────────────────────────
  function patchShowBadge() {
    if (PATCH.badgeEl) return;
    const statusBar = shadow.querySelector('.tb-status');
    if (!statusBar) return;
    const badge = document.createElement('span');
    badge.className = 'tb-patch-badge';
    badge.textContent = 'PATCH ✓';
    badge.title = 'Click to disable security patch';
    badge.style.cssText = 'background:rgba(50,77,199,0.15);border:1px solid #1e3a8a;color:#324dc7;'
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
    titleEl.style.cssText = 'color:#324dc7;font-weight:700;font-size:11px;margin-bottom:6px;';
    titleEl.innerHTML = '<span style="margin-right:8px">卐</span>' + title.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
      setMsg(text) { msgEl.innerHTML = '<span style="color:#324dc7">' + SPIN_FRAMES[0] + '</span> ' + _esc(text); spinIdx = 0; if (!spinIv) { spinIv = setInterval(() => { spinIdx = (spinIdx+1)%SPIN_FRAMES.length; const s = msgEl.querySelector('span'); if (s) s.textContent = SPIN_FRAMES[spinIdx]; }, 80); } scrollToBottom(); },
      setBar(pct) {
        const w = 30;
        const filled = Math.round((pct / 100) * w);
        const empty = w - filled;
        barWrap.innerHTML = '<span style="color:#71757d">' + String(Math.round(pct)).padStart(3) + '%</span> '
          + '<span style="color:#324dc7">' + '━'.repeat(filled) + '</span>'
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

  // ─── Exam Mode On/Off ─────────────────────────────────────────────────────

  async function doExamOn() {
    if (EXAM_MODE.active) { con.printWarn('exam mode is already active. /exam off to disable.'); return; }

    const pb = patchBox('EXAM MODE');
    pb.setBar(0);
    const notes = [];

    // Phase 1: Security patch subsystems
    pb.setMsg('installing security patch…');
    pb.setBar(5);
    await delay(200);

    if (!PATCH.enabled) {
      if (!REC.installed) installRecorder();
      pb.setBar(8);
      await delay(150);
      if (!window.__rbStore) { const store = findReduxStore(); if (store) window.__rbStore = store; }
      pb.setBar(12);
      await delay(150);
      installFocusSuppressor();
      pb.setBar(16);
      await delay(150);
      installPatchDomObserver();
      pb.setBar(20);
      await delay(150);
      installClipboardBypass();
      pb.setBar(24);
      await delay(150);
      PATCH.enabled = true;
      patchShowBadge();
      notes.push('patch');
    } else {
      notes.push('patch (already active)');
    }
    pb.setBar(28);
    await delay(200);

    // Phase 2: Dispatch + fetch spoof
    pb.setMsg('arming dispatch spoofer…');
    pb.setBar(30);
    await delay(200);

    if (!SPOOF.enabled) {
      SPOOF.targetEventTypeCd = 1;
      SPOOF.enabled = true;
      installSpoofer();
      notes.push('spoof → OPERATIONAL');
    } else {
      notes.push('spoof (already active, target=' + SPOOF.targetEventTypeCd + ')');
    }
    pb.setBar(40);
    await delay(200);

    // Phase 3: Kiosk (both native + bridge)
    pb.setMsg('engaging kiosk lockdown…');
    pb.setBar(45);
    await delay(200);

    let kioskNative = false, kioskBridge = false;
    const kr = await rbIpc('kiosk.on');
    if (!kr.error) kioskNative = true;
    pb.setBar(52);
    await delay(150);

    const br = bridge();
    if (br) {
      try { br.obj.enterKioskMode?.(); kioskBridge = true; } catch (_) {}
    }
    pb.setBar(58);
    await delay(150);

    if (kioskNative || kioskBridge) {
      const via = [kioskNative && 'native', kioskBridge && 'bridge'].filter(Boolean).join('+');
      notes.push('kiosk (' + via + ')');
      _setSb('kiosk', 'on', 'sb-warn');
    } else {
      notes.push('kiosk (FAILED)');
    }
    pb.setBar(62);
    await delay(200);

    // Phase 4: Bridge lockdown calls
    pb.setMsg('executing bridge lockdown sequence…');
    pb.setBar(65);
    await delay(200);

    if (br) {
      try { br.obj.emptyMenu?.(); } catch (_) {}
      pb.setBar(70);
      await delay(100);
      try { br.obj.preventSleep?.(true); } catch (_) {}
      pb.setBar(74);
      await delay(100);
      try { br.obj.terminateGrammarly?.(); } catch (_) {}
      pb.setBar(78);
      await delay(100);
      try { br.obj.performSecurityCheck?.({}); } catch (_) {}
      pb.setBar(82);
      await delay(100);
      notes.push('bridge lockdown');
    } else {
      notes.push('bridge lockdown (no bridge)');
    }
    pb.setBar(85);
    await delay(200);

    // Phase 5: Verify + finalize
    pb.setMsg('verifying exam mode…');
    pb.setBar(88);
    await delay(400);
    pb.setBar(92);
    await delay(300);
    pb.setBar(96);
    await delay(200);

    EXAM_MODE.active = true;
    _setSb('exam', 'LIVE', 'sb-err');

    pb.done('exam mode active — ' + notes.join(' · '));
  }

  async function doExamOff() {
    if (!EXAM_MODE.active) { con.printWarn('exam mode is not active'); return; }

    const pb = patchBox('EXAM MODE OFF');
    pb.setBar(0);

    // Phase 1: Kiosk off (both layers)
    pb.setMsg('disengaging kiosk…');
    pb.setBar(5);
    await delay(200);

    let kioskNative = false, kioskBridge = false;
    const kr = await rbIpc('kiosk.off');
    if (!kr.error) kioskNative = true;
    pb.setBar(15);
    await delay(150);

    const br = bridge();
    if (br) {
      try { br.obj.exitKioskMode?.(); kioskBridge = true; } catch (_) {}
    }
    _setSb('kiosk', 'off', 'sb-ok');
    pb.setBar(25);
    await delay(200);

    // Phase 2: Spoof off
    pb.setMsg('disabling spoofer…');
    pb.setBar(30);
    await delay(200);
    SPOOF.enabled = false;
    pb.setBar(40);
    await delay(200);

    // Phase 3: Patch off
    pb.setMsg('removing security patch…');
    pb.setBar(45);
    await delay(200);
    patchDisable();
    pb.setBar(65);
    await delay(200);

    // Phase 4: Re-scan security state
    pb.setMsg('re-scanning security state…');
    pb.setBar(70);
    await delay(200);
    if (br) {
      try { br.obj.performSecurityCheck?.({}); } catch (_) {}
      try { br.obj.requestRestrictedApps?.(); } catch (_) {}
    }
    pb.setBar(85);
    await delay(400);
    pb.setBar(92);
    await delay(300);

    // Finalize
    EXAM_MODE.active = false;
    _setSb('exam', 'off', 'sb-ok');

    const bd = PATCH.blockedDispatches;
    const bt = PATCH.blockedTelemetry;
    const bdom = PATCH.blockedDom;
    pb.done('exam mode disabled — blocked ' + bd + ' dispatches, ' + bt + ' telemetry, ' + bdom + ' dom');
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
  // Show the banner at boot (preserves inputMode invariants and gives a fallback
  // if startup check never runs). runStartupCheck() will clear-and-redraw the
  // scrollback on first panel open so the banner ends up below the health checks.
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

  // ─── Exam Mode (unified toggle) ────────────────────────────────────────────
  const EXAM_MODE = window.__rbExamMode || (window.__rbExamMode = {
    active: false,
  });

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
          border-left: 4px solid #324dc7;
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
        .toast .head { font-size: 10px; font-weight: 700; color: #324dc7; text-transform: lowercase; }
        .toast.warn .head { color: #fde047; }
        .toast.err  .head { color: #fb7185; }
        .toast.ok   .head { color: #86efac; }
        .toast .name { font-size: 11px; color: #324dc7; word-break: break-all; }
        .toast .payload {
          font-size: 10px; color: #c4c7cc;
          word-break: break-all; white-space: pre-wrap;
          max-height: 60px; overflow: hidden;
          border-top: 1px dotted #1a1d23;
          padding-top: 4px; margin-top: 2px;
        }
        .toast .foot { font-size: 9px; color: #71757d; display: flex; justify-content: space-between; margin-top: 4px; }
        .toast:hover { border-color: #324dc7; }
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
