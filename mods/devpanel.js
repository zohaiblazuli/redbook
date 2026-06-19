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
        /* v1.0.0 — minimal-glass design tokens. Old --cn-* names are aliased
           to the new palette so existing component CSS keeps working.
           New tokens (--bg-glass, --border-strong, --border-accent, etc.)
           are added for the components introduced in Stage 2. */
        --bg-canvas:        #05070C;
        --bg-elevated:      #0A0E16;
        --bg-surface:       #101623;
        --bg-glass:         rgba(255,255,255,0.04);
        --bg-glass-hover:   rgba(255,255,255,0.06);
        --border:           rgba(255,255,255,0.08);
        --border-strong:    rgba(255,255,255,0.14);
        --border-accent:    rgba(110,139,255,0.30);
        --border-accent-hi: rgba(110,139,255,0.50);
        --text:             #F8FAFC;
        --text-dim:         #94A3B8;
        --text-muted:       #64748B;
        --accent:           #6E8BFF;
        --accent-soft:      #8FA4FF;
        --accent-tint:      rgba(110,139,255,0.06);
        --success:          #22C55E;
        --warn:             #FBBF24;
        --danger:           #EF4444;
        /* legacy aliases — keep existing component CSS rendering correctly */
        --cn-bg:        var(--bg-canvas);
        --cn-surface:   var(--bg-elevated);
        --cn-border:    var(--border);
        --cn-border-hi: var(--border-strong);
        --cn-text:      var(--text);
        --cn-dim:       var(--text-dim);
        --cn-faint:     var(--text-muted);
        --cn-accent:    var(--accent);
        --cn-accent-dim: rgba(110,139,255,0.40);
        --cn-success:   var(--success);
        --cn-warn:      var(--warn);
        --cn-error:     var(--danger);
        --cn-info:      var(--accent);
        --cn-str:       var(--warn);
        --cn-num:       #FB923C;
        --cn-key:       var(--accent-soft);
      }
      @font-face {
        font-family: 'Geist Mono';
        font-style: normal;
        font-weight: 400;
        font-display: swap;
        src: url('data:font/woff2;base64,d09GMgABAAAAAMZMABIAAAACRyQAAMXgAAGzMwAAAAAAAAAAAAAAAAAAAAAAAAAAGoJ8G7FMHOVgBmAAk1wIgSQJnAwRCAqGnWyFuEABNgIkA6N0C5IQAAQgP21ldGEvBYwKB9xaDIFWWzIKkgz9T+7u2X6wRZJUsWt4d0toT0FbAz6Bm2JB4iWfXcO2xENS64YvYbsLcLeqCgY0ns/+////////X5VMYkyTC1zy/zwCFVRRO51V67YO0z2E2oXOxJykROqk5lr6TpWcs2x6FTLIOMnwMWydwmyakyy6x11rdjOFezkcD6AXF0ezJ+TukISkNU2UdV0l5MRKtZzR1h35JeONGkFGixx0b/nkMLmisNJKoS6/PCiJ4iTRFBHKKVc43Ja9TEWV1h1XrvoacpHQyX+763Qf0OSpXEA27fBorDJ/ycP0bE9Rl6s6F/06q6s9QRqIaX5O8iG+tnH8hq+iBkqWCb9xh2nvLKXo9THsc9YFToQssIsWvFTW1WtNL1fJ/EV8xlvzVmrlyRT2LZ7tM3x0+ptnS2df7Y63siIfd3+WUWUzDWxsuVOK/ishBKGoqUl1lJDA3828bRUVS0K3tlwu8kSUHrlvWuJ3+Tc8VFiC1BSSVHvt1CSbGoa9zJqQRDw54sFRFTb5Brk8WlHBvVfZ0j+jR8fkoaOFp3IBEa8x3TZFSvuqfFKyPH+GcZDS/y+QhGzwics0kJREqdSdocDUQTqMBm56r/yh/EOigWzoMHFpYCc/xjeJTi0KvATyOVqyDojH5lAl2ogVba+MZ3yPSLdm944EAkSIAaSIERAQQjFUIbRQegwISK2hKVIEyyNiARWRVyyNJgr6iPW1Y6HYaVaKBkvDjhhaQoW/x+3c+yWpoVVopEXiEUKA1yRAz/f7Bdnn/rdIsygUQXkELA8YUFHAqIBljElFx80A6WZjhSFgGGEGCCSEJBCyJhnzklwuyeWyjgTC2kFWmLJUHBPePar76+hbRxXpfPvW1trxtmpr269arXZZfwY5835qlli9WLHWmm2v1lprrbXWioiI+HIEOcRfhw1yGCs2SLhfIsGKFREbRMRfR5Ag/rpfwd/+Tq3JfvG3LxIkiEjqj1kAATz/+w2vzeLGDZ7QHtaF+vtAMLS1Pj/UvfIwtazCqdfpgwsUcEmmlhO+K0qx84f5D7O26UlhAtMteaBF7HbGGff/05l/38ybEeBINkuyLMkL6GRR3oACQB0WdU7/qyS/axCrP7Wm3drEFhA0C30wFarSEP1zgGEJftW91ZJVSz8l2NifHCpwyvntEb20Tn0YnccDXDv9fyPQsMaH4LVr15OKGaIs60H+CwAMbBuTc29WKlS0VkVmz4EiMo7UKQK9wq46gv937wBAEqlnCaTYGFJAA2XmCRrgXTiCExw9vfFwUMAJFovBYPFvFxg8vrr+85VtyTLkjfMI5wNlqSkxOVuWy/B9Dpex1D9vNwm96eoZPBIju3acPf//S9W69773fqgCQIFSBqFkOSayCSfNZNE4JtkJB6sgj6ZYWlnusOTBBGC37qUhq8X/0klmdu/erwKsxxgolMLiDNBmemMHP6YI+P8u/3/nJpnskmTOm3J/oQtdha7qyb8QEqOQSGQVEicQkkE3KVontFACSVAtVJx6TkXW8e5tmH3YfqrNhEDFcjXlTKqe1ISFZhc7881yuSEV4+bKq5J2QqevvsxSMX1pTqFqP3HqoXt2t/N+rhGHlEnqIWwDBWZZ31eHnzt/bF0JPtnP8YKZhFclqP6XqtX/3QC5+1+3MOOz3STa2uxS4zVqAyOJAkESuhrnyYRIwXStdRrVHWwboPm+r5oOgtD4CeEkXunufUqZ8/YMi33VXP+A7iqKMj2BkCeQF0N6IXXVP/7D7bRl4UJUe7/1bJi071JcffbKH+BwFOXHGLxIFmui40/c78VKGiXRiHYTHL6K/hEBPI4Cr8m5VE0eWIldgCp5hMKka4r4MWCBnn/zloIMpIJBUAMEm27N80sxD7b1StAcxYKZKkvnoUATkSXXefAtU69AkDxob+ep+qPadLf1GS6mFzH/YhVfAa4CMX/a4xe+MdG6HtQwsM3LlxUyjcBIjKEABuy/tf+0VV3/nfN63sLU8t1Vs4gBC6jj1PwJ9vTSnKcCSMKGbYyLkPlxf6MiCY2O8CIylu5VrbclBI7iJW34+q93bDoBW7nbO3cNBc7sHAUOuUk/aeUQowA5kNhzDqVLv95lrly5rvz3plqlv4GhBrIFynJ3zxvqTG7dmiz5/f7/6G+6wTYE1UCTVAMkdQBJzTZArhYUdTqC5EyBY0mNagvjOWecbZJjwLGQNN5mZ7yLjDGRC7Lb8MJsNzrn4guy4C4KDvqv6XTy0v5CV92YMwKVOSmo1SEsvhXJ4P839ZPqrv5sS2soiI9rCsxZBhJZsy+2/PRbRWmFNqY3T+Mzkv1/JzA4h4fQENQAAEqQT9gCyALxP7O1fsaUOEMqquYeGJldE2YqrYX/aFmzM7v1iN2KO4UzF6Wfmd2qi/9yk1JSMUsQDotQCKcwmr831Sp9vxsgm6RGS0lnoJ11hlpjgwSkpPO+8rvMuOb7//cHu9EA1Q1AEkDKkNTIYAydOBpSy8Hv341pANwtyuwVR3Nmxu96SuucjpQ0RjNrnMvOxsbYJN9sI83sRcGF2QVxYiMBv3eqVPY5HfJGxi1CKvvvGTKNyhky6hqIpkbXfYEFrFYNnd4UWhWqnUR4rPxc6s7yE8tzNJtmBK07idCRNCFxEo85i3aTORPV9lHKGpZSaghhX/rN9+stpxTsfUxfbmOMaYQwQhSiELVKRQitYszs0Hl87XtZU+gSAuguUkoVEZDhrfm6//dL//9uzdDG2Dm1HoOKiIiCiIqaucPKe/8Z5vfT6kg02enXt6SMKKjYUUCqgmb+7505rYqqgo3uy3SfAmHEYBrh+UxjGifhDDYXNgp6i15/vc7zMAFkzUTIgAwSbQmibSHWoG3CXj2l+XsjIBjdn/7HQOfDzCGWEGsOECf5kFVKIKVaIK1+hYw1FjLOC8onBCq0sVCl+kM9MxBqyFCoV0Sh3voY6rPRUN/8CjVmLJQUk4CGiqmARh7LAxo6ZkCjMqnQqE02NPMmDxqdIUCjNyRoDKcUmkXDgMZi2NBYDw+axSOAxmnKoXEZOTRuo4LGc4zQCMYCzdKxQbNsHNCEjR+a93sf2sI2F7TFbD5oS9iqoe3muRlavqsTsVauLmjlrx4IQgBQAsACYArDy29BgLxluchAZFbEQlfF8q5OGLl8E78WZSWuZvSVvTqoQgBo5tCHL7vCLwjYz/1ys6AE/vl7FJKfTx9/EOig0qKHzRKXG75KAACYDAoSAFJxzKpm1bP93WEUSg/VQevbG2AAMn/n/wIkO3IX3+POwn2XPkHqa1f4luuXV779fMPXzbfc/ltuW0H58X0CSENoRP2RD3B03SGN3jTkfcPTLOZuTeYdBLTNB7J2hRWrgnlO265Se3G8P5l1XmN51ma0YgzK33wtXgHLDW/li/ONXw9xzPdbF62E3e/faXyHV+yqfv651Yas9tPKH2717eMFjFj+7eFdIj88pWmgTspXkTfwNt7DJ/jQs8+Ffsxng14vd/feS491G2hfhzvR8la2OnNydeRPm/xRg/q0fMZRPEw3v/ZE8Fn1ZfVN9f32pylxHhymaqllAGLkklGmkqY9DtDVOg421OWBhX4p0zF+Ys0qiso8VjpWOavhW3PtQptQWlTHnCm6d3SW0P/QU+rE9UDapHuEQ+inD4QeGVPhyRyb28+CaWLRBeDEBaknSZ2qoNQWOko0gz33GCaNP3/sFpbMBBoKSAq0gLdsL6Sf/LCeDq8I8iMnER5EqUpG+zEDwBOrzY8bFzzxCpMJRxMlHS1GMlZvicLXe2eyf5yze3pBLSncq0ACfsOEmXusLNbP/Ezu5UIL1uoLpgdRA07LF3j8GJpdLTpA3r9NgKuuC9HmtjDtHojS55Mk46iwppRyVVh+3/6i8Gu2tsl/3e6sC33poit975qb/XZbV2IP9SfxzDOUWf8YKhodZ9AwxgSSx7uQIlbBc19CQ+5KxBqTXdIc35fcHKe00Y4unFPGuMdT5l3Z45uqclp0hiX7yE+fnh6UfPTB36fJ2QiSb54eCmX6x1wP6NL/9zq2mszp06DwKDwxYMbXriCwfPTDJZDP5/LVCq3RMX0Ov5AUvib/+EIn9u5duOZh/Ydu01cnUD/oRQO93KxDX7RH/9U9fXP9YIZD7vuxQY/oJ/ofPd739JK1fnkEeja/MfaykfPfrlr63frD9fTnosbf30w4E8FEzjdx/5kZEOT3a1eu/lGzvuqb5OLPC28fuIfH6EYfnmMAr0Ei0AfQR/qBHtMTekG/Wb/XS/pLw4QxkhNTZpCFHGhQAgOzwTwIMzRPLM2f+94BXbn/6ug5m7gpeY6mGmwYl3w4MJXIIlX+xWlptF1PAk/buJB+HItfjVzEIMYg9Fbo1e1U+ATJVpYviSGzmCRSZIocUxi54PdYoVADz3L/iwKCx71rCOlcanEHQ/7DfN9Vmol3ktJKbFvG15RGP9aQou0udn2lJFXon2wiEqGX/Ni2dRTmna2kQi+V6dwZg8/rtkvPPI9PhtBOGx7amUeyNXd7HjtltDcMzz3jBwW6m7Aj+DkJSw/uYK/fHZhySfVrI+a2/fJayMvTqF1mvDHFEXpzaiBvO+3Tb13wq+LyPu1AkUN0L+7rzrnL7bvwmtOw1b4ck+eSy0EHPTc4O34Gcv5zGJm6Q1e9PpxhsAB20+i+Zq3K80FbPPHK0wPrq1A7aB3ggF3wwTmAzskM0pxRM8ZLSrB1yJXqZe6KQbfQhsIZVtoPULfufYjtypdK2KD1OkxP3E2P/eNd7i8DVsg1G4wTIcRBTLhuMk8hFlEUSLncjozrkQ9BWA4hcs6TwmQ3iVgRSRAupyMpnISnnmcDsHHOjCzpeqwgo0RRk8hSXl8m3E654x8NppG1oMoSlY0nm42KNTB1zTdQ4wUNBdBSYSQMGBIBD+82DsbISDSSwaYHqUO0m4+wc2KlKRIxrOsX6RpKe2TvzbwS+RnqW6I/JESx6yZlNEIlNUFBT5MD6rXJNpnKNMPi0hqGZmlesLhEUaSdTpdjkRRx4t6GbsUGleiln+hPdKSt7l6GJmZKdXxvY1SXt9ywIePyCIXKcAqACNObjK/AAB5L4vQoL/DyqYZtgiWHzXtGmcaaX2aBb7GsNZbosmuDQqnYBABeNRyWllVyuA4jSgsY+1uItbqJYd3BDxhhaygTF2UQp30dNj9QZWnSSNAH5/rjWqt89zBoSyokJZ4hJKdk9MJQQDPYWzbrXW2Que5VghYpWKumpdqMQoYQQkLZtGvSoaJ9tUoe7e8g47UvoHB6UokRHVPKNWUGEzppmq7qlmb7gRadplV90suuISqoTJmf11r8QINvTuOTydGTnv4Xm2VuHb8WWRr9qVujfZl3aItLcO71MF717Vex9wcIZluwyt7Ouz2inSaJZiVoVOeguQv+MZqXtLWlDpNN65sWO1vlStuFmcNRwWXVTTGMN3eZuDFI/FIObKEgS6Jh8rbHqEAVY40cJon96pyuCxdbk1uWmlkRdNa+MC5ma/iNTt3l9MSObVUvX+iwYx19GN5wZyXcv7OPhraCtVNWHl1xLg8Ugwfp7c4o6HiiEob6SLK/jjaZpMKLzjZnNm9M8HRslcbNUwtqeV32hTkoeCVhLeU1SFQ86LBkC1caj5qcfWEFalo7aHaaFFGhKUwFqS4oME1QhW1C2GniJxW9HRQDgVhQsoH1vIaMGyRUoKKO1x5qAD/oOKLGYkyZg3ZeCNMmB9lSOM65y7D9+zEaB1drF+3lMIejD3v6tbWE4aDuFIc0StvDbSq90OGoH2zv9/Rza94jPdGIqY2mzd1Gxu9QUWtGhTrQWFo9UStSa7SyBhJaZWcUOlYk947vxksnwgljNoanMkIWzp9hvu67f60jUs1muSDDBdlpU4eNhe2raJozcrUkQxjiEK5JAIlYDvMtPbYJE2WvznRyCBx6GsOTdqcNZnJXMilBEkkkzUnSYMVyE7bupqhem1P88KXVKCcyzCCGORgOB4+ZTXu89NVnkwMLzOIeL+cV5eOOQ0/2pXmiEQXOz3MjXAT7InFvsEPRjcRKUoc1jgVugsEe45Y6zV0Ysl9a/h5jpbXB1l+C7VCPi8vIxcNvpr4zTk5IyFyOxfWs7EyckZwTl4C/LaWlxOGcjOyEDLwKWqfSd5ev5GXm4MrVnPI6+P1mWlYyrt5cab4Ib4U5eLct8EFb4mO2xmdsgy/YFl9uF+O5WGSOP/jsIiLin5Btjnux/J+q53RisccH/re3QNVv8HeCQ0fBIWFIQQHFgh4Yy4+Dvg8MNzg+gkRJQJCGJEuOySIpNkIsSEoVHROHFlL1wlpExXSL6zMYatTExyVMS5o153SZlr8fleLB2OeUOz7+kg1XjE4/eJahw+YeHjHfgosuMWLpiJHLLrfZ2OKysfL2NHEQOVNyShpWdD91+tDgLKFhuQuG5ytYtERE6cgjy5a7t9lWWbXTedXMvgFY34FKoYMNPgQQQw419IBhAQoMJbiBw4cgokiABIE0SGSRwywWUUIZNTQhJtik0skmnwKKKaeaesLgB/In758aSqXHgB4DGoqxoZANxdtQyIZS6XFMCIyJEv0vR55c+TKOkPIUU85AOMcxFzjiGZIukfAccVeIuQ4oZFz1GhYP4/5fk0Uat+J2zAMgYSQZ1INiudGjz5ARE+Y4LFmzZc+RMx43Hrz44hNYKtgyYSJEiRUvUYo0GbKtsFKeAoXW+EeJjbbYqsJO/9ptrwMOOaJWg0ZNTvhPq7POu+jyV/29/h633IEAoKPeRgBAR36OBIAOeh0CgNii5+gC5pnYfzJ0yvIJhdKPgSMkSRC3WJlICeOk4Sw7DSbN3WFYmUpoD4fwollq56zEmqAMoVZEEodITDoDGKLHCLHdtgqUQaWdTmjQYRiYumJju4y0ZZODxWGONUpvHtogWnqVAyZniFseLiU9Ak/0rPQbqThOlKlQZY0a63V9WMO0N2nxG2hVKrX10jxERQ6w+h8Ua00t9BmNjtTGSn11qBXDpvUQq8qI0hzRMVAg8fIkp6ePkwg6lEoR1WRI7C3Epei5T5FimrQyGl8D4qS6v1Q6oAMSJET45ZEaelTK/GhRpqqDDq9OEvhL98OBTxMh/lAu34C2NIft0XkhdLOEEmkMYRx77ZtGdl8Oy92PUNfioRYp/HNrqKeFCc6zQow4g8zw6m+wQDF+q8a9WfmBBi0GGGKEA9yAQXLpTAwwxIj7vl2+efWWbtl6y5ablUb6U+GkaHQGEzPL2hVsnjNgW2uu42i+iFd7mnm75L7HhZA/wMJ2a4wH7Tub/ZvF7X9UQq4JbTvxc0uDGnK0b3kguRx/fF+n/VI2vhmtD1yO0xm1l6s+7lXMe2Lc29TsLdK6/6w0/DIexajutWIOpc4sAtRKUNbglBaLIDkJ2SmGOe/CYnSiFzCsclrbAUV2EZI8O4uY+DA3tKrP3wrPzbGv6VxYehlDngkRD/cGfeG0Umpkoiqbn2mLJcWxaP5S4BH3S1AmK/qFCbMdLRGIgVg4LGoN5fE+yjFifFOL4DLqwdoIlQoo7W+W6oAA9gTnjRQz9QNs4WFbaZEQphA8TNTqGyiC8aGlWBBcYZFEdaQ4b8Mao8qxCoM3oYtFp01K3gIUHB6z4C9rj1SRwZp5mUKJ2GuJi2TrR9J8dSS4NX03V2bXDJO2FCFf5oB4jINMKsx5nItZwnpK5/oFvDFQPJKHTDpsQV4ou4GETLgsIz+HIaxGRmqyIIshQFJCghgOgoKgX9ZBveAFxkdnBYk8QAG73ol/QcDZibgJycR1tAXoFiwXznlkMaxZzKhALm4FenVdWfbytBm6gFTU/ubnlDe3ZZhQHyLRN1xKv77iflcUrm6Qj0Booi/rIGWwhc391mhBLndgCurAlZZ3oQnBoCV5rl9S1lcIJOHGKt+h7OO53AMvul0SgMv6mza2G+HmAoh+5fZWh08ZH5Ii451lXVGbKP+BrxzpkOr8F5XAo85RaeiG99Yizdn+aC57Lx7W0T7SMd7nDOv157YWT9SZcU4OYfqakU7dtbJrQt/T0om7lG4ZNURDx+/9RKXSt9AdAUunSymFxJAfsX2gbQcg3FN/an5CXZ2CrQnesEz1s7VWLDi+8Tny2GWYfPzx4FHcVvHb5GLiO9/3P/5qu0N6Fxu/+NVvfveHP8kgPoMFjumUPXjdQoG+cDlIQYwlnTU+S98JDG7cEN3hrutp55tyo6i6B+i2/PQCwDo5xwesWGZlhlyZdDVcdbbRBYotrvizF7Er4WR/ltwOhDJLoV0ySSWNHkmny8orYJ1iMjh0CBDhuIEqWkqaTllsRqhpH9DDafT9TO23YskBkggmbaNvETN2XzN/Bmai1ztnxHJJi3tzafcpejFyrt892qG5JlLbkMw03zn4DjQnAsCHhGI2ZbMtypTbapvtKuxQaacq/9plt2p77LUvfIgRZpsdcNAhhx1Ro1adeg2OanTMcU2anXDSf6HG9q54R1rNv1kJEBXfpyjsPQp/ZjXyaU2Ntyfw3gSW+6yMSMN6ZXDdDppngSVWWvfu5P9MwzawA39XXXPdDW1uuuW2O9p16NTlrnvue+ChRx7r1qO3s84574L/XXTJZVdcdc11N7S56Zbb7mjXoVOXu+6574GHHnmsW49effqnMVnjm8qpGv/c39u92/t92Md92ud9ubJXx+pcI2s0fKiXtd1WZwyDdUWl4o+L9VRt7RlnnXN+vOZV3qDYWG6qxSmtztjoKcFQXlTqfyEs2ZaVrXxbt23bV7Edq6zoWdiB/Z14ox1tZNcjM6qmG6ZlO27NZmsdu2ccqX2CgsqLnRDAlla8xjKW9YDXijA9Su7FA6w7UEcTqifHafGGPGjpZGWjjjCtHKGLOCcYZhzENC6Q0ySZ5UzJgXmu8hlq0wIzprmO1jROglne4SKfsIbWcgI5vZNaqsLGhTdh+URSyQA3z60v9IaCfiPtiNfw5dGdiOqrf6/NEA/wwQ9NYpKXL8+8V2e1bcxPsahdbPcuiZXLaGTZ7V6+14ZWMmillCSuznM+rztc5BPW0Mo7wE6y2U/xqFQR5Z+SHJyx8ueVfViHfZfummCINtzMy+54kD98DTvgiVIqj0JqjrahHsadF6VV/ffph3nn6v+98EjtnF3VUUe/4nzViMaxlKTm9MXSjkd3IPy935HjUsVeQodzfUqddxxDbFqtiiC+uFOTHKUOFF/TVmW3JCe0RlP0kKNap7gwwLXoko7JWdfXPJfVJh+UeGe+6tl1R1s5Ux3//y18xuEJxH5vXz15DBFDtQ4u7tVTo2HZnr61vXXaNa4ADDV0MGI4HCaYYQUavrw7uPP3SpSVd+pg+6fmm2Tmdsav8HJmexee7PDkJnR6FYGXexVXI0XhKUn1GVISTu1JPOwk4dS/lDSjezSNaT0LekJzTzrPijZoul/6GW+OCvByLnz50xOe+LW1S3GBgOfBDGXi4gC+pMu67HkkOInMXyzmIGCZytolBCzfvVCZXwOWU0leSsByJhcvLen+54yvE/zX1z3P5unV2cVe/ZfxrMRdmB/25H3Ly0yeXqLFeoGYu4j7a9Yuaww7z1yvhUtYBs4z93+udLrZ5pnrO0XFe82vePAP82hu3O/SfvBPoTE/hNct6v1zJExHNBleI8clyomMXM51e5FM5nSeu1wwZHnRa7P9+TXLG22j592lUn9P12vebc1TLesceOXqDvbUL1nuaDrhslgCllx1O9qN/76QDW229nvkqXxji330U/zkd4uAfMWdP47G/IiaeAq7FUDK/ovF7O3WjeApB9L1RbecJe2kdXKeOsqbb7t1x2MKmQqWr9ESWM9fog3+2Tn2hCsBclKwO1fVUbXjNL6evVU4HIRUbHNBeSAkJEZfFhA0B0IwpA+CxcSCoFjkTjhJVXgWymJ3XWLyd/yuLoiMEJFRKlsodF+FSdC9eZXXAR25adt67Mfokz8BKGzYsmOPy+GP5Ti786HdYZ3r174Q8O42YIjdUzpCQVx4/4bmDoJWaRgJ6QXoP9PUOwlTE27qp74MlN1bRm1RiQ8OZfchP1ZOXjVBaPNzv/Zn44dKyDarengbQd39rTKzyn4ZAvoE/EOr0+yMLIsit/uvglVPVF1wWZt75ek8fAj4s6uJNnU72qxp3cVmQ+jTtyczsGavJ9rolOvfGrrD2wa0/3dKn+cAXnqFQuQtBe99okTlRCU1DTU91eNaXdRm1qKSsppml7gb1A5O+1ClagfVZT9qvecHjFVwdiE4heIVml8YQWGFhRMVQVJEaVEURVUWTVV0tWKol8vzcnsDWLv2szL7XZX9Ldj/gTz/MIPk6gYv1gtJph+y3KAtW3vi8LZ8nUkj2op1J49sK9ebMqqtWn/q6LbaBtPGtNU3nD62rbHRjHFtzY1nju9ZutaEYUMrAR0XF0Cf55DBSWpS0VcuZfRQKa+HahSPWhu/482Z5xtPB+JPhhJl8yxkwpQZLncePCVIkWm7Cv+q0eiYFpc9M2zEGz+bSipAITpill5GmeHLi5coeVX5q29RwQYaU67y9hwcVslsuBePi0x4Mv64hYe9O+eX5lM/83O/8EsPeDDzI/3JCDKHXAkI1gLSZoyW5aBR+o9tDmK01hZCEayGNTNhPqKo7kAvL3+vSGQVi6oyschNku+V9v+Hna7yv97l3a72Hu/1Pu+v59qiQeQh/F+K0/pUkjak0rQxbUqb05ZUVnEdOUNd5f+RCAACjfatLBUwKZJp11wghXONTN8qZGJMJ+nkQUo5M7YIYMtM+c45BzBrXeN/oQgI9Q7CHDDoYcyw0yxkHYIscjIDgTMt+lYwbUxXc4kZYoaa4WakmWCmmrlmvlljHjVPmpfMa/0bVjY36RA9aQe8v9qcbEG2nHqVEJdpy0jrtm2pHbmjXZqk9qVSByl1mGurs12R2z3kdg/n5/gu1y0iQGz4/YYA+DjC30AJJkdOPZV0ZDUm+Ct/zuIy3Tj5r2kq+ZggnlBF/OdgTS2vovWrWgObfyrAFFtgKrpJqZiULcmWPFw7w19t61LVpW17Ri1at51KnYbtzOiCNlL/a21um81hRIttgSzgNq9SMdjcU+6wedo8l+IOh7aqTnPuYXTOgdBFS3/DvJRS6O+5BfWMWEETcW0ldWAYl9w2UNcy61k6ke6vBZiKTp6sfYNfhTxA4WAhWpCu4cbvnhysdWB5aj9FnS5cSXRk9A0/EgouBphjjtBQqrdCyLj8CaX116xIDtk6HME+5L57LYBhNAI3+GWyeukXFcjLoIh1fBF3n8SBjaXZRU4cF5jd2LRsQuhsXmhRg3VzVSDkGsOOaZYIkEEEF8YKQz5+AUBw3q3IIKMcaWLiHukAKsXx/WqAOKDLhTwfmqPgwim9KxQRC+ICcuklOM61XQRMLMCuA1hEYd+GFmQobM2yMORQ/SzKPhgOrpVpRLgbGSOcEVjo7fBfEP5d/ZvZ/wnRRXlVfbYmflmB917HiM8jw3wK+gszohLA3ZsmXQdRTaAK++bgLB0az/DLHRtg4CiMUbuYq+Ng18QphtEm7cDmxkHsqmycDI8QW5Dyu8qaSC67SOnutoY7+O1lez/nOHuFUtW5+T62LrW/dHOQOIzUAocbgph0U6eN0NaDu469Qt3TEzu86im3vZLiMJQWTwKQiuPamuVcFXyx7evuHxv9znGWQzjpstApbuEZ1QGDy40VFBd82+DZ5jwP/IERZIvYcF0jyC45+eLp+WP4h0biN2jisxdgBzdahbGKFNKylBoPMmH5Bu31ekLxkjWlM4LWSDekirsnX18oh5Fmt0GOifUolIqGJBkfucoUybMzlE7ldEsqp/thVQNC6l5uX6y2d5cBcQcp53JLY1A7KF7CVzr6opSb5MmA1nBYxZ3LbUBg4Nawn0GocT893i/qr/5qVhteQRpd8/2E6rqpF48mTYVnTtiljBF5TrSIWHzqj5Y34MTXCYNLhTZyoJBw06F1F8TXCWvhkbBg1iQh9QR3Sw5cA1GELI72QSqz7yCrwWGsb5tdjgmzIp8p06lmchsIEf1vpOL7jBvcu6vOOSCcxRTgjA0+Jtl91RMhobdQP8rx/+3+36gaVn2b/HmHFWytd5V4e7D95YT263dafhPzW+V+lZC124gEN8G1f6wiWbk7yf6u5eE7MC9XE694rVdyU/6CblIiQlQtohXQRmFift4Qaz430gy5Xp50KJ24VSx/fXL534Ve3866dVN048bnkvpP5APaYjFyJt5sXPIUY32pPs3yxFrF9gYqvJqE2tVSolroaoEhzEuiLir5YCNtjuGNWzg39jX7WB2y+O1MS/v80pbNi6Z40qzcw+8ObU0yAH9oTwLwxWHoAZykL+BAzver18J7pRd/+4NCbnH1gzas//9PX/8sQF7U9DvAnn9rgI+duQBYKH+IgMQLTAREJg/p+js7WTGKImYWW+dks6PGiJc0XaaGW61KrVaPfJrm8MY153d1XRujQ0hCgWDQpMuQrQPFTM5Kw18d8lU3d6+nsUS6hqZWj1+8+eS738PJUnzDjR8yNQLTosuEOTv2dNDPMkpqtOkxZq4dEVlXebVJjkq11deXPhi7bsHQNYf7XvnsStemotRP/1kh+/meo/jjxObInJ3/59rcnMIsXN5PeNlpx/5ioYDFnJ0aLalWGjtB8oCguq9d45SH3m7OiR17foA4cCtpm5MzTr8b7GB92N8UWENlCjUMTH448vnIR2W+mXic6XNBhQaws3XG9vYWMUrcXeTRmlMLtdTV5/XFrTWJRHnc1snSUUqnDMqsrErZu/dS/srW5LombItbLWm0Njj2s6TFXbWvFeSJnPSkBhlXXZIrzGIw82ii3wstONofPLN121hPSvSuf+Sl22Tk9MiGN8Y36iPdI8tGnGUz/ZH/R06MHB05NHJgZLeoMhUGZeE5O/8qeit6JRoWHRMdFfWJskUpAKJoUbDIO7n/IgORHADAa6NXZQCvzIbnDlUBDGvBtwc69OPlTO9gbz8AjQcIJgGQqrbrgovd7FZ7sc2PLDcPMGYtpsxxcA+VZjj+QS0WWGuHBZtWO/tP3z767IdxYpOmU8joyQIAIELSSAUAvCOSDkDuvkj+dN27HvWnHPljXNJP443nUfLb18mDhbf89UDmX7fuW++t//aUgRu428W/3vMjj1+fiG1gU27xbxHXGz6J88lG1zfRmw0yvXgTyJf8/3NLvfigASzQA2uwASfggT8IYCmEQhjEQD6sgkJYC6WUcZBD1FHPCTTmz0Y2fnLmyZWrzxejfjVOFskh5VLKq7CiaJXECsiYKUvOKuqos556G5nnp857v3a91Qsufm7VQOoFaO5t0T60GwRo61Rnl6efqi8PdfI+henbwWoaICsxYDRqlKiaYy5zCxgw4cWVG3e6oqSJFSdXylZnpR3KbbNdg4Ic3uo36JMRH332PQx/m0gqzdLCle6PRUlix0mXaKtPW3XeKquqL0NBTO8RnlDxgaavtP1onp9p+Wa+3+kYi1MEmBYCFkWCPnF2xYNtscAtAexbAC4lcw7Lr1w+5fANz6NUSyoQGElQZCFRBFdsWVThlYqsTER00THlpLEitbz0igKtCbI6s3VZrS9YcUH+yWZzETYVbmNhDpRtbxm2FmN/WfaUbl+ZjrTS0Qo1OllxLZX0X+tLr9zOksgZ4FiSxcVBQEQlhdhS5OT39o176goOD/SAZivigE1Gpx2yoV7fpVuSwvtaNBANDAhMYBLNkEwGfZSbTXjGZLH5ArFEKlNYjPlj3F9i06ZMakxFdciBl6tAoSJkxSho+ASERMQk5Kg9jVNOC5GYONQOv//7fy920CEn9VDxSMU4ARfOreXJ/ym/Ygu8eB/Br8NOhIAcJE4yF8yDQCkqqLxxMTGCHFcOl6OmXMremO0deUMUvUL32iwiCoaRnqJ4juoFWS/JeMasUFhUOFgWBYYmMzKdsZnYJC00lXfZPMuUmpgwqfi4EuNLSiA5oYR4MpLJSiE7peWpZCZXUbzKElWVbFepdpemOqF/S3G8NY61WlNrNXeqrBPp5WLyBvUVC13bOlytTYqVKLVFmc3W22CjArVatUDAnGwFRjiZvp1vqoaxmv5U8/Mcv842YtDXDK+9NJo1+1mZPG+LZ0Fcb54tDXXzph1J3XnkGOhK1NZM5UHBKy8uHEF8qT1EGsxmi2Y0kvhbZ5g0nHtzw3kpJJt0vG0948kQ0+nEx7OITx7p9cFzD733zIOOM9PTYaa6+3TxpHdn/d556n7uTDzu1UlfWZJKypE0UpFUIOVJlWlNfUq+G/fb56qb64cJxzw/CKM4SZuNeq0qi9Zsvsi3Ot3Rpd1dHe65pU14NzvVhij1IkI5EsAhYRt8LJAu+PRftPe998ccCwc4w2aG38Bi2GJutjrmgqcQ96Ty9s+iwf5GvxbOHNf5iP3dGYFcgSvSKNHXS/B3X6EffgkOt7Dx5mcUX7xCeLiyxZYPPR8Za4EbwCGuM0pyzbspCCjLzIYCbBFDWwkaTuTyjQVXISX5fO8kliuXFs1r1dybE3wbY6swgG/nWTQaHMYxH9+zmOocrixevUdTFbucpjSNK2fjvBxrHiRRGOIqGehTCNejAUt8sIYGwn8wOP/KGylg0zfQR2IhXXd+S6Fv4uvReXx7FV2li1N/8vRNKUExDNhgDMG5xFIuqdB/EZpR/FoP5AofyBIvXT9xjI59r1p2GxAOnz1wUYBTc2F9bliiqC0uwmUsPfFOLpW8Vx2CgkJVeqQdYEB2OoUCNQT2MJjQ4pZQaA425Y215bzcKl3XmFCMJ2vgKAGqahrRYTUTqjQ9VN8ynxRVp9+lSMv2Apy3xW+ZsKPCanXOdw/SSaMTJsZNTWEBDscZ5SZG9uaOOSbAPwgQgxloOPmw+umCA5K0OmR/yfL+Xp8LXVHwfG3fmovsLMm1xo1sp0FeYycyfQ55Ck6FYPfe0VhXGmrahd4Y2OFPX1dbPqRnzTr/SxNkddA80LDgBIVQmXYnwYLIoy2xhq2OLK+LkETjCB9rilPE6DlBIeKXzPoXF3NNAKJd1GKMjsFOaiSOLlk+xLrC8AGPPbb4FnHbBF/3JPGo1scIxjwPUDq6LV93Hx1jU8n0HfaQALnPE3McqDqY0OqMC3cpWmhxHWiVCdInmerOBl8L8asWWYz7llsygWlIFYLo13R5QBGx60zsTwQ0VJjmu2gCc81qEIHdhFJyPm19LCTKR3uCxBw1CM0hMKjiyF+M1hdh5Jo455SH3tlBNfVmtvFtbD1SNm6ABBQWhhrBSBMw1iRMNIappiDTNOSaBYVmw0xzdm2DdT8Ounzdk/NIAfoaKGYX30loHyR+03fb1xJ/r7YSC9hQcQxUzx4RJNVEmzuV1troQtd0XTd0U7c0043sgcrOivarPUaFKj6rqjk5zXLPXO0lMjx63t/5uYJrQx21ZInDGo/qiydKozg6Tx9KKZw6MraNcK6fVFpp5KkqaB3UzaLJI4egV1IPHWEBLuGovAAUciyI6wc+nTqufsdr6TD11fxCOQaV1MnuA4ck7sonKG6Vn8t0ms4GJfXS+hZJyMCpEAXAHyjlz/HrianxQHJkNrj15vJpopXrI1a9AoD/h4vDvpE0fvLlHOtxfBz3jKiMp/B+nPVTwcuGDjKU+CTfbk7quzs5YV0tjRnPqxN1IJTshEuKNbbN7XBKTVGVXtFRg7QG0w8MxTAMnD/COOmV3Lz4+cBUGcnchjXTF1y2xspzWcOVeookA8FJ6UcirzzoeREK4NyAhAtpmBKdUw/XJXuBDoISOZWBz+Va/PyLHtws3gJUCBOYvQQnHaFUxkGvy1JQydYYT5LaZHGqo91b8tltoSO4IKeziZLG7tnLH4Ty7FV662be7mbG1+6wy4KCWLcfUrbMjgqVWqRl6o0z7/vKK+6YrUu+WmzR2J/pa8AqKuPXb2vOIpZa8tdpxlM0nCuywLIa3fCAedPMVPcD/IF2G944l49RwWuka28iuS134KJm578VHQdDf0CFfeqS14zllZzVNqJbw1gFRcRtD485yzHridF97Y6JRN7NmN38Wip13P+A3C3fQ0Lp5OCE+P28aD/owS0BHzEV1Ma6Usp9CGbGN/pR9QhZYKLmCCtxnGhMGuA0xcxEzeU80Vg0wGX62hVOiKJmcq5FY7MAbhW7LUTR3IvGYQE86ngySznOTueBcGmA1xSsiZpHLtHgG6CQVlETZ0kaHOQFUNGqYgA10dAXQENfMZFoys9etYIJzOeKzcro/ITfQawebtb9U0hXHuj7oAp201TBOrSpdWRTF2IMvtWJf6tSUGWgyneT71tdmK8uzVffzFffHdUDVE8w98Jmf/02f/0xf/01f/1zVH9QQf0KHf8WE+9W+1forcyN5pGwNVbVtVvtMeT+1vwX6n9Q0wCGIGgv7QEAyPcCALkjAcjTAec7AbdrADSvCShfFjjxMIDh/fffNAQU+vGmsgxtfFqfEHQ9O0Wkvzis2j2FtCZI0EOdra90KMUWikW25wMOvIeoPRy9OJ1bu7+aMwRyQh1BuMEL59Q1bfHtz9bJBmSB80AuqhTe6Rz0LLG9wo5JjPFeErynOcRonI4KUeFc5RRIbtUglmsNQoy4jLdMOiGdDONwGWEtLiWiLwvqEl2L+64lCqwBhGxK1TdmVYZaibDnBiYrnamkJReAzBFGYuIYH61INwWvIeQZiYi6nVR6MrNiOVwGyALHGJvJJXsanINJWdF4F/gsaBKcrzAZFAbY4j9dLnrG+CiMkPlYSZZq8x0FWXmYsK76FRIpc8NRX6YrNqyMU9UG9WKKUkI+RVoOkk6fBOCP/dQAaZc0mO2KYSV+dg8kuPoErFGsyiybPZ3qeJQKcw47uyg3UibsJswIR6xkJe2I85w8MJzP94kT9BOmJOv8s4ebcUPjdNL4t5r5toxZ5+cOVGGNQcYHL6mzhQgaEsUKWbWlNT85WbcMO5vs0CEzF0MOuWpQ3WMwm+Iuhy3qdY67nUpqMnsBSpy/JGfDIAz8lSSvyM2qPdnYON6X7uxQ6w4QHSRE0vOYt1m6POQGUMyVg+MX1lpi4RB5dSp+vC3dgYuS0yPwgkzyfOjiisBuu2RKcFbYE+1jJNoRERzwPaIziObjeHWl+JbMIuxIzymk+57D1ZwEZM3PkW5E0I9iBMdNulm4o7Fww6GApYBPIS2UpjwGsdmav98/av4V2dHfr5+Uv+oJPF8jc98yVNcWrZog6USTRVL3w+37twdgJnqQi7wQfV2tD73yZNuImzWyOowQNSnrtkFrlh0wcgfYfFlJYBcaIB99KUQcK+Rtt0ifWFDYgiBYSvZef2GhnFAV5YbSObTYcursbcRUUvYFFlk/Hu7Kzo4V0yzYUtMsUwKGwcipLK3h+ubEIGRSLZL6QyvDx6Q6O0/LSu4NpCbrvd0wUBZfJNzsNTVJkvkUrg2KFutonppJ1kLUvg+XOIH/WPy9AL+OYIQtCeJGOTCyJIR3z7C9nkaKlSJbadxzbSi9Yw3tNEjy3FP32uuY3yU2d7MPvRyFEiPS/6FnhClu2hKmIbVk6J08B2y7LC4LORBKIcRhs1STZlXAfNOvkDCUhFckEaY6B3DuB+8ptFxAEonOSVmNRLRRYKTCliSBJK6I6SeAhlrSzGgxmUrpyEUTS812Il2+qCDE5tXZSted2wmuzoNwo2Dm1r0ktCowsTpxLY5bPUyj0POKZwYpMvpeBaJ0nQ2AMCFVoiSmhgJ+IJiX8ITr9gf4XIqFb1hcbsVjmJtRVUB56rikG/XLo2DuNZ6NOn0ULbn9thwQnroc082STYUzEqWh7oAn1eHF8Mj6qzDtfkXgnT+JBQvrmG9jMMLmJ/FrpMxRlbaTF26H1XetwCcNW9q11AYGOdilZ4JVNPRpcVygDAdAY0imKyONclTlOQwbPSLoDl+Po0NWRyxk98UpacjA1BKYTOdDusRyPYbrenTCnZQaKlK2QtobqarrpGwGKehlIwQNU9woNu/jMS1hLvwLnkWRSHiBh4yXz4QW4SZkN03zXrL8+FHELz1lMs/9+C0sKip5CGaHEsZz2L5km8SXCiqJNNW0Y42jFkY7bNBaUyHUIBHVkogPImp7/EIuoxvADNwx7ZT7i0YDMopQRxJCgSnLONpTr1O/JNHdZxBhTR+vQJ6xqtMrmItUfHtcIQGyva7GtAXLg9ns+4eJO+IEPy7I8BRvbvyAdFIJjUnVjQl0tkNdLKVxGPG48HhdibPBOTfS2asQz5H4Bs5FAGPor5JNIqlrGILSIDbY/VQtQs+rSMxVjOKRM32UkND4wXg5JRHSoY9m7SVE3VFsHEGBqOtFRlkr64cRZX6YXCm4PaiCTmWVWvpB0TM+0Qkm1X/+AZ+McJu486mT65AIx65wnCoq+i/8ZIdtPhaD81w/GFkAKDUPQAC3igVNFiEbrioJCmHOODc5c7OR8lzJMias9oOqENmNqb9719F7oylXPaadsMSuBn0gTMyoIIj4H0CltxyE+W6SeiKw9F6foDZqoYbZNJAUBjoWE4tEYlzGOaVFaYw4EuUZz6djNCWGyDcUoUbyBxIo8nZQQz1dVYlmA2M8NX04Vsywt2KcB7rRGhlEpjELM4Xhzcc8UYaC5H8IIvxyTQJr+R8ph32gZjoOM4iXI1QuFerBtNdItK+XosG+1e/k5k49ypAJmP8vhpspZsqlSdHJMKtdClCaxjBcu9CJdSmTyHq2tCGkdBGaFWpRsUPiSlMfbaUhRorE1SRRhfTmRmzYOkWMyqBjWww9r5I0nkjNKcxFoEytYFHNqv0MTALciGdVVSzR7blA8gpa/b46F0LvzE7tYOo5sYhy9DQpjHNEdX5axFSPE0TgjJz8OUFxdigfCoEo0dIHVJsWjY3iO1bDFz6s7V5HDu7cRj4BfMRqoM8kepQDUFs93v6EIHFY+pAlYRoJWzIGo3cDM2XNwStYdChSe8EDjTfkn/PtknPWYWyRfd+ksEFoaHd/LY2Fsk8LBgrHr1uWb4cj8YHI+0Jdspft14VcueFG4Rv3GdVRTakfFhbVLtWtwF2coJSR56l3Xj0iw1CLHjdJlulAtShiipRnMdmhHoZxDlS+dY9RyhUT0ZPdpSioewKZNA3p1CMN5uLW5ZDOpVQ428DeDhYSNLuirGaPBSjBLQTdaw64OFDQxc88lkFLZERSkdWoL646UBgHaQQCONgTJWtge8Wfd4kuztmjXRTJtKc2FVwqTV3ppUgbYqF524xHiYc2IElbQuJRy1aJq4CSFdd0fnYfE6plklL8am52szhgoB5zNdildk5cxJA7QC91SQFaOIEQvD4+XNdsz2oUh3Dfv24SPsM/YUzz0WHhAupOK/ptQQvjZQm97DBaVC+Xoxs9BNn40PEAeZHzlXXHB9VWr/ietYr/JgggqDFfSnPHKrx4FIc0uDtB85aueM9gexOM95Ds0pKbvK3FVygiqMJ9IRAe96Hi3qDpLouQD7mdWSgDVa5JTty/vCxzKI2tPx/e9OCfyXxDKM74dwZflHojH7F0tI8of5J2ru1D9wzYDySUQFUov/+2E59vtcxZ36IqpDmyr/S1Gv8EujA8065jQmHD7TBeDY2tmQfwcTKhsmTc821iko4xfoKrI2CeGGLSQHCjxB9n1rcVN97rYX/ph37OZftm+0U19QemlcmzFiOPu7BZrlQgXrS1bYv7CNOXe9PWsyfHLAvryw0tywoIsf7NCMvSxVMqTsTZN03U01/xIrECidbDxmR1oy3z03VXN1RNI+V1PEisAoghqvJK4jMoRRjHWO3EBv7CEkcYIvWimAmSmJcgSEv6RC0ZpxRmWAibaYdHg+GWcTwRoexrMb91WmyB2mUnCjbhWESPuosX4tQPECTtNsoKQBfuG7cZPmip73eBTIyxmg3LkZMNd0IowjiGZF8rcK3U0YqHxNSmHlbhvmUoOEy0EwYLgOfe65fUsGQ67YnauF/2usKXvQlD1q2qdX0RkGt00P2jcV5saFmOG3RzbOmeOoPcBqrqfr+quLEQpl0Jng2q5hnkCi0tnY2wY9ueR1uGijYCYlSWoZF1zBNViBUqiW+WX1PqWDji6Adwy6iOt4xFgCggPiru7nxDaKN0XkZRxuFQ5zZiuQmg6j42NMIfrWr3nhSxVQQ5bJfMxyZaYTqSuAeTRBoiA30yy7muB2IV6VjRqKUDGr5rcw12jPJTLwKmk2jPAT7otDOT3YGNN2GNM1cl38xaHDfhEB++bjNmuwpvbJzgqri2tgTrpimWchNCX1pfb+XE6uohOBMxtdOM937TQXBBS1nwa7r0ZsV1B0iC/BCDki1dYxtA1I7eUiBFpWENLZBONVZltOZM/A1Ba8lfCj8HB+kAmHQukGcXmZOS3hM5Sa55SBszDI7KrBhht8eDLtwuLvWqG+/XJxS8sdIqvJMgyOJkjbnF+96d97u6yvpOZdTrWtar+tH2oMSUlRLvtX/VWRP+7eM/XTXuPwJDa+IgGnLaDrfdSUqiqKLH+wWu1TJHLbJMgWSrGr6cOYhq+kfBpxzHblyIaHF55+9KE/RzNLKlvyIZebY01bhe6O37bpBwiqeSnHub0nUjwo0aQH+Pci/7Gr1FYM+YkfXYp+LVeAcEr6BhktpONLrpnWjohuQ+M2GEtFTyQ6EfbCIHLjMMH5vel3w2gzqkcd0p709EHTZ8EtNjvk0MB7y6P/785fv//wlBoFNVgAbL8VjtRQkBY+z/mgzQ8FAayv+aRm+Qo/zLbk5oYoAnZsAJjQSOcBFU2hLkgn7kAVOvLpdB5B9Yxm66rgHj1n3HE/QrsUgyL5Aml9FeyP92GQGXYKk7bqZ3ovqXrwUNs2ScK0mhhBMGatvet90W/uo8DPG4kuSVp2m6U4Y44LCvlxzcxuvUwdtbFz/12ZsZO0OojNZIH1IGcnTOC+oARFGs2DghL7A3n8oQh7IoJA5TdSHnJ9cVSkN6oZ0jsMkDTqW0lX1Ga1G6jl0I2GjMZ8/waWrns5QoY61WSFFzFE4x5azSncu/7uJQ2nrqkIN4OIhZi7KDi13+F18MeEgKAH721jyUCLKseS4Z+oUB5tm6xxWQFeYhrp0f7YdT7N5oRvxX9137hPnHKXzxAp+njgt8kdrP+xE2mzN8lppPUyufPtuIW6Ou/6y3xJuvd8wMrebUALtFbPAN7XkLj7lhrFaTk2BcN+N5oLFFWLqGw4NuPewKCA23yetosltcyqeJrQUbjqKHPZgvO6XtO6U91iiRCHmpJPLWpp7iyeASoXq/qY8mzZYjgTbjXYmT8Yad9Um401RlUE6PtzXFMlnJkdb33JswY375Uw5j0P2BIXRuc8s1NHLbcm0bKcNo5ve3T5dGYXzw3QyKntoUvmZwsaCi3yaQP/JBuqb3x/hUjXCkRsoX+/b58Iocd2aHDNuvVYLMnDDRiDoyxWroOdWdQLtia+hbjG1ZB8vxzUzYPb1M4NGhYnhwAg53Juoa4mueysoT3jZ2KiQ58jF3PtqhezufU/+IzOTwp2ek4+dXttPkpN1tMsRnAiVF14yh1IIkIR1dmTsmux6pZjwY79tHPnnHseRn0JbRRYK8rnVlFvfvA2bdsMmmBFSxDIxZ0ePp92PyOkKnwRmd4BCEghSYLgcpxA5z3t1W+wFKStiFD4SWHz+JapsPnaO9hi2vYj3EoMlRuW62uwYL7DCsELbN+9o3b0vtKk33e6YkiJVkdAPJIasHKl2oz/88Z6RZMrapKU7EsOHjuvP/CSgrm7A89/H31prUFnlVmiRC7kM9awk1EhPYebZaVLCDdXWHjxMywu0ttPuLbd6ls4fe58qlKtNe6/JEfC5Fu3SGeOCfH+8lx8p77tkksRKp/G4gXFYapUs3c8kWlWCPYPCLizd7PRMfldTvsOmYM9P43Cajx8sqp198r+liX6/Tu+zSfaCbH8JGf/XMI3Byj2XNEmv4rTXgFfbf/b1czOYGGyY+gpAm0+d9h3quxR1tkEPLoV4r+AvKngGSOy1rgljYXz4nSgmv+TwL4W7Q2bg6DwVEY3OcjIex7evbGR+uFxoyV+CVyX24SkRMy4mvle7RK5Pbk2wGFhPwz8Pn+hYCjIcEge3Gln9GIUm9Z7VbVoBghKqsIxwFiX246EVzxnq5ay1c4Uw3u1tN83a41CAKu94aJehOIjdjrqltzA056xtZbe3ST5+aDGwb3lY7bnCplL0cWm/KjgzuFrPkHChXp4orS1RV2EyfK+521oZx30bDCLLNzV+dVyM56zh5ueYqT68JZyfPw8w1xSXueODSc4GTfuWhriOPsEWVdtsPh/nRDmQoA3BVsiVT5JZ8iWJkSa75FGq5a0c3I10c4etgkZnGkQt5DZo1Qf3UtpPYrXa8mmvgzfdh8+PPFWvLDvpPd7LeNfRnm7fuOJHlxkXxTQdqKZ9NkzpupySS2JpolSsncQ1InMxH0sw2ptorc5GqZ+xTJGed0VG165PGaYuQiUHbtTL9zywG1FteLO8kGl8H9tpx9CRUpKrnUhHDv5LnoQoPt7/9TjtKhg99Js2RHCF9+EOXGqr1eFLInBWNyVRicBshlsUc18NMQPSwNNGA6fVs9ruIimVFgitRNBBNJcem/RsUZ9EGaFZJUJHibzU0KO10cVIdHBotkWZXbYguTCrOW27ibGMacxuH4KvGdUPt+qShdhUGqqxql5A3KnVA/mwozkjpTG3vPM0SNcwGM27OblKL7Lo+5TDdssB1Ot8CxNTl+VgxtcmUmtZpJi+VBPksMbFt0qJoO2zaJaQwjlxf9KF/lHU6AfBpV88TekaPH5EHeH10SSzTNgyDtsHGUbnNhsFLZjX50aN0DeEt/xdK1687nEIpHF1wNutRulZT3P0L7yrgw9vwz5Pw16TDNtgY3vIqhsF1YK4edQ1tVdPv+OE8VSdEBDsD9X2EfxzA5U/vtc/uTyvYty8VZvp5xt4qimHNHEqtBI5QJQfpLTanmWc2dazZsgWn37CxanGmdlNIy/7QuNGMKmBLlvoqWu5twyb0pUeyplkHKw9Tyg8R7XyCDXvhaXlfqhz/dOWjOPg+rpMiL30MaKfb08kom1xNZtGFY1uO+nylmiBfFlU/q9mpS85o9wdFcp4G7NwG2Q4Crxie+UMIQCNOadWeB5NcEzv+Ow9sUwzGdhxiYGlMrEwXuC7QQKs2OTJeJCK3KAiGumLXpyRRMJVJRAPLzpiUjMTw1AVmAIIBzllLYgGoFWRkPKokUABO2ZkUZkayEBDdNLBIBjnViqSl03AFPb5z1KYWxZNGuZg0ZtATvANLgrQ1C6CN3meOc5YlM4CjUvZ+tEqRBOmoR+UOJInRUrHA9XIpEQMLxPWUgSqLhzlRiKhhBS1tM8QCyihZ/oHI/AzOjJUFMJe66/cLH6sHmurTdg+0LKlkOIGG+ktWXTyxBwRPel6qA344HbpXlBcEZX5+zrhO53gButbqeODQqmm0LcW2lS/1tgpXNtXq2HYy1ZK7J0G1syLdJKUu0PNt4Mw70BJZRdhbaI2MEAk1mwvRx3X8xBK4XVMCrehezNBBZG/WVtGI+UZAZMbGjiw9GiZkBhwVzPYGlW+8C53Up0wblbobNEMTQlaWEoctm2IGpyfEfTfm+p3qmLTKpA5FmYZxumOmnOx1PD74G+JqfEQ+GXgzTwb4UYSrNBr5XkKPST+ZQo8K/XHiKfayvX+GHXmn2HriF0x+I1W8rN/Y6Fwt2lnA7uMF3w3qxfXvfEiRSqeduFeFLkxeZqJ/PNzamKt/cVkRoX3Gacun2OC/9qbGlT/C+/4n/ytpyWhSnvtLrXq3G6ubNAvmHt8LxenSNbVFx0/9145Bs6gIlADB6fKp6XJpkMBQsXkijdIkr13cbWJLuVG1KuEVld1HeeLiPGmgIDNWV1BC5h9wTp5hk6wetjHP93mfkqAiUImE1WIO2+yUkLKxFNoy+d+h5tsBL+pcgHaM3RcqL0QtYgeyjTSetecW6W09kYvvir9g5wsSwro8ZGffHju+eiEIOvluZ2DNhzNBtHtnHe/ezn1/bmlChhx97rn57p56t1ANHQZibE41OtLYOb2uB1AKOFylAOjBrzDpRFyBoRxYUV2SaO92ifcFusT7ut1273gwtdUTmWS0mvh258z0MucGu9RuT4DdEdhFkxMzRT4s99xBdKkV2B4IANuWWlCLzdQQmFqyJLC0waRL4icqez0EreD3ftjZYH9HYyXa+9zlu5robxkpHWYpX2KyJqkqonOahvtcY6svnQ4o9ve4TDYzOtxe0e4dXlUzd87qfwpZIaapONGwyKrcG+yS7ut22+Q1AmVdgsIVmSQHbeU298z0MnSD3ehcFOY5bP2zHgqtGrdKTtlxlER40K3e1xlQ77dlWFsrlDcheZtEudGmFds0tMUOhDYKT6+4ngqt0OwBcg9aXzMYrjwNI9vaZ7ksnkN4bB4yh4jYIl0MBoJP4k/C52ZZo0IPBpuoqRcJ20IBW3SYXW8DZg7fQe70DC1RYzCtbWuKq5tieSkrm+4DZvSxHDM9fCTgh0WYmEjzUIQdmRvr/bX317E5xD4UAWnmgn/V1CK2LcUgQ9f9UA6Z1PVwvUyIKURjqInDSy6dOr3k8rD1L58+5X4Wh2w257rlK5zrbVbX+hXLXeuaa5wnKZSE8Ym4lVjVcPHMmYZLVYU70JLX8MGHW61bvz8BR9HQ7QU2GWPd8pVzSiZLrVze+zP33J32iUBd3QNpH0tp6IPNKpncrIT7zO45ZHSid6Kjtn6iq/9+mBn/ZSJmYveSMVSgn+1x4JimkLEYITcSkm0REYIZhD7okM6J90Z+t2buTsfijupynfNxsUi38H0k6TLDrd6AD4wBJoVEapIDYy4Mhpto6JKoWyK1rshYELUbAJDPJtyDKdY0fYqbSdZxxHx3I1OvrxeKa6NlrkiMzGjVKUxSVv57+jwFFsHViWgWEV+CtNJnMBhM4Yuq5na0AP3ikjm0j6VApXJJdQfPNAVPGRGtRI5qUAR87+oZnlgueV4dGvgcxsCfB6QYamLHyMrgR8hHTtBjMIAe58GDgSnX7ujfia3DhLc0eXQ6U1subm8WbkwOGMfS6aUTO4Jcwc2g68ivt6+jJ2sER22MsMV03S1p0KajIx64++SPST5REqKqY75Tc6myZl029PJfqnqnumY2r5c8jPD5Hv8uw6T/sz0EcbnVTGR5VhC+a/IbYNCPLuhf8M5S59Lh9yLyNHPfdox01gKmCj3uSKlvW856fGAFpJZLpFoFuMKFwbAHRcnmaaobEGN7lu7ebEzGGzGqf8I8jGOaC0pkVBUEIEknC1RiuYB386IzKgHoQN2VjYHaL7F/JxGAX7Ip+ZMRGi+9TG+BLIrSXbmujflE8m+YtXE8nQ4qNyByjD0OylMXEM44bZEZB4YthQqqwmyyj00W/RFuoTmJOZgdcBTWodErq4trnyrY06pdYeYiVT6xSHUGoBMhY5Iqdiozn5w2a4zj2elNYaBxDn6dZ2PzNbVK7oDdzh2oVQJmpbHRgxob5HprA+qxNM4I4oBWpWgQhkUDrSrAtcib6HREntHwWYkc1T9KPQsQveWITHT0NYpi4/LB98+ijZ33Gp4zhoFNdjrDrLM0elBLAyA3NqAeY+PMt3FVrTMjo60bqliqVJuZm9Rl12/l/A1z/qaPi/W1b6lvkHKV7VSNj2NK4vQtElGXGRIF7N8QerIy43qq+khv8YghU6eLTNbfriIap8tGWoh4yrH6kfHlrWY9hHpNkEuvhzx2O+SRMuIMLUrhIAwLB5pUenWjTDTgyhiLgCG7mq0ou+GKStEscj9WkSKNJq1IAgLCmJcoJoaYY2hRPXstGBYONilZe8LtFvjl5PQ7f7nDAOqEUtAg/GR+FbCKoNUBhsPA4dyofMI94N68g7zL3mtLUjsiz7wn0RkFQqTYxmArG+TCLoNREKiTK/hOVhYMPa4INrQvUFm8IRZksXnVGqPXagW9ZycTnzI1zP8837zIqDkasUEzG6WETNLHr6Pf1MzB0TJbCRdxt7vssOQf7TKjCRBDMRgIuD38PpA7fxbQt84AB4uqyq7+D5Bh9VojRHTPwR+HZnfcvHe3rO7ob/Wt03qMGLj9OI+VNwQs3rDhUf0DxWDIWFOo6XMzyZzsj7x8gCITOOoqYVh7Jy93pcr63a16P9/ph0t+3nnVKJsngTjFbr4dlgACo1gCGwFJC/5WUbnZpLEANnxKrno5vpQap2/plMiOrdQH/oAd9jFEdWY91ICi2tJ7P39LsJhjcUbnzMioc4PRTAXtMjIVsi5ZTOo1a1DlFA1yl2QmFT/BzCER2QPyFDd+8OuumA1alcU8cxAMgdfBDK65xkQf0usBQ7yZDVPVX858rgbrKyqgXq2G/P4qc3VD4cdGkVeIhSYwVU0wa2cSmCndX6z+nKfg5biZHPZzpeDzuEoB3s1m4N1Kfnn0DPylGqay827DhRnDITD/hw815uoqv7DUhfx9WOUGpoengZuRdel1da3GFqFEJX95EEA4cepqOh9iOCI7NLxykSy/EFdxZpNxAUKWUNX17iqFs5RlHHJELpNxuMIhAvmkNs4S7yKLaHSuwlsggl4qOVWVbLm/tdbKE4AhKiVLpdo73twng2RmWCKTOtQIzUyTqss59AtSsVYnf7k0uGkd9zhwfBAevAXc4urUq4CK5v+r8iai4xM7VDvacHxV1UhbR1A8uE8tFmf5pTwYFWeuaPLaYamJqxNItZBWDGMhhFrVcTd27jakVCZdf5+ibgz727WF6La3FEetLxxqcGXVeVO7dcOfCFq/sEltUp1A3KuJ50L90zeW3Kg5G355gX/dbfVg5UtmAEn2Tn9+zrVodOf52fPop/CPZzldVtjcpQF2m+vmBMBR/MvUgOGIp4JLH72PLkmNM/kbEtsOTYtKLBoYawwzOG2lVDNPwce7GWwdKAS8YCuHeea8tWvVeo3811NAlFQq2gHoMe/RcxX2om8udmT/VHAUPYqTO1J8q71ijMHGvOhlv6aWBARtqYTQnOw/tPbwCZBfrtNrlEPp2DhxXmhcVr0s7Pza94oyiTjrwpnehSQNtRf0eCHI4wVNqM8MoV6jrPhdNuu9YspbTNYFCjS3GVZdXt073lVfO97Zu8q2etf4kl2rnTVzV+GWgABjw5YtyBNWraqhQRAERF6Al0+hpzRL8syPxiZNOeMJN2D8EZmdmLX88B1+DXWPuKkBg2mo3Ovf6q9cA9sR+xq4cuR7Jd9I35AQREFPBNtZYhfZFakxyq1aWFou1Uukg/BguYau5Bo1Jlgna3RFIgJ3C9cCtHJFqFAhBhVJi0mL+ZyKFt6UZg6p/asmuFLS/conyVGMNEn8Wn8Ty+Esx+Dh9KwveIKS9jkk8D7za4xFIFNoxXP3zk8UOyD2wrXJrUsylNnvR1ccOLvvbMVPgb9my2yY0EQX2KoWDNvtgmF7NaALhvZPAlXGGvMKyFD9pAgy1FT5x9lQY+EcEqAEkKo/GOe/KBhfocjbXt+EQcIMcr5QXEG7K0XmLOQKbRxrfNqqwmr9AELX4lWKRapD5uZnoVkjxI4PWX2N97S1jnc1wloQpNQDkAZabcYnt4g5G4/MXbeJCSeLawcC9fDFkLb5cKutbblZmzMWTsh6C4cvCQ1ZvtEOZ9De5WoKVOC+DrcIZQqDLaVEXvU7N7mmJMWLn0N423hIJl7kpjC9pub2Rtci0TbRMxue/oeWcyclF99WdoQUBzqGohaFc2BOVPfeDB4nhSOkxBoTJi9yRwQ+YpfU7BuM6upsBOTZTElGT2Ra61jQa+92i/d1BfQL0+0awcwGZmEMnP3xbYhA59hoZTZJNpImfodaApI/1VSkzCE8R8Qh31bU7zt59YrvhB91m0ccDneIcMqCT9IGW1rThj4pEP5Qa8v8zfeTReJTubYF7mq0faKh55s5JHPgeMaO1uURy0GrWK22iis6ExOsJ+ATzCShFrAjWgO/SJXLgJHABvgD+NsrI4p0Yu2igb6+7qHBwbyANVCD1Fy1XnUP6Hp/0DbQZmA9xkC9baTGv/EtjIPfYSzNdA1/njuEoVX78SSRQ1SEnwkIQz9ctfdbg+/YpdOHl7L2bSOm5n4YNuachnRIZ0xTBH6q+Yvaf2s8l5E+eXQyIzEzOnyxc2rZ59eue3cg408vjzHwJBiX8dnQHgNY2eOmDiXwfkRmM3vdgBPfS/J/JPQkpolZDieKP6ZzA+LQTYjYIq/jMbD9wxV71t+H91dsBw4/QZ5Y8Xvg+ZlEpFBy98JPw7Hd3J2AJjtSr5lDHj4MX9upLZhKv3Eib49Aonodw0ajY3DPZYMjGL0oGonscwxVYZKSaHGd/RvXVmeOSS2NdFNilJVoBd7u+a4qwe2JqMp1cQW13aMDOk57XbnBrDSZnQ4TrJRBHshpMnvd2Gewx6Qi3x3IEiiYeo/GdYyxjvNjAeE6dfvwcfotMimLs696DDsFMOdFY1hmG3yOOV93+NEYMHYv/I48uw5Y98iW03pOVknSRRty82nzwDm4bVHbkL0Nr//12+F1aExMB7oPswmDTr78Df5t8iW6CbMPg6797Xf4dwU1rqrVHQs4wt2VatVdKimLWwn4mWcKSBUqRX27IzJW3maqVKDFZdqS0vtfftlWpul0gRAWXh+zzr0S0tMT8+rnv5pCoxbENv3x6u/y00B6ClJGXd+Ghef/Q7Q1/izT47Etu86raAsWHlw+gHJnUPEsvPPqDkzVT1891bmxe+tiXs1Lw+YvA58Al78xoTOzymaRtNvh0NjeSHkGPrNeP2v7oUlmgysrMb9BbkUMgTzAzI7hoUHn4Dbjzg9PA5kseyVUdRW+yh8qY0GFz57CWEsKNAgQYFX4NQqC/KDf6s6exh5ss9sgFp3b7K93GY1sc/8m/WZ5CDULqew3f4mFsZj0lra9rfq2k7K8yTeAT+fWPEw+mLcNrZlvVum+D6Sn9CTlrP99jmzz57B+bLbBeRRnE+TIJCYy8wSVeoJJrk/Bwndm78BzZPbpg09nn/6gJ88xG2PHAS1HPqjlLdBeNB56wCv0XK4ctGL04V8DX0cbQJuCqxeMOyLjod46HSHOY8SCCj4ezg8p7gq04ATUA7SoRAPwgWpHMXgs/FAf3Va72CK0K+kDdpg+aM9MCNUOR7eE6e9HK5mcBhTlNDBZbIv1s7TTufjaE6m9HKpxVH+JhS8O9f2rOXr68rRAXloq96EzAD7zUb55b74Ma2Qq2TxLvFG1cWkZXLqv32mz5nPtwJp5L+Dtg/u2AFtW9PnrHRoNe4L9vfo+qYhcLJT2Naeg917A2XGbtgBPgY1bYnNUL9B7lZoLS+mpaQ/gB7jU3KWnkHhj7ebp0g3uha9z1k64tmxDbvzJ0D3x32rFBvXbEcTFkXxA+nllNB7uf1CU6gi3mX32X99fiO7916qe2MPkFCB2wc++fYfUdYNnau/binNwW/YA6rOaf/7q5a7EFOkfr/7uZXZv2hnjoKevnjrD/r3QvWO/4m57wiycUwMsPnUDxeAvBravV5lFyHuC+eXvWB5Jyt7glVrGTJnme/lWnQAuTjele+LwMqOYIZeD1tVcuelfCoRGTTYB9htO33k+qDrJj4MnmsTO/BZes373uMeOjHms3czzOxI5gxPwH/BlnZ4yDFqZg26NSKQx2lYQcfiG4zJcInrnWToUfCOrHOCXa8SpuqUX+7dlFQAEiUyYBgDP1/SXDsw3A1ygjksg5ucBuRatWcG9OE9lJhq7OOVeqdpQpU8dKuzjCa31pWqaI91AGeCpHvjppUojv6z0TQUuHzJDhlCPoVziMRoJAE5JGeBotllKKzO11ERTh0u0L9DFIh1uE9juZnZXADZtd/3cWZOuvr+9iQvYN+/YzZ3xWv8/G7Y19YjhexcuAJWCULEmcBiGmIbSvp7WRl7MWycLeRqV1oCYYrWuyLj6JQNdbf2dKLcAhJV6ko/prydPw0FiYtdAW4TDGRkpg3kyqiH9UZnWI1fzYT7xtozMU/MVShWnzRUZY+711zf017kCQaIKC1aqVHJfF+Otic0oaP8KvYPAyGbXzxGV9uJEdR1D7AJckQOgWKK2wgYDiGgpRnIkWroqCFMzbm8z5JBUdVJ+q1YraWuRTJUk9o3v2ejM3iRb1KQw++rRFMAVfX6XCKoaiB2ImnWzJJp6kaBFD0o72sRam8buNAOQXVlmIFG1DD3i3XC5TXy380PQPQbfA521nXPs//QpqImaTrq8Qq3W+x5+y9MJ+DxHJbO8vIrJdfAFPN23D/U+tVpe0UHXnBCo+AKWQiQSKkUs93PCRzUumVJqBiAzBEiVLtls8W3hdngbPryTwu52seZtHZAeQjoA7BUbqInOEZd6fyCg3jfidkK3W72P7w9jkANauNnrhZu0FjX9omZvjh66RFvpzpSUxGeWDb6/s3SVhe0HX+1xxQSD/AEtnekLkVL8TvTL4xjh2ykH/zv5JreMqZQIZRqV85mSWZguysyu+Lf47PoPtZL9Tk4MSXn5rKw/iAT6n+VCucjzPDk+N+8rXEZGdoYgg2rNya4kkktwz0ovejj8YsY/rnBzhdwn0rMvWGdaBa2rVtvofkfoOSA3qsv5IoM0feXF+Oqdwru4e5KThdkFcXnEyQLR289kGnYpv8NzHCi3auVqk0KY+9ku4l9F+AfI7eM7xHyVGF8jcZo9MgHxSET42QJybyFxiyuPn9zrjssalHsFAC1CeJ6rFe0XNd0TphdyCvaXHnpZSH8hlcg49MKXhyT/KOAAQvVzMTftUU7OozSu6Dxx6zecJZKmzOmtcHPKVR2Qchj0yCuxO++ztVsf2j31W0KfVETaEhF+1hXzEkdNnNx8+dTpzZcmJ7V9+pSLTihre7auWwdWrfc7u7qXctDjlOBrVGK+eMfx2/aH+KK/iGs/yxOaFGq5Vft50RZiYS+54Gx4xJamTY9rsm1u+CQTAEtNjvc1F/86ok3nfj0paB+mjMiR69P/Bzc++EGvW147Y5ZGuR9EpE+togo19qH2vyy4eXZx8sB7kkz3ymJXjXsV/dLA+2UcjOK1L4Sp0D4gMyYK9ikoH64/K/53RXamKL2QqXzm1KhkQqWEWcZ9c/K/B1PeFpZSheDF0me4EjKxMjvHSs0QZGRnZOC+ysuNT37ukYuE5X/SCcQ/slj5PEgKchTuM6yzL6RPuEKu+/j6ttXMIqFAw5Y9e1tUMEnMiyvILjwpwd27K9wZX31xZbpUZOCXG9UmilBmVnAb8uBV7Pos9yEdUT2Re0T7udrzwgiaAFDubSBShRpAyCn4h8RE30rGkUhfpEr3c32yAVKkFT1TJOLs62yruo1iVcXJ4CnwHHgSpMTuM9Hq4MfUAL+dH6zPyrrZanBoIwv4G51haEhIkAwzIgzElTFt0FLHb4ARMoJhAzF7tgOh8E0CWTB8sP+u9eDgKH90MCRYdthZEJYEkVlDg0K+sFimOQ/Sd+ALSFEZsAh23RQht24dsyc582uODR+v+EtVTJhaF/26lNzDXFeXSx92cSAqzcS06PUyc6jNHKJ30kMsmhGicu6C53XzLJdS5QZCGxWoys28oAs5H0yFoAJUF2wGz4Hgve07du94op2wsrNrSI5JcW4y9wHIFm6hLz0OvkcdeQkupI3aaKM3wZ9oI+kgaz7nZf/MNN4Bn2dBiSAlC9KY/RkGW6bhjtlB1BdZC/ozjcd/ak0OR6F64mMwpmSEB1qrM9iPg4PBsie7OLu4wb4O0RE0JibpJiHaF1FN/g75jhxRHeUjuG7mQ/DngsHPpyIgPEJUwosT7av4e15Hg8vrF93Bs5VKCWA0RGtdkZFyaW2TQC/3s7gecbkIlBX3v8tpmA8OBje15BqbemXasIRrEyjElj+WXWAj2d9B9xd5DCXngMkQ9QB2Yqjv5WRfySl5TaO9Lsm5Ep97Pets1ZKtwNZ37dnatXVrz/rXkB+LWFJ2uuRGhevG29IbqGlPqSm85ohTO3PfQOPUFYU3dJ0aghCJUzsiyJNGC6+ha+E1RuzQJRg61Fwzui7gfmp93ABaSI3GY7OysPhJm8yYmKQPwlVxS9TfI9+rYXW4KvOTpFYalYq0hn3CTXc5NdbQcvJNDq0tNJG9Ari5MOrIgHFUVC4G67JdANP7l7nBjK9+Ba4B8ckGld1Dswk8B5L23eEqKfqSMiHPsukKKmAiHeRs3r/pZIWAV91qUsGr8tbo9RO2uqsDNLbV+at0OqyzrQK0uOetsMQ7i/DVmSUw7ZO3cG2vA/AZG6isHq6V28OiNhgBn8MJOkpNpaiBh+ijo/RRPIcB9S9wgJLrvfHvne/QRUXpovnIJTjzWF/yfqsMlWme3nxKWN762ZlGhiJs2LxzUqQrHrYdbH8z3EU5edyW+BvHbYOb1KUc+mI24w8jvTsfvLZvHRmrGGEV9mx7Y+VtjmE7CK/4jMOfA7Wmjxazmh2nCwwCTu+ADd2jH/0BpnmuSGP6YrLcSnL9zQ03120hF89kxWn7atGFb0kMU97/ou9kV3wdcWJb7wYRVQzOcOiGCuuX7gZ4E/3fIGePYcbrg+WUb95Zcox+aCyRGJ2lNj68xWZFE4nG1ErFyYVEoazrp3Ve6HuzFwI89zn855Uq8Im0DdH1SPdZ6U/ftAdCwDvaZllArU+TLo++aS/Eu3Y0xHjEJlCTkpaecfFUha9OS0cRHhH+VfxXfCLbPHT30EwosY7/hT9/lY2nkzv6Movc7cLH0luIbAVNQYcgKrJ7A1vQ14WNZjFweSjcjReZhnyo7Bpm0eUF8uXGL+1nIUg7LYFeyNvZO4DD9l9rNwgiBa5NHVCHpz6jQmjnm/80FZqLTAFWwNwb9FCv2Ps93/fRyWypWC7gL1iPVy/PvuzM4M7Ob1qS2gaQOsJHwLxNnJut8vPDnIEfzQKpLuSHCSAgsssavM/ll6cOl//LIdpns504l+lkUdFNvuAHXJl0FSwH/uWcHOvpXNhiTYQybQlBYWl804Pfn58rbL8V4Z5f0M//eaedf95sy1dQ1ni3JX/Jxjn9GZTp5vD98aN26STJMGRwaJQ/anjPashOGxwUAikTNQdr9WzG1EqXBpcGbwhqrRO28pa21gbKinnvzublCeHOnYBukApohfY7woL8MzKXfCPLrafl4NBQGv/tDbrxI/HTpowtt0knhX2HgW637+23hH6/Vr/g6WLKT9tmKyFs7fCjW2vg1xmpz46pgcGhaFxMGxg1Ww8OhhTD20p3+kJ2ss7YoVYcFaNIqZkCXzoxbLSyh0Dxyew+WjuFp9I8gFOBefxgJeAnxDGL1hQda+CDuchUaP7TlK+/3xNu0GGuhbKgQ7C8Hbd1MdUZbx+vnlvVQSg73w/aR1fVQe9NhHY7TQ3uSKhsW4N2PhR8l5bWaLQuKHhDcOlvOyOwtVZW/XaY838HJhUeloUJukokqdk6Ly/b4s5KJwxkx5rOcSviSGk/gNSSeY3TfDAH63CKVECUshWDPZ4XWBTQ2nDpbrizGvLyzqZOnSmI2AJqfyPchhGiv0qmdHXT65is+YA13RhBvsj+1Q8PBbKAHwiQOWRuO93pNv8myMm5zBcsB1fXK4IfwL9pF2+VBiTBskGC3NGZzyvJn3fQ8nOk21jFSWZoDFsFaSsqvgQtZG2q422afbAznbnGk3g6P713FCHJEZOM5NFr1E1gqSqs5BJesmvSyXDPgqImz3+fTiNJliEkwfWyl4w7tPtQUaEgQKoub9cYgeFO7pYvdnz85pmWEWlf+8TJ6z9W1CSn0AiXb530IJQ2NtwzphA2vujQ7kM4cm/1qTxk/pDaAFeJuN4JvdhU8N76WyaADsvJG5GmfzJU8ftAhv+KV+BtnK8zRf7NZCgeiiMvSvO2tFIqfiVyaAW6hQ8xnfmZ2fZwNMxDWeEAywVONgOVXF2h7hKw3r7x5cQIbZqhAY3F3lMpPhzeHuaktn5870PtdyPbc6jWSHmUIsuGx5fYohSRcrz1yi2XUO4IMAxiBKchKAlmHJdjyXlIsAmUzh4GKHbg1Jg1jZVytms5+CYoqvzIfB9H/Zzz5z8N1w6m1PmP95Ri91QeueanBQo8zPk6s2mZ1oKd4RFNWQCHfqrlD6eGPKcBFm6cTyynOyLCCC68OBfe2D7XhkZKHWXq/R/SGweO3A7QjqjBIgMQ0Mm2Dm2BPlxR77S22fjrqvqJE8/J+Euz3zcRmDzUrCjqUKgpmbqJcEgT25AwTSKyE7BHEmodQWRFlaLJLj02OVu9DBEpiCNr0zhpDmY1J60sFSzhHjc8Sazr9ntKMzRiuSqbaKCbUMQC2SGtQOk2s3d9xKizRccVtl+F62qN79fkma6M/Y9U2F1IPk/KXVK6maXEhR7/Ci5R05kK0eoEJtdexnBLpSy3s4z7zRwU1ATNnPK63tpoIxI5oubLVVpCrqwETKxLRdQCRwXZQ9ZqO62ou8MVa7ZHDmkZAvoNfK5Cn2xKdlLdJWZb3vqBUipHgRJzefSmgvx0AEsqvpiX9p4maxslzrG4Qru/pVW7z8Y4HGMVun2tLbr9th6RaKqN3GVoBfZUGzTqHs6yChSHL5C6gmnkUHxSKcVr5DIp2sJSBaiKcFPJDJZJLmOBjOLyNlUERue1V9BOCfwUACj2CwSAWcpfPFRVrEcxxFRRJmVeEadaLGbTvEKZrFIY/PqmUkRTU6qFMjo1N+t740C5alFp9x5Wzu+pFAmrkV9X5qtLZVQhldcT6Iyt88mcSe6kcp/osuySSHb5yndFVv49vq1ISd1E1RZTNCUlFK2WTMVuMkUrNOGToC9IIJJyCYRcEhEv+PGbkvt27v2M8FYUQnER09Vgten390x6xNxO484z0BneM2esPmJ9hFI/7g3ojZp/95ZLvRCkcX875T4zVO4N753rqxYIocmT2H0uU8BmCTOzqEwWxfod8CVwg3jxbXNHW4f5bT1IBT5gbPKtYaxZ9u6Do+PNvrWMtcvsCXPiuZeqU+JTQyfq3G6Pu3dJu1x1GHgv3LFw+6bKTTWn5sZUUrF0EL9lbbKuXTcC5XqPR3zhjp8aw/mswewOz37DsvrRd7kQhMzcvfK6/pulqCS6mFPMuiwqfBRfIN3kH1s6tqQ6pcNYqNxIrdFzgNfAa06N/uqDDB/jF4YvQ/1NHKYaTHOvqDezeyo18qhorya6UhPjRReYHJGbudq8Sab+TLYH5AoPi3atalOXVOzJ7dsirdnobOtB0XRqfr4YY3Gf9oyesk+Ngp5IYcRbqem7PZ61bdb25JFetBcVtb8gFb3wwd8AvheGKBeILugejfa5IjEyucXzoiUb9WqtzfUVGA+AuuPqu2Mdrshunk74szmtklNsFHC4Fj9DFm4476M8lqXc4bwpHMvh+6GH9+U8IOZHgBOJWxiCGSBaGAwub/rLva3c6FoAh38dq/88BJKI0Jvj53oxATLYZX++f92qrQ9OYLu/SJ4A9g7dSqW/gtR6cXQFJs3ZU9fWvqgZTjszwAfwa3TNpWKYn2hx0YAy4I3m5gUMm1jBd/CkVdE4y7LKqbYeSAMx9R+MdTugZiBFg2ossfFxsZEWTUWKpgmA9A8C0re+ghdPhr3PfD8+Ie79Q3rLj2EXZtuCEACFnUH7qaFjwLHgWbQvUj3ESIbfncB5wuoM9cm+6XfhbGCZfofb4ImDRyuaEF6y/hTV+vnJ7NAcjrVMDUHqzXOvVJ9vLDPWzTmh2ScW9ZRaO8X+8pjkjE6gci5RmcvnOn0sscFXxjK3VUddUZXRBCoNH/fl2VPAfhet5clmxx7TKvCMOuR0sPwE/Et33TF4OXg6RH0udvJqZHWz+P9g1/ybXWT2qi6CeOf0luli6j5ao6jbTpo/9/Bt4Afgw/cjrsj8s4pz9iMWpZu3gvuJo7fhA0KPZjJXrYX3C3o1EAlo85DBQ1SN3HivKSoxz2AkoUiUrh0emWDrwtf3NF1PBuYA8s/t/9QeDL/mHztHiGh8+23w7WHGNQLvAf6FUz8VHL7Fr4uM4zabrdpaIenDtWt3J3Oe2rSelp9wA3v/LGxdtBRqgkeI1EfURxTNBoplxYUaKrVQIysuplg4K7dbWNTRH8Kd/1BMtjNHV1tZZAP+FYHw1028saDACFwWuzMVXb75yqqU0UxbZ+hRekbWp2UyW8LkUteOznfIbVEKnYIaC/3U3cI6h/5vuvoVq2R0JqEVLAMbE8CEtxMoUvifCfQO4C/h/jMJ3+r6Yd7ITPdDixUZ/SAX+ALzHMtEZw7C4o2tMp1FI4axkLME4NCJuz5410uIrW4dbdWzG31CGVWdeyDdP71ocXqyoQG7DIK68tYhqHC0ViFX0+QFRLtRpVPLFToHZJY6xZtaxTa3HbG5xNZ3IXZW3tt66LqRzco+kt/M5Tbnr06lOp2i+WJC5dPJVrGea3pNj135Suuu65otLD+S/37Oez9/VXxwukRYEBW6Sli//MJyehH2wfrer8QOqqVdWGyXVD3I2obgNaTw+rNCcKy9LD3u+PvZwpMLuz58ENIVvV7y4T1DU+1gQYGXj88/xT4+4JmfP08UNTR0in/qtK48otbqCQkrmeyz7MofpeneLtEPTD5DhThBqeJ/uNcdT56HDfKijpWA+SpGlbsIcayGG3X1tbVphUWcjad98SlMK1pDPTKx9xIa5Y0jTZMTf/ImjBw+3DQ+/ie8sE1R+eeedQqM1StXKu/a6i99p4i+aQfE6Uc8K5MRiH7bn/o/hFmkbGOlJfdMgVNf5F/ZeXlnMBqMEip7wEu0uDoYBUYH5TPLzO9u2r9/777mkeH3yN96Comeb8lFYJHUzxN6RSKh18+VzjdwuodH5iXV3P/y1TxJtr7omYdY6HlW9F4Tb26d2L+//VZW/nH1D8DZdFoL+KA+6OGAB93y8UOx8cd2XOn/Zz84H9Gfd+vQjTlLc+a0VStWUPhk/vSKJ6bd/bwla5eu5XMjFt4PNt3TK8FvucQwO2xH/khL+9Nut8NRSUJwkHORVoCzx0VdH7Gn/RH1wa0ILk8H74MhC/dnWmAiCUHU+5fLX2sQHCCB76X9+UeaPcnrMIiaP8PDuxZ8DueKqbHnILg5mEf7rcEMeI9zDx5WO9U4+JHz0Ts97ZxOlzhL0v92/jsdcAaKIZGyk1wcN2Ecv9u5Gx/WDGSRnf3a8s0W2pbeLVcTCwaothSH4m1c8tO06SisJHdCeOhfmYOIaVAUGSBCKEAavGschVt5jmVkHSUNe0yucmuiKvHt0nwWXJDtiP0qFpb8B1IxP3s/x6z+jv7YzmVR8WbG+BKukW/ZO+zzI8OmlSwVLjmgGEGVurEEumf/NMQ+NJ32/zTyevslj3FpT/4b3CnFIvbDJPYuO2n1jN7v5hLvYGyc6yjCsg/YJ0c2mgBZKlxyUDGCKnVjFLpn/zAk91A74THhbZUfgzvF6MTewT15mMAz+uUwFz7A6K2BRopln7L3jyw3QbJUuORJxQiq1I1+6J7NXjsIyc9CizXAEGQFBhdrIWhUa20r5BdGNelYfUpBFgapIQsftHFmQIiyuG6RmOuxPUJhBatHLOK632AwXgAHv332NHbB7on4MzNXloXeefgX+PTOxRecBjxpKbj/48/WX9huTciq7Sds5Rnm+kMH//K91m3MG66oMTTcYWc5l7cUGOTNhcJM198i+xSwlD6yQL/tp3b74Y//oZtmXEsYdA8wT/T0MTxPteprzbNP5z88mfbLowfqPTNXhkQJu04e+Pb5wO8H5UrWP1bOy6deT8Ia+RjC7wW/p3KW/s7CqOjr2lMpceVS7URWYafe0Ov3ZhdSk7ieVbL3YqKb8+GeY3uyU6hAr9IPXT4SjInHJ4ig/pck8LX1T78CkSsB1wI+Nk5nT73njR9BaCCqqbTOtfhdcYMrEmYRxfCNrA8XfPyTKmj8EDu4LfKzEbSANElVPRXwulmgrT/e0oHs3oVfhdFCUMhiMvQkwTqyzH6Io5QjR95zmQeSWCqGuB/1DJVy+iMuVdoRSUWQyIIfVDWdSUJva9s5upoWlCkmAWaWTaLuRi7iHlGRIl7BD0RGZ9HEUxnzLOdkIq3RCsuUl4Blkair3JorbvxqJbJCWqcR3+HVF42O294oZpJW52GqXqmteQbb2Yay4nWOjzLXSnebWV6iIpV4hYVfzahwsqqfpzhNiR5znogyAoSVfmP+thqZugr+8s6j9appbDreOZQFfcrXVBfTlk+a2FnMqVz82CrM7RiF53BaFbPoQ/UdyZITTPbupFV26U4ba4qKCrSwslwEsIqR6TLJfOLBXsMSSORkjVHh09LBelLKiihnyRBPjjWLm7CKB85OygS8TAdnSr7ZsdondGfPvAnE71SWbtxYqrRDe+XhSBiOPKzcoRj8xSd8AZzv31y61ycHGyO/4T7mpn8HSIfpMYMFJ7h/gwu5X18uDFz+M6Hcu+6qeRC8g6TUP/DiPCx4T4GO0rWqex4a8Aq2aAZD2xZYF9ZhA4a4Bt2NuOwcniz4eaFpSggfhMEoegwSHkpb1xZKVgy4DSO6q2AvI0hDeqHBwUCy8E8mX4MuoS3bE4ilIXeBOhgQQsA6/1Gme7HR8c2i72iaBRTbzDAmogKerLIuAu2bQBSnA9O+grbQkbQn9BbTqYaU2KzDSlrZHOvg0K5gBEYbKgfHEMxyiBsN7WPBBDZ6O8xbvoKFFHT5veQUJ8ulAD3p3cIFGlhFHBgzsIFPzZtSBdaOYVnUYKkqQy5Og6aiIfdnNob00IzSJRulmX8ixVeAtEIr2ZAOTeKffb8GGh30szEWXpWzGTOqwpbWFAbqOPOuxsdWSs642fGeQFZZFzF6H8VlWa8iq6yLGM1HcYgNtBL5DL95DgPU540ZyzMfMzfmTvri6GBxYLB78Kg44fvqesSjNe2O/PdjC+NBuHl5abNwECwJFAYkCvv8xv8AGMnYYUcnvJuvUbsoKNpx1xaa633Op7olBnWxUH6cUHCcISwG1AxqeZGqyH6zKmwv9i9KQX1VclL8AlEiNpjMznCT0/MXfJaSLC5kk6Wr93Xo4nUktUnM+ic28VkK9tqYcCwireyfJEKWFWdL5fgI7hqkvHrDnW98/zfhrXNlJSza/2dKp5v08An5a0fJF2VbdxbE0Lnk5HNlFz2ynNB7RZT73SUfU/4kMsZ+U8XQyBfj8fi42aneTawZkYqmIiVjoTKINFOkoPYqosyJ7SU6/H7Kjb9Lb0bkzYXLlPN9cXcTHElffMHDzzfFPHfh2qSEe9ik9QF24J0UWhUh97Oi8TS/tLZUvyqc/7s4YaFqITuVR8K9evUTEId9SWCnZPmO0MX/ZDnJGvEaRgpqXf3ezdcoDBSyVp00hLhvtsDPFlJ7OGliYfyThUkbOtlpRTQ/IffTuARv4u231DwqnP9bkJjEXsjGEYnp8QWi7yKRmT9ucwVLksEODi9ngzIQvzbNyNphjBo5/RDe/sRWSq1KPYxLO5KaeiQNdziTuiX9XAbuQnr6BVzGuczi51X3h/X3SSXP6/T3h/OwMQsOL/jI6DQu+Ih01ullTD9/9O4Y1SoxCQSAqKwIRnDOuwUvLwHsr5BKPyHQJz3JpZXQqs6/vrQ6vhTh5aFUehUMZiUWSrYGgYVWAqru5XVATTxcoMgYH62C9DmnVQMcNKmFELQWw2DOy8sAlkJJjZcXgb0XASZlDxcREG2FgDgWcEnWAQTw6VHYmi3UxdIr0s2F8116zQx6eQjKs94JBhc0ss9IEroctyBg6CCzgQhKDAHaOmCAXvcz50QDJoIzEFkrP0SR1jYiNQADE51AqaQs++4CKUQBIIGqnD5OYUthZgm6qc/r+ft48fM8wBJgMnkmz+QBL2tkiALxV6Ef5/4zaBBB/fIpKCse/NBLj0Xpdr80+iCQVTKGKsWah7Z974RVyw/HIzi+AoqC0sQ80LFFDB7Zs2LMGDPGjDFjlmPMmKUYxkt5cPgBGJR60zoRkgs/nCx0B+6dadLJ84pU/HGzdIQzZY6z4Aw3nCuA2uADCkUrwAbrX3nhgMzXjmEhAoeB4DgPisaCwcjXDsCXeqgJ2t2U5iIxu1PWbA4WEgA2lsHtWi4zy8wy2dm1Mk1lxqAXdmbNjIUm7XfG696zy0ZlrGVBFhvy/DbL4JAYOaoOwWBwRf36HLN+VE/Eppj1o3oGa1o6wVggAJ5HwbCHQyxnoFn5mZl0PD8zGNcXQOpfqKK+wMmBCzL66s3A1ukatO2QnhqaXzdgyXWsw0rDRTPM15Slk/KPb3K+iYuUATBKsQEjt+GZe7B4zUs/BCAtPL8snYfzw4lCmfeUsShCSep0Hb7/EPOF6h3n908o718IfB/nr+1V1AAP0o+q4rub0R9+ScyVpNBr1Q9aTFVHmAjg9wM8T3QxIYJKBIQC+k/Gk82OEEKXA+1XUqX9laruxAeXRbaKp1EQbQApQhECqEBg+8vasxIoEU2NZ+jWRAJABEBcYY4z40NKQgR1CYg66CTwxA3AQjklxmphQCGhyRCoeCgOmLNR5K4U0xWZJJCJAM7w3JgJtip2C205kVbYRxiYPP5KqfxsbvAgenEYq3ntt9yNPvmJGRNCGCfQWO/VDN8N/NFDK9qUfwNinJ2KopwowVQ4IfOwSoWZXKmiXgRVFyg4D0Ar4JHoXqG+jCmrShQMohEAArOAlJnFjQAorbCZ66flhAiyCIgq6Ah4MPNBeN5o2N6q0gGGx+6Atk+0zyP5MCI8GNHGhTJW04N5RDJcWVZArUoVGsoBe7MKEwvwgAx0gYgsILIBYSgaB4h0ASYnFJnrAi5VgKgL0gRAMedjPB8g9GhtimpB/Av5D0E4CtrjrZLeVRhHA3lKURFU+IFQ1fFhylvF887OW3XuoeYh9gr1CtEYAKHh0X8qmQ+7okJ4AdAIraB5RDACEDoB8JdCnRq4xWHaTYGZOJCIqgK7AfoQJXglmdUmAogPMEdokURQF6CTJg/5SAgDrlKxbxqVFFP7mVuF5s0jGQHSWFXx2+n78FOCV5JZbSKAvw+wrtAiiSAToP8xeJsREOZD8EmV8NVSc7H5MjNOinRsEpPR6hhdLo4xuI+kzpvO4gngd91x5NZwgk3Hm8CroQhX+YVOn9efkaAUeLJ+RViJjFIpZiNBkcryoO2y/cPTi2QmvLZEDyi44up8did2hvLoOqDzp9KpJbOXJfMKf5zR8ZoLOqxrH4QfRqXq3pNu7QhGHsJ65McMNCa688clgoLBIUOnAHtOh+vNXO5iPgWdiNm6vnV1Lv0xTKEQ7NfqQHK3i5TbEwqld/irLP4CbKYHfuFtGwP+LLfR9zJaT4VuKZTTrmN0vtZQpb+ur18eWwpVF/VrSfH4ayhKaX+od5RZkQL6HEZyHBz+9HT4U9GKqm+r71yTpqK/Gj9405zwxNjFGWwXIvA8129Ny1aqb9Cj2QcLptToLb3iGuC8LYVeHlOBg7fGJH93C2+dqi1ZwQpEFSd/cES/8/ELh+k6myr0ZZ7jIGlFcP4Ecv2T8f4pmKfPnwH6Z1Gdw8i7Po81UfJ1kFxzOAEn4RSchjNwVp1T19fnw+tRJFaXPqFP6lP6tD6jz+pz2flLMKjeRIKlsqXG354vuRY5PkX2k1ORoSAv7tvOOz5N4snpKKxbIOsAYWiTrKJ6CQ1+H59n7eKfscJBNkvmeb0c67NOweg7mQphEAZhEAZhEAZhEP61YWCAb+VfAI5JeTyjbiIxvNuRKb5Oq6gMlqYqePnuY4C7lrIjGHyeO+XDzOA2L6NJeSqjrN/h/ffKpjCJ+Ix6k/+oW99yH3clNqAPiOJpKHwVblD6pZ4xVz3Bu4Lfj/R9t1dbUR4OAx/fD4/pfR2/4bJ6c/UX52V8/Mml1crqmcFnxUHlh6itTjzGMVnkUyJmQnQoOB1eNq5v/RwDwjTVDW7a+9m44dTnUAk8MwHr8cDM9an5+dpwm6YLHSTo6TCoQvhSWTV3Jcr3N97kZeQBF37DJQTI8nfGBhYCC34WAygJSoZSoNQ9WXTxxXLIIDWiPxzvNTa0LNZJGvMKpOLpV1PZ3M/eYvsPN278fvxtyJZ+/6nrfCOVONlLHxwYdRs+0pySiiUzd/FVzLxq/UltIqDjynFky+ZdFZYRznKvSX8NMGsiRh5LJQCw71VPP+lKB9KXLcYAFBcAQQa/7GLYbfEvpDGGHUWsy0b/VqDngBEPx+kUFiP1/pb8/UM/wVubmYfdhUgeuxLSIpTA4c+MimjsKpmyM3+lJk943Tzhqjhcy3zcXeU+Zdhobn6ywIdXEYqByH89WMIjdZiN94RDVW1rEcZgtfuNLLNNTQTThyorNyWutDLVedzJEuXGvrMaYyyqsQw0V5mtRcj5zAoJzRelbSPtOGJtjjFbydccWUfofBGVFDy9ZiSJMLPHjCN8VcBRHKR636Mn5D8386I2Mz+tph4QEwgdYcUBUVmPPMQ9fbSqqI4Aqqq30GYNcsj3vLYtOXhUpY3ZRQVFj/BITCSbrcyMcc1jYOWhQhSbQCC4JRVZWU8V6kYvOOyjr6yyAwpsMOtIdQbYmbnB0YIWxF6PGrPSJwLsxpyVcCaEDWCrIRUeZRW2zDY1eTHhVkIXq6VerU13WUCF753dxjSMKJMZ4ewHWrW0bBczKau9wEdXQHHdKBXWdh4CVa9+BI5F5B4RSVZXLvjF1nr6NVnuTszt0ROAJGqznEmNugVGwQzIk3tIcUfLT1MX3h3mteD33EFTaWWRylXecJ4wvwfZraaqHKfqNVhaJ0b0KAJMy7VH3aFsiusJ39W57tn6W7QgdmHkaqMX4N7HLwiCV90NW6GVOdGgCdylez8LM/DTX1itLdRrDm3VcV50doUCh89Xy42JFlb+4Cav9jpC5/HMMCoYOxI/tWxghR2LtfWRlwi1bmpS7k6M6pEEmJHnbbqXSXE99M8dq230TQw8ksgVoEFdyL5NSfLOWXQzhZa55Yivdz8CVrIRSg0o72p7bZ7DqoLant/MPkjcU9gGVKdiipF5Mn6K8qotRLHZ5hHcEicr/VSX3h369wKxvLyi5SlhoO2MPs1GegAX7qW6t+Dnxx2swcwgYeCvdwpUdENnhGbBnd0rb4mWD+CKCTwxkZUh/aaqUdlTMQ6ES2crdhStkrZtBOICiqsU0PIBrBR4JJIjJjLwxDwcOaUQHEVoh0UgLiDQVVbauLt0VRessVpZK3BEK7BceQrQ2tw2knCrRu72PqQChHmAblVUV1EJIz6z6N2Zo1krJHOXM12ZRsoIJR0z40xBuqOsTK+S5MDRQBsfKUu1dJB2ftphhb0TKn1188DuK3UAG1daY74b7AFFq0D0/aFdim8RWktBvOOWu8lLIrmIqJfiYgUJoQntBJjhq3nLnZJb5OkrjF49cqenDBg8pVVZrqouZyPFne3iieK2OqsurX210FXBV5PUmAnJpV7NhVmLzhTP0JO+33ip5tdT+5hbVYYYzWsrTQDyRaU0AuiM55EI51EyaNEG6sE3hQO8yGpzv5TTK2WveT+iSa7IF3fSSJ4BjwjnUTJocQf14JvCAV7kRrN4XWaFRxUK0t8Fxn2NNGdW036AW0kb6Al9DqafkTYSs4qfXhm7uEsGNMVB9kUsGskz4JEIl1AyaNE86sELwgFeoxlqvsjiNyheAMAjKJKsBVPUgY2qcwF67KfVLOJLzu/jfS50ui3u4FsrRNONNPrOGZ8oEn+/NxNGpWLUgqRU9L3Yd2ESuRm+35cOP1hSs2Wb0oO5msMdfGb8n0UAfliWfkqItEKRzNiiX1rFKn5cecMh/a/LZZdUHDS281EtjTixjvKtG8Zk+yaxpqlUPUFdXX/v99a7f+vkxPfGOmqapI6vE+DHc86NzOfXTEjnNgBFvLd7nFs6cRX+p7y3lzXOik7tUpf2fns0/fs4Ea13mSbR7l3NonpHfIXZ1ZjKPV//NaIxAClYh0ktsLgaUDxHVgqHwcZZ727//zj+cZ0iMETXFcLxg1oUecKxI5j9/RflA9yKjDye8O73t0/hH9/xCgnnItod/+mj3xJefaJs8QHf4xQCVmQdF8lL6paLxKoJqGN/izD1WKUp4iQfGw9mRxZVYmIhTlWKghVlx9G5PJ9ucyHEedXESoUrFsVKGeNKoXTYVD7kAO+rLJIoFOCHEYZPzEePlO9xCGFhii3jFn5NjBtgYQObacBFPJw0oqmPeHpgovWniBjQfQTLG1SicH8UcLLvbc2Y0KP5ne0Tmof7ztoQw33kzMkHQZUoeO4PnJpdQ4P6JPvd3+L2vWawwcC+BSTBRzh0KsxoXaPw0E5lZeWTtpMfiu8J5+U2Cth6RucF8g4p19kgwp6WbYidoMHEzjchIZp61AAEdZY8mRkizmKHo2lUxAUl68QUuEu3hTPSLdQBG6jNt+skHRsOs1WKtgPgoI7lxcwH2/xKim79+TMIS6a0ZRGeouPdoZNPGLh3yaXogid5PgVyeLzkrKbrKQoPcy+JRewNjUHNeEJnZ+go31l3yBAKlFUvciq5C1LDGoMEs3fr9ouIdiqKygXqhCx6B+ZR7603tZJV2UkepT6gb10I5myCG71rjOH4epbZSQR1IszUgnLq304zM36cIiHFDevmVYC5qE5Wz0LVwLv+vvVc88oV5bIjVjeDgdgYTYM+ex341wcy7sc74IHPR7bWZC6Q9HnoM74aJZ3IIt/BzFyyrT5d63CFN79/slrUBRha89zyZ/5BuHkKMZ5LvxcxypPvM7/a0pzNWRErnKBjW2A/7BectJ4kwooJbcZXxnhFcOe9StQ7PudloBi283EzimNEc52BCMkyujMxphj45qeXoOkz3s5NEyRzTYGLYYwI254aEu/tOSQ0ASkKmNB39xx04qbxbsetZbRs0w+Xqh2TYOHxEP02+bXVVxLnQ+CsuoMVSeRzTsCI5NHx1KETdO7fuzdllLN7OErhjc1wktHV1Vj7/BFzRcZvm4lx6LYn8QUfF7FJjOCMAvk/Hlk+B+7RXTdXPSQo49q6NZvUcM63ecHVmNk8O7/7vU2/XpQyPegdA1moy2MCl4/hsriS/LjlcAAmGjeXy+Bj8OwMa7+/Ibgh24AI6o8EkG55zd1iaE99DFDn/xgReNno4XH13KR/jYAgBrSbGOgxLqHKkpX2Iwdu0Kn4HVt2rdzV1gUmXDaRqy8a1Cli5QCdP5JsEnArRVrHcnUWFm0PDobzMSio4oTLc2rGAoGITlzWxv41IoawaPc8LrK0n+daOD6m74FajxgP2hauTVHRaz5jiqbKMXymYLkDKFFW3WEN1Ws/AlOhAKDV+LtVPgtOgBlTt2xlJgFOYJ+EHL6kByVwQwfCH8Zo2JRwjGnmc3TNO2N+REhZ/qJg+q4ONypWQnntIA7d7vnnn/hDetEkQrWx70HtE+2C2IZsW5sIA8tvZeP6cI10iNr0e5hZCgQbMKJqw01WkiqRA6FNmYYKSUnhUPwwZKdGB75aX4DW0cfaKIdrfV2sZV6KBLoIvryasWzFsapEfuSOQuaQhwcXMBkRnDcWGQU6HKD/LIfR70opXNW+WsMQw/ENiEdLF6Vz3zsvKFiJyHiRUISayqK1ikk10ZaXKC5CDJhYhipvm4IbnbSMU/+jkGSEP2v7y0Ux4+PHPab5jpAw2TmCbBNCWCrglaRC3cj9nqkgaoP1w97IMsPGVcPKS4oFqTHmxPSvwOMvjS44zDfUT06FRKTM7mNmL/WvsTAHnu3Vh4JfN2LgVbxF74HaiiQ/EsSJjUZDZWZ6/vJjVS6z+/zTj0YTDljyUPbOqcnrxBXOVUOxqhkt+xgx5mRWL6HW6MNdUnt5tMOn7enHNPadUXkaR4KB3yrepc+OFq4LOj0Iz5qWGzfY7g+BimakVxBCmYHgW7grn/uY4bPRY3MejFjBC6+GN8uHtIKTwcIzlvYDdMEhLOzLt3tqrCAHfZuMcEomBpTP4YHnL7NagHNyC1NwHgR/bJUXW9M6otWgVHrF364HSAkbK+0jTcsMVbSU4x9T6NK+BFY+bGcppsQNi9Y+E0xetgfC0TSXcaIKKuDKY9R6Z+6m05i9wm8Sl9ceBnfS0ygMGLXyb7rh2fLsvI9ndninKYdqcM1mMB8aiz4IZT0xeeBrpx/5OUPHgYHr7tItrdw4SdQ/ko7FT1HBVrP4H4/PtO0dYj0MD7nV4vxlHjrhczmI5YpYSTk1axHGdXm6N0jpRDFsFsyYPfqcKVLDpAaY8bpvkrJYfFQJyGTUNkgwJus52TcT9x/cOVKcM1YiQ4scd3TidM/RnOgEXYp6Ji6E8OrDNqGJ6VO/QpqEwh8lufGAVs8D7tG2ZclqdtsY8h+yMpeUuzMKjMV6Pm0Heg8WOi/E2oR5mxOddDfJVfSgU1Juu4Fuv9GrfbIz9F2jL+ZS+ihF5zY+pXcLurRt5hFENaquVEv2ohoan/lPdlVMO6ZLf5M3tojyIN26071S4lX4Vw1Vvy5CD6sfmQUI31wXIcBgfCk74U9rYw56v2Kn1q+cEN2vJhq4sOOmb/b4jEOMDs/aZieOZm+tuY+1LD+XENA+aFqY02vZowjBdMKl5A9RuBSYOeWODqJSRs2WMRpcn0424Y4kFQhj7UTXMMKWtZttWZzpKagRYD1rwx9lgJ2Gb6UwHK8w4aypq3DU6b1mdvl+nxvIkC1koxdht6Wy2jfG8bS7fZJC6qNtTMo7HmUraR8Hnm2SOb0NFsk058K8WBfkPOxlTtVBN9yfj+hJaYfP9qaPtq5GOaYxp8TvTQ48otdvfcyiisGhup26fJXnn+s8Tl2A7wG0qmxzADlpoUgW1nSYyN1Uwpg+bGH89pNmE6a4Wvo6SROJwW0/znKAiS6jqEYdSHsGqdPNAQR2yrDOIyse2W1AXH2VffpYunNqWEp6ZXKUcMncYHvNARQ9nAwWwaDED8KAe49yqUg9N+s/pO1F5oZ5eOYpGSa3PrFJWdzwJaFZslVnmKHBnAkoR/QfUpaJLM6sK6OR3mCAMMSjst3stj5mMJuwzmH4sFmwous9tFLLTS1W7osYxjQ355w45x9UQdsoF+SOROYWvRWseeqJHzv2Zs6BdwNgjPFQKNjadh/V9RGlUCCCW+SQDnaGma8U93iX1hlmiI7H1M5GaqhEnTzWzVG/na8fWrDb8h5mngoPPUeJ07JnxeLAk29cP/EsxSfPvWZ4rIgUrMtsWUEQvdnr5dGpLK/4q5KnASuABiOrOFFtMgU+J2dS6LE0zYJeqFb4QXIQ1eGrvtpv6naL2i1rw4Sn+my3rPXnusstpqtD6oApgV+OuX+T5qSU1nuGenMqCSK2H3IKN2ObxogOJ5Oh/FRbdLrlp68X2dc7v7izx2KisjTh27AsewHcEwQ3DkFpbTMBVkNZaofJIqvDIDRQeUAPq9VvefE6qlGAFnqlurWnW3dqpHTCZEwlkzTQgqyOYtihol/rcF3JqRPdled5Y1tz+l4DDsrYupIES8Q8cm0ocewSBcPY86Q/5CdgS/etWRQn1acPCQ/Flrge3TvBNcd0yre+8si8ileAGqh8IYd1PuutHfORp1GwAvPaapMb3qZhrJA79dxpOfVFPzYRoQ18UIinBUwTWphN4mh0CxKt6ZA4LZuWNuJ/SY0/MED7ZMLK7u8nMykHBpNGKMe9WqZLxpM4B3dEoKk2ppYTP1cQBl2dUtNtCG5AfzEZOl8riERs8DkPlpkw4Q+QENZgIDw3tQd2BhgyBDkzpXbobyCrcz/Y6yKAV9Qnl1ly5VlmD9tH/BfJYO4w+pqyR6xwFxEt/dONJ3Bw7Us/ug8iN5dWHks2zogQpdo7asmeMjb71IWVnXO0x66/L0/e7WibPzkj8/vQ4ZF8uypEawKIIQrIS05+tBrWyuY58syDSDn6XOIVKvpAy+DjgpAjTbBcIsNNtZOfmLRPusSqr+lm7BX65WtW1uUumsPg9VlR2ojOZASxmakMFxmkWAeDKXseiP7GULqD8cWi4FMEG8kJpFMVhLp7mAYyqWyKZJ2iP9DWMHH2a4Xacb6AwjTA1IAFfDXoPXMkrMyJuXeSE5HQC8EmgIhJhvD2MLRA6ojVx6U4L4qBuiryNIkjq4/+ACCArU2USEEw0w+RsVay9DLe19QfJkZTvwex6zUN/NoN2EEEJ2TcDUn1zhYAC70xVoIuMuxYX71mUmWkumaUDJmlVnIKYFJQ21rkBvHiSZc+pro3r504u5qc1mx6qKaMl1ab3XvKZGftY5yGawxklYEExrf1l55MsIYwodQkJ6eh2plX94BpeVfHtJ7yGFQkw1MFvMn0gYQn1Sfz3cCYjhRMfW/e80xo7SkbsYYgrSBW0NgUhZd8iHgN+NLbYBupwnBQQdKVdBLXqgrg0KwKCb69fjrglD42Q7nnJJ+3DiA3nnUmFjhxhiZSOVmA72CWx6E1QN8YyaRL5YxfA/CtPO5IMp/Aw0/2dagYtWUXw+dVan6KyLkXpNF8GvBwaHctwdhYzZf3wMEnnUiRkxpfEtl3BPvhW20KQha7fSLXcTYdt00zGhKc7lTg4gCPDw494t8f1lsZgyboSD/QOkv4PMAYdpcUOuX0Ryy2N1gm36D5ZBUkwt45imtDzEz9TznCqObaTvlAS3wKqZNcebQ3ZdsoS0rO2LbHEeyYVwhr8T21wkqb2k+Zp4z7fEJHuBb6XK6Mim4+2WZ2kk+lW8SJiTZxVW9AvsOgR206To4WIGGVm4ubp9Rs1vaAKNwj+UYSygizKuyAv3cyS+5wDzQmHEbWLIbTttODur0ih3e4/QXJqcQspWn0319vcq+k/WF2IOV76EvoRBAdBiVH6bCGdDitwyGzhAj1nAJXRouIAVOnxGfHdCzEugSGg8NnXxX+6CM5vwCJbvCeW5hmH2th8oDoL1LA0uHQDKEKPr5yZuXI56CZonpj0w1b95dO1PuvjmbOnJw4CDlxx5QghSUJxIQUzXDtixupn+Y9OkMSw/3e2nm268S7C1VlYz6GghLvcTw6+H6bffRrTQTDpMtyH7nT7PkvSCK0Bcio/uPxEQ6efBxF7np1RNs9qXY2tPiA4SD7oT5l8C6seuV7inIrUPd0xtoebl/DlWOGL0HrLe9w5061b5OkXKNZZCanTAOWQ4wI1wLiQHKTPK42TREES77SqnJ6l1qlT9W6+kXnDBhKsKFOqgG/as6Jy1gWKSJgfJfl8pETmgpAlU4F2cW/EUgJNgh8bckPvRSRLIZgfYSDBVBLqpfN10Ty1AVkdqZV+pS3vHuIIdpXFFwfRBoPEXPXhIHBHkiWNYch6GPlpSDVCI6saC+EZN5EcIC95M0yORbPEhLK63OtspenIpXZPktI4ZUo7zNVQpGVQ24+XxL1fQ4XcJP3y4iqGTaRDj1cQeLuqhxi4r8wqMjt8KzKu6ILhddwRE9md3bxpGVkEj609RQQC2DO2zP5uzow24gHZDpAv2BBChIic+3BVxQXOYapD+OedqQ+RgpsawG3C/YHDr7XEY7/0KEwpU2JM5vErgdu0YcO0o7ENzWo4KnAj0RfpT2BaozhYbaXBGfeV4sb3qevjHd6Jv6lBoLRrl9UAQIZ7L6O1D+qgxt9tVuEhJCp8aTJ32AqVo47DieYardJIiMT9cXmUwAWxOynZ/IFdRCsYFszOeRj+FUtJ6SakL4Z4aYDe2WzKeetSWe6lMg9ZOtPRjuUttyEojY4DwaZ2h6FQdLjUgjnj40SxDWHuQzT+rLzfR6JnyKDvjLxFh1M06CZ/ogs8/S/Mjt2CExDMPDEm6qCzfxNrQg2nnWyaE4zt9m94rIYiJFZ/L4z+efogFObbCTgQScf4qHC+GAfUjix9iNp5EPR+l4YbGy/Swh4jDJrDWtFYUOHwlTi7jcMnp1xGZbMCia/76Pw4fUP+soifsJUYk4emRgjXyg8wtqnPYEqDKOOt6jn/KHmuLlujlCGzbscLhISIjcD2HAYtNjsc3vW5xPyNCxacNDPO4fBSCBDiat+GaoGpGXqK5GCxfPdPgO7yxAP0UpD0rW6atlwS332r7MFZ5PU+lACLkHWoBQmhrN0YIOuigrzeoRn2Dy0tUcHjs8tPtcZdwtGHmXOOAKKCMJ4B7D1SoCGOYdMwtnFC3yreBmGrxNOOf0oIgofWeNxUVgoSlXLN2vbHRcJUdfHH8Lxy+lPoEo9nQOZ9dFW28ijOpr8jJEKCr2cYB7Ygb2dUJp3xQUJMM7spJ58YH1tPCGHPX5eyBUburRTX4Q8HNPLZ4unkO72RiTWN5bAbUq3/TXlZY5dQvHDbaZHZprEz8NN070z7DWYKue8Kmo6oiqiCFMfynGdwII0S3o6RGSP1N6y6/U5d2c5VT8np1FYZbGYGDPZz5mLplH8xI8RmeQ2w2pPB4+PsrBhMFWwxyHVa9vnm3sKdlycs77pT6DC3fQwPVDGZcAlG/ikKLacV0dLQXCOsPlgeA59yKG1AWMoJezmZMp7ez3Jti2JwYdM0ej+Bw1A2IJbphtmA1uUFEV33hdEDG1m+pWVf/y8lua9PBD7EiWicbMf7EygHTz8YToWdo4UwUJ5H/AwNE5UptsHX53sNl+dQlIADn7YAGrJnoZy4FIf16sKgbm/7+Z0oIPIXiqMLic/N9N9mNC3Y8YzCAhR/CSO2OjsxE54FOIBjGGzu7ipeX69C10dIgLOwRZWCVi+XWtDUt9a2gw1WqV8uAqE0xsgoT+FDcvP1FeeskAxVnRwZk6UN1sooX9bnzyW6jPayn9jj14vWOFIwXhcmFSkREe5/AF9OyyPYFC0sexhNfYwcK5a363XiPqiO5MMOL5hLhIcqnL4qFtintYDG01RULNVDsyz9WwSkgXVRVRUuVromR0TqHN5OgZYrulcb2U6lH5wtx0ciKEd5sCBBRt0UF+TgTErHvDtuhjKIRRk7xlTejbbXQvmRZUYoSomfxfqYlzBy74C17yuTWKUDjkW+E7vaZxWzcrkLJGfQA1ACBkqqvPe65tdntnh093u2l+1zNq89Qcm9NjMP91K9kEr2bIKprCaMdFq8u3fcQTdn70i4D209Bn6GjwP3cwfK56NFmqRnXNqYR5bJ2Sha4B5NXdCLD+OPg4Jl8/qRdJp3to0vSyVl42aSrhOpBHP6/AWLfDQgMl8iEbwDGh508PMenjC+FPtmsjNxwV9vAfJvMzbtayK7KyVydcxWeI8WwiskVTKke63qMVrx0FRLv2qlr70Bk/vxfHR9TyNQ2dUVeYp+Q7fk9UGH8Z5g1LcI7rmYfKwcNsqpigi5zZrgV7sifZbJld+Esu1REH1BlRiPCLiJi0PLG5dmvHhVt9qubvi5mSCCUy66syc6LduU3t/9GmYlFMfieqhF+/DrfOkz/eH+3jfOdePX9dDr7XVomcnGzCgE2nbwclASZ71oaXTXPMGjnnHOI1MEPqFtbkZ+fJ8353/AU9PLn+ufw4f3bk/5ylpoa3oc1FK735ysg9bZgWJvyYpQh7gRxVZFCDdA9GiiIT6Wri/6dGJzMFnKVl96x1vYk2yix/4kKV66XmQU80mtKCgTudN8ag42vU/wDS2dVVE5/isnmeM0qVoU0S9b+FxIb/9/xBCuK+F+5v+USJzcG/sGG2DLcPjtxX3xA5PZkmd1oLN24dwn+7LKb6LXRPnRUHxFb5dGEfmVFCFYYz+ccA299ruBlfbDBnmzFZ/ZnICOLv4ylAvfsayK7/6dhtbGRL0YgtZuL/pJQl2QPoBxVzVfnshLwJSD43H0T7SzRZk/GLBDE9QmrbMrYlIwNcspZJUpmhRsX5ipuGcazFvPMNba5pRsWkXcF67/IRWwVO+H2nhmXbR6ok0pPIefVGRjQ0oQkHxkU7/Cc7lF8zaP4neoyzcmv2UttkxWzF7R5sDN0zp+SwHuCrTmGw8cLmWfkGeKNuEtKy378WipfSf4NxHRd5xuWzLKB6E2g9eQiUveAbeWxX3ch/vr6tJT0UWyVjuGstpeIvSg9ofb8klaV4sCjqChTi/STO6ETyfWFWcsAiu3+L7JM/ZUpw9L+dl7ba0TY2hudtrCBR4TR4YbM/JWHBurCHCBQQbxU3JJY5a2QRpcH6O5gMYdphkFPdEsgUxrbHpQhXQo2RgQ61K2KUs7dlS02IcddjqFLLzj4Z1SlVigUTiK36YLdZdqGz25hJ6DnWmjnLHUgD8eAp+ydwaVWOoMdIwyj+iq6ver2JwmXcYDJEL1xYHV9WKyZ3n76zJzKaa07VGCUZJlpW36ePu2I/oOCObTGDHWk6LgZqoZlnWOWE6apFTPj96mw/6B+r4o2HLaz21BbTtyaxUC1/gTIsXv65/dbIePQdJpvePVw/Xt/X/JH63HIUliqYrg4WoxM28011ECydi3+FtsvkO0kKJEg6zfuZCs2frt+GtP8pFplsKgZWqXgXWRDe6BQN7mB9j0zPwDIcn4zXQhY60i2Ih1wfSm408Es2bQgGYUsIir8T3caRLavfadvf8I1yNutuCqHdTkyRXbe60cJjbnHKKv3PrKABoS5EoRIgNgwYDOZH2gl5blAjah2UQDfwOq/zSVEkf09aHv+Y3GbjkushE4MYdYumg+FFQDSW/91isqn9bLaiSNIcyz7bwWUw0WWVykoGEdHlRp/wwZqbFO5KAPXXjDyG2k6UFulx0R329ijnMr0VEOBJcEzuxQ9MAUawFSR9RYbxZrsnxcp5byEuVKgsrO1TTfu3b1cTY0RwHQMcYBLRzc2oWt1svrevI0CxALCrkT/44yS6FuULy5XvZ9XtpUX+eSsim+Is/zm+DyS1jn/xiCsU+LTUaQSsSlwwlYcihYausvwfyQjy7in0cL4weOvk0PBwPgHZAPe5yoGxav5tJ6OKgEVqiS7gf70JR1xqWM7bM7ATStifNt6NLeBVxiCKeQIwO5cz2+pctgPtUT2gNdBlLGf/7KCwhvw9h/qdx7Pi9DUmjsZ2xjBJ0zZywU/654esYTEdNKqbNeyU9b8eqgInq7XYdHNRbL8QQzJabrS6/D8mM37vPq5cU72j2NXxodupfCBSTB6JXpCZ8M+b+fEwIGUoA6aN/IAXT8pIA6+NHWASNYfwxEU1YVD32yV+y13ChKcw+dy0hzyr/fVHid2LwnvJec6qXK7eRCoH8q6CO3snxK/4qdegNdeUOfeqfj1dBH9M0AQflJJjmGDSxJ4BcwlLYNu7+cA+GbQ3DLbrKemcA/lgGZpS4l13RJgvE8xKn4zAsSIiZjZe7hKfkph5F0EPQeQgI6Xi5VsAZLAW49v0Oui4A0O+K52P8vB3DtX4MyS1sUdwYdu5E78Azil8YLfvoGv3E93Xq4glLrPx6i91yVIDgsRpYm5drpFu5XK98JZIo08/A+/ZGP+agGJAl6aycVJJ8WNcY0tE6doHOheox90oRuKoULWHDu4klFZMtYdSU/sDfPvBnZ8ttbu9MUlfhbdBjgrRkJFdffcRtQhKuACVwEvyv5fFe6VgWR/9rDNp1Eq6Zs4Y5y0VRZBlgDRXmlC0atDWEzvbT5WvJnEllhA/Aqdg5lbHkVNOd2rrZxVJE3HA2jv1Wwple1HOLlSeT0HMOmaiDpo4yHp8PXBte9mbXH/JVot1MOVnxBlokCULQTLYRWeoAz56d59Wo2SGHc20tsI08Hp/u2LZyXsDuNs7fmZEdbWo76hHlFkbpTh4qD3PqdgISc0SwVipXcPL8bYjcTC9r4hADQ6XSg67D/eO1GgnTzMmpZQmbj4kvR2R7BB1IHVNZcpQ+yVJeJjlrs5KUdYk2N9pGK1ndJ3tYPfRMVvb0gduHtTAIiPDOYNkhmB5AGa5mEb7IjQbDrdEz6YhYMBeQkqiTNXy/yKdFDSBUms8H8+T3NohPBzLba44f8NwFXOB5cTVG6vseleHyCMagLfmWZUHoYYvzD/kbzKw1tu/ReFVzElvTOWi9IW4Ze63gCa6C/10C6zRCsJBElHnU/Q5H+AJwzKKJbC4egs38FyUA9YYgCByH1E6sZ15CgjAINXLgNZM+aLKZgMehl/goxbkyhVhgwCVaawy6fo+wkrmpmINksc6g1RVPVVFyzjtQIhd3pSd5xyKYout+Mr2jnyv+uHuIJ8QnaQ8NLLqHISxiWU03MwwPJhig//vXGFod+VlYowFpAhi4MiRH27PZecPf1+zHoS82XMcrkTU/uOYpUxhbcPaD4V51Ez3+oAHRswMEr7wMav6oeKiDBqwx6rKHwc7D1zmjykRLnXTtzRTRwxZL0cFxhbKL4HQi19BEtD5QsQl8O8afSHMskdgvwLW1e9Ek/VUbGVi3Td2AgnrS1ia4CciPGw/RsL5UQWDvPZgFKgpnsq6Y+ymE82rSEp7wKeT1ybsfbfMJtbFsF1gV8O+5JaUWq1sGyqErtmVmyl3yMFfdUldHT6p/NG4D56A3joXoM5lKpYmIvDAQIeNYousIZGyKrBc35/l0uO0hS9Ah/gGroeVvfLZ/UXYMSoYvtyP9Yhlf/JMFpT84zfqi7Dx5LRgRsskfrop8+RsG2yjLeX16qLrp8Eq6/je9ITjPJJzlIL7A0Jsuo9F4ma84FjSb8WpVOPZzgkHl/ELG3DdqQU2vFpi4XJB6lxoCTTBwGFBv5tfs2VLOoBIz/i7POqdysgwLunOTprNh30x6GBSKSdC9pBioxH3wpdgTZ56ImGBEUtQeBlDC1QZiqTPnmoXQOMnC9B6d50UmTNN7dpaFY4i93DXm2H7m3LaGnAsFOzYYeiyiEnJBULgtfizqvoyUDwlB0kbh6AHV7ykAc9uICtjvDkbWssrqa01SKVr+vldlk1WzyuXb6e1y+BBg98syJR7G/vBfDKjrC4SN5g6EXbwDDhpub1bH27qPffEbiwwaDV5bNmPbcvn1mWG7uYqGtWwvEd7h1/rerRtXLp07c+LYoQPbs++P21WY38pnyrPpcb9Ga8qNc7zyD0/asfyJXOx1u20Hw8uqsfWubmoaLb8+OjUvL8NujZp3xFrlQ90IDIGATqWQivlcJveu881Hakqo7/i0HOWfDpmI0US1MACc+fd6p7cfKQx0Y684wEvrgUfAcfmsUVzvq1Y+FVOuCipH/HeJofn+W0LZCvv8juHB2XrfIEaVo54HqdTUJyUzrER/GYgZXg4ubAHPX0JwRI22EV8geB/OkqZ3T5TCxU8nLp+8fPjQ9uxxOx2Gvmu11HDgSu+P+U/+fOVYQvC51IQs0XqcC6V4RWmPg8vEOjqkIM9lay5XOgfnjVqk1Xqn3bhKtHeT6dN3aksZJENzXm92By3bva9cRDheV1OQsfzdib059xG8RLiESxd+/fxuOgK71t6dVhyzCIWJSD3SweCyY3ts0rMFRtp5hKNa1sPt7ctn5MndkpSNODTnu336L0hUoW6vmcz/l6/GSrrlauovRmuVrMuvSuXLIf5RVP4e4T1+r+/dvH754tnTx48epJvV48aHXVkr5l2dJrbwLi80SDpXBucrjGNXccCRpy2fz59H1W+jzTcU2XziaJI3/XIlo0rSay5g45Vr37Me2/Hhwn8HNre3t8PXFF6bppGjd0RcHpNZcd6quE0R18qKGy7Rt1v2rmSVCU0jrroqh6jsYRm7Hxf46Gi6t3WW7rvLNOuWkyFl0DZ7fSWsX4YLic1M3eAg29g5mw9WzD+AVKb3eQSOHJ63nBQ5XQeJkXhtoZDbqc3/96MrcNX++VmgC7mzD4gQfbxMoH/s1s+fx52enP9e/kq050Nl54/5jH6qTlf5bvviasfR0npVT0NXdk2dzifl4MmRPG/fVr/l7zgkJZSAJurrXxN+R3dz0sL5YYqkFBpKlg7Yz63nIkVJ3cizRvBi77ldzFlNOx0PU1u7WjC2PkyXI5VJz69wpEhcekmV7IWrmmYT6Jlexx8fno/mYLomo0/1mBxqpgjxbmSpbqHQXhEisPjdgbzkPIjzswEEt8bTZKyjsVVa/XxffYcVQJ+6Bwe8OkECGCF2DbeC/xJzgClX8ia+QjIvDAFRMFGzn4S7ZGVH5WV3BlRSv2meBk11CUkFOUGWIe/YSTk2BMzCcGXzwRWaD+h1AlUzn9TIdFbscYesXmrXybEgNbfYuSxFapJSq0jhognoeqBxFeuzxZUKA68TTxeqYPROpkHvGrA3FPdDC0yrrucQ6L0m8Qsw4wJo64HRLnZHfgn+UTYdBf3z40WAp5w8bxe11L1tNyotxxEMDt0HVkpecHJZcXM5zwq4N+tzjyznyh2e5heXyk1t+dO6PBJ0MS4fpfSrqRzGG7B5FQ4/BOnFY5MPTeGExV7klcqBW0B0NgUieEstZP6ejiC9ADjoHdIMQ3RaGtrqYz4Pr2OfUwCwlU42PFjBnHMBjh14gMZcJ6X/p2ZLXjqKwOnKbHGUrYsy25iGq68PuXerA56QRnHO31CiNVDU9Q4R5zU3xCcYl3cVLbQ3E13mdnBiGjYJQ/kqWvB2EZuUR+XIE8p5vNrzMYueGB701uKyt54dZPObZOOOs6OpHfmihcr9wH+25UDihpUvX5ppNNf6Ksvp7XDRY8mY+kn89HPiJqgsiIYtnFJgInBbifi63ZzfuY583g90bmnVypjy/Eq2ba+q9+8fri0fVLR1qyiTEDsHo6Fqg9o9vmn+2ww2fA2+617TIrZ1UN9EintDRIPnXGeivMTSpfqKba2VAaWoAgOYFv8zgJ/gaSSVQK22G95BgZrr7HTC8eynxmYR8byL3Vii1KpHl5BWKKqPIwvbm0Z0fdYyOsUna4hhv645OKubqWMvy4ZJZtzdnZtxo5CDc+IbanNQu2vqA1nQW+8uUm1O6rEjwGxW0aAoLCxnz+lNrQtVSBs6U7MEDFBp9JhzX07nw4IxW2ocxi3OPF3WwXNEBJgF7LVF3wTik4+WKPyRmXrIfk2y6FSLPdZ17GxkFywgEETAZIQJJhVvmpFql9pqUecmgI6E2Io0r+Y1mx5OQQnzcFhxwR4djuuTdCvhMhhO1H08RIKDH4YY3DzDxqXtw6Fkp0z5WaXTjdvJEJHXQnm/ofjcC+6qQp/AQrXclNTEkRGjQ8EMnRqz/WHjUhCKNb29ERPE69MCqq5CqTmf9cpA26jUSjcYr5wVi3JdWIu2RyrqWP/4So8XxkCAFDKHdabdpzhNx+IjtCQbtPz0bL3GCkWyc02hh79SAPe06AK+5PUzU/Rhd2xS67usIlunO+ec6xduzuXNQFF60PvOGYsEYK3SlZHP+w0l+WbdC1H2nmphBOo/0xazHv+wQ53dRGScNcimZrnJzT2zps0GBm0bXD0eOnrPSU+tSy7fRaDENPrckN2Fvsp/jWH1KdFlZIMy0eKpyi0P+YKUMpOy5nXRhoP3bNTxUirn9zbB1xvtena4sA3INnkJj7rFxp309n7zYkbCPboz6jrn6pDJFZc249nSPWeYV24g7Ny/n3g46GInR7N4mzw4bzDTvGM0tVqx6VfWn6hzE45L0yR8Hgd7gBA16XATa7bxXoUp6VOGbVNcD9dDuCldO9GUMxC1VFayMxm8d5g+7HgSHQMr7bCLzmIqES1PbanimzbvkJR+1FjDLF2LVDmcnBIbG0isGEhPwHbE7P85uQuHzSVK2RVWUDToewriJkWSvmoIAENS+0OCudM3rJRWIh8VO03pIN/DiBCkfNhzJyYAU7Aq8Md26WLk/HyIZ+yXcW+4+qM81JFeK+7QjZprkPwDyX28IbKjx0Etub52jv0HPd55SrHNmbbP6Wg1Ref6RhZHMkAtjQnpACk9V1GPKL1niJ3trC8xwiX3p2Aiph2sBD7Q8ifERvPKpa7TUZwYvaFCHrJtcnseJ/lrrI18sZh64X6rZaTAQBdYdJJc+axLvN4zXtqrofAkYkbZeUW6iLUSLY9TJmKIuPdXoSA/m55DL7mbojOVq9EMJt9dnzgRKRHIuTJN4tDVnxQoMdniYwgVi2gezDgjDWww2xqLnmH/fHy8wKbEhNU7F1A1gKhjptIYWNzG8+/jW5WgjeftFwX37tAEd4K8VYNnjQBa0I0R94eW52kr/ZzoiGlbCpq+KEDnVeK8npuIPtm4NltL79gH3d4AJ4ujfE3pF3tmbLBgjm97r9CZPHCYa/na2EbPpuTKf9rMd0iaxNGCsck6zaHfdxYrNh4tlwUzTIl/NmeFuY6R4Gm3DZwKo+HVTsg2KUAEspR0UxO0exZqZPm/LzKJvyIVeOMa1Y/IDiUpoOxG6WHUFm3R/kBR9tNZXYiSdz3a5nuCZTEvAsvMf1UaAG7VqW4r1YRcpKLCP8NAIaDUsG1So/eDi6aEAKI0b+AMBhAggCdUn+CgYQu9XwdqIxPRPSA2VeAckLkd2JEAyG7Z9IXYGeOJwyFTAg7SLhK4DrETAG/TAywU1hkiCC6eDqtPvCg/mzh8J2YdtZ3pKX4RaTxQHp+srnxGcLZd4reRMom90DHun83+/uAM/6mLTz/lJQRGvz0BXyhqkTFHHniK7AsuYLQdpXKPwGMyotXCCzEcusZrZ6LLJ9KSkKetlzpoei5EmtQVp0hyg2H1222Ief7M/qWHTxMPZcrhF9/yauVD5aV6VehrQ6BrY4E4CQQdDepjHOI1fLp5/xInZn/nnqIlkdOmdCuEqItUt3TD39hBwG79vsCwVm9YiibclyQjdoL+PfVd74HfmYjfnVzOh+mj77SqikRsw1hQ0kZ6amxURFjo0kAB38/X3Y3nzCDDwylxhAzL8hTkoRnaw1gQJM2w9aAUj/J5LXdnKRXx8YGMDCurjJWqR1amo4MVbeFnGdi6+LalVEeopG2ILoEEVbNeQP5TZtahlvCeSm6YER1k7WX+0RP+CMQWldiOOUUS3ZbDIrw3vkcLixtlcHdDDqsHgVUTIxZkM96+4i9SfC/rueIeNILjq716LR2pNWemAJw1Bu/mTHTiXBvPUBW6aLSVyZrHIX7GAhmoqqgG9VslwLyVaPUxCkfUKKZEsdTmnJB3dnPPXCmlU0Bm2rYyY+iRVDJjcXRznaf4oSp3QALHE1KDLuZmCraMjbbWr7JEiavvWn5GVlLZdziMgSlTXXQ7U158zpXTKkk5nV8npaskQ7pbRSgIyulqxD9cmXXokEhEWQn11RUxIVZMiuVbpLQk1fTGk/g6ECQROoKmcJL2EKTMrhGOdeOkvVBdbBBS0fC45IW8s7eA3QG0soEH1+cbAiebvDkUbWUDi+902RC6AMIuQiTowpfSjLJ3QSS2nkAwv7EvwhO+C5COTp4xo0JlcAKnDi+ZMqelkVok+hukugCBKhM35Ju5mFUglGQBe9Eb+HTy3az1tiF6WnGzvHCt3sCmkAvEEImF2Jkog/qYxdVxzlXftS+RFo/eiuEXe5GuQCjp4gaaA4liVvc6yRLBL/z0lu2V9kq+WaQd0kTzZ2fDXbiqtnsNNe7EvaM+JtdRSlX/PfxE3ZW+v+h0sD9ebjsavnMi/h4xbE9wAsIikRR14zZ1mT46MAI62TWSwaPdhmNgdEy9dj7Ue8RlZn1H94LjlSC5OFqMSESBK6oycKa3W9ZISHuNTEC8w+2yW3VQgS8Uiu9qYDUwOEJqzh9+fFz4MT5qkDJY4k8XOMxV9SIwUrDbBDVwsgHWTUghCVs2SFpaUXQjrkB38eRDbFKnyuKfMHiTyZK21Da5S2ukwUBbahvrOvkoD2htqW8Y2DC8dQafSCiAdW6Mbhnsywkjrb1xYdiamsBjefUEf6hFjE41wsGtVZQfVgRKNPSVr0nvD2FsgPxHAQhP0i+V2eMh/rBeyiBwFGejTxI14khcFCjo+JCCjx8q7lfi8A3SLVXBLSNxvw4255BirgrDaqVdLroG3nw4kvTfTvdwec9Hj2gsuA8tCtUX6zsQo4+fuvFXYcda/UHkcXkpVjg6Mx39PTqo+3tuWgpm/0Uyik2adeKl0tZORipET6Y9b2HwvAyeysxXPerLM6bBmHrL6H5GQb/F90pRnYM1XswniTGK6ZR4UV0KjLABhIpAqsGDHVs/+NN3Vjtqr5VU1P2+WtJh0mDYUQvCazEyV+7dBZegznvGQZnmUFEIz83G+ik+4MH9Acti3dlDw9nTMVJDDoPp+9TFxp0wcgi77LvkEHKWFfgkofYKRFVfElli/Bp2YCDEjquEYOx+6EKiOpRfSOXQ4aUiwU8yF5FCa4AlNoOXk3uiXp02lMUOmELnvyHlrzp4Cc9d6oh1MrgsR127bA5opBpClYl4Do7iv4FidR6PPmX+lIT9T7es3+uPtS0cjxDPJ7L5mv7iaCSz78hOuCEJflvoPmJI9yVNbpxFcYK5UP0l+X0qwug2ePQmkyr4bYFN32AGGQSTMwkoI4aKE/KwAtcpdxPVkiTNOlaW3V9xl6Sap8fuSee6YQ51XfxHIZ6jbXLgFl2JFP3ENMKrdGmp8cyB2SajAQ5pvbSICZPuIZqCYxEQlR9/TDuGxEq0U4tsE19NzI4jDvj7MnSab68L5236xr307iYaDZqSfZznL5dy0tbYbHewPgIO4lcYdLFnMi3sleJ+bDJEJttGuF2O2Pq7ulT/P/go+7QorpEyRs5yBwOFRywzAvu8/C86HRVyKWRdEwdiJHU8XKdjSI0UAVe+LVNJr4Kcjy0/pHEjghcRkUx6jz8iK7aNcVsNIe/YboHaH3tpBblcx8kk8pboItLIpcv639Wt8KyWZZ7FTdLgU3tnLyDnhwoOHY3M82iS0fZItSK1p8Rtx+SbjQzD3J6RBWmgkUye/oZbYgqRnAmt5c/fEPlKsNJwj5An3W1ozuPQr5bl/v/8bbHH4HPMsEETKN9XKYpSZiEdM/vyk6wESVO7lJoxv2CJJGSHW+Qdk/cdDRXSjNfYdKwtrAccckF4pS7rKEjHT9tPp77xN/yfPE4dx3a4P4tPe2aetkELIBI5gcj1kXxuHiJAMDxWPif72eZQ6ZS2BIWVwT5niyJqrQif5w7RdAqJnHDVS9yJLx0IUvYIX9Jkbo/fZREAIuSzwytvJ52NmcX9JZvIfAQA3oU2Lzt+e0zp64S1JB9XZDpAE7PIZ4AA/iupb+HQ5OHM1SxDfP+fSq5EY3CwEzQ20BA+jL4JN8x3Ohz6SBxWH8yYe1yUALahze2XCG1whvFYR/2tQbNBK7kKm6A3yHAU7hAMnbeKNsAZxbAPZweBxaqtdUtQXzpS+4baLOCrtaGtybl1td7AWDW8j2AYM1u1Dk4Ej1G4SIQe8DgF/bKS8D3pxKGXgeEqQbSOdhtoRgBOv/BhBYM4o4QPYarzwFnGBKxHsewTuI/AXgT9l1mjn2DZErfMo5dX5fYgtdvXhgbTrlBdXLKxBlrCrwT9mlsie03Ieckcz/oHh0M4VuDEerM0ZtTL2iWZ5sHmhZu41gCGyTTEslcmA9H8I9mcjMB4lIYj4hzzws2SjfJlm8A0gT4iSxAe20lveFCrDDMjI4i0uTQzMYuZjnmb6AvWyylDrXVgu/xltFE3hpzo2OmAHVuGQh4akIM9lEqLlks5cjJ2EfRtZAXnUIkmNPKRFqEeB7j5yNxCOLGhNDMc5iT4qlQ8EuumUrYFtocSvZ2pZ7fijzypeJ+Z99uSPEksH02/SJY8knhibXwuncx6NHV/qrMyzfjGP46MbA54hoc2CLgmzRmbPVpyiPJyYFWc2KegcM1mssw2tHKhBfgHl+LtIU5wtd54m8M4PhuBOYejmEQQh8QT14dTmQ8ljx5Oxm5P9yO5+EgyhIjC2yZpqwwzi+cnoXPmWe3Zlnhx6ram9zndthf1Kdc614p4sYfpVCpQhg0KwJ4viD8vKdmf6ZprG0yqFzTW2kBHBb4kLY8QGcvMctCgz0t4TAIkLOGC+cxGg3kfdSFMYcgOpREWe2hhr429OfDk/HIIN1lxljw7ekSZQIb+48bWYy7mQJkXhFjM1NLAKI4Z9rDyBobRZroDxtZYX85sBQ22LHu+ZHAPEfsAK/p6acK29CMxmNx7AZSAsYRlY5Dl3YdhJxZ7Ke59TjtaIEJ51j3R7PlGIOwUFtPO7b58P2fHbHLcgfPr59ffrhR2SEvhW4SR4Pk1vVgYeVE2LF8naWuwtTn8JUhCJS/X/V/rmDX9+XMAGNxQjTG7Bt2oQCOGMcN9OfweuMT9ucw8GgIJd35pkYsN2I492IYqGOIkpv3aHDQF0DU2q9UcdqvAuUv6Cw2Nd7oK/yadAgTI94gzkooGm1bVdoAvPTIeCAgAAgDyE/zYc1kpfol8FexvEdc9nJvlWpgDAGplIqAl97fbhiFMjYbRXTaCrS4j6RViMkIqNAqdgiarsoMmJ3ZoJs98VuxXMMV05l+7dNbb13sQAGOlGALa0geum4Oo24Gsu5kMMBdoFFBdfqMCa/WZLNiujZSLfnozV9mWK5QjTYpUuVg4/8viCkvQgaTiKSnTyoWCWskmpBKW4iLPmXqWHCtFhgLJuHwrdsxGpEhLpsognqkEY2YwyJckZztKkpHuihcTycqsO5tmPVxYWv6J1BH4XynyZIiTYxFTNsyZsxcikCs/9jnd5RETXC36GGuNEEl1KS31kFVGrDojWZwBzDal6XYon0XbCcu/uog1E0niWbO0UBd5nSsPZrJlhTMjT6IKsO+H2OchXSpM7PrUhMxrqOIyIw27ichTYoXyIOR46xWXor9HriREuLjYVopsRdfXcvPS15e+vGeeH19KZp3p5m2yeDi4VJl8q8B537aSzHAlSLhYScRCWkhETs7t8cFS3vw8lljOuyD60C8b7Kt6wrf2yFxVsqukxMmn0loc8TKiuWBAPOElw0WATyfsLrUlZ6trj8llJWQ6iG+RkiF+Y3KuOi9PF3+Yu85mzAbOeDZt38qRraAXKF2bkeh9F7n4xWmSKaPBOfVDRXbmbBH3yqpfabNCLJ1M6Mq2fD1Limcqrqr1lVz7idGc0XveMcpJ1c7HPvrwGOmlBY5vC/ldSb4XgJ67YUQgEskgCqIiWehMDtGQPFJAihBfAvzXLKTUQglaVFpA30xSvsKWzKCUUn1iKKk0Xanpiz63We6lVY77aZdbXvkRLGRETLfCiJEqisy44ijYjq3qJGOPMRMfe2l0JpXFYBozFrPYceIaYW5RvPhEhv9uiKNbT/aJkyStXEoyfbmkSJkqdZq06dLb6ZRWFr6yZBWQISPrTN6a+gLMbw7hjVvbwvj6B7utIeLTyzq7unuiK3r7Vq7qJ2BXrVm7jgjXlynemrpx02aS5LuZ27bv2Dmw66Lde/bu2z944OChw0eOXr/khqU3isBuhUqjCWxQs1nFoBYraCrvU5tWO6lpvA5oG9g2Wvv9IF/odNwnIATzdLWDOo27u17faXqAP56BfnkM7QqMPrNIj16TV0m396vA1HrAtsDcTnMfxILyGtRny7DqNwDzGjRoBcGWmss4VGKPXYbwUbN5DGb/xcFDkF976NVXX1vG8Ru5xOeR0/CHRi3+3sjvf/zp51+O/vrb73/8+RcXN2biNwEP1P/+daH4xMlTKr7y/ZmSRhGIRqtTVL3BaDJbrDY7oKmmEmGqqabuTqTeiWpFUuSJ3bUGPTEw2mqTg6OTs4tTVb9LAIqBv1pBlfKquoamfsLpSijmDgyNwglXrEqmj51bWMIaobAd9vmjHuwrRRaHJxBJZAqVRmcwWWwOl8cXCEViiVQmVyjdAEAQGAIVhqkhTWZ3bLrEV9MeXyAUiSVSmVyhVKmpa2hqaevo6ukbGBoZm5iamVtYWoHAECgMjkCi0BgsDk8gksgUqsDp9B4/LC9cu6kqjc7QUbWK+WJzW53eYBR0lH/4Ca1CyNj/i/DPf7lCqeJBpQgxMJktVltXjZWz98de3uF0uT1EkESGYIRCpdEZTBabw+XxI/orFIklUl2ZXE/fwNDI2MTUzNxCYWllnbJZzKXtBJJ6Ourctpli/6LA4HRrZ4+SU1BSUUd3xlm8mjpQIBpKxbmWjh7AwMgEZAZ1R7tzzrvgf02aXXeDDLT+szZ9BmaHcHBycfNAVfDyqXS/y5XleEGUZEXVdMO0bMf1/CCM4iTN8qI0RX2V0p09S6EoZCQaFIX1oGbCJo5AotAYLC7Y3E6eQCSRKSFUx55oGrnGuXFFIZNkHqXcm2RXMxmSWrpdc2azYIPFpplcofxYa+oamlraOrp6+gaGRsYmpiALe+mwmLDZioV2U/7rTCBRaAwWhycQSWQKlUZnMFlsDjed8AVCkVgilckVSpVao9XpDcZpXtZtP87rft7v93fNPCdS05VhWrbjer4IJRlhoqiabpiW7bieH4RRnKTdLO/1B8PReDKdzRfFcrXebHd7KlcoVWqNVqcHDEYTaIYsVhtsRxxOl9sZ3NNXWeV/wJrauvqGxqZmfRpDqM0NdC3q7sF+mDoxODA41H8HjowCgCAwBAqDI5CoqDCIK8YrniNigCFe8JJhXo9tGCwOTyCS/vquRYNZDOQmx6sFcTq5CxCkx04iHnNfsRwPgcIBnSSHT50owY3Pt4zmH8v9L3WJIkUcz+x+cTsl3R9qPgr+/7rQ/jbvWb31hV/f74/BYJwe7CzO4btLxUEHikub8LVF75GOxy7mVd7bm3c0XP4VcDbPuAHKz6z6ZUUP3ttbjd+FnDioDvYlzb4H2FNexWZf/SnVRkJ8cbqNFeUZseLpcGUy34Mb85WRXoKxwQ1VP0WT9tUcBgoCi5eHd3NghVk7NFvMWVpH4ClYE34Q3YpmP1eqh7mu9DzB8PEKILmj9GRUraQrx9unD1gE39iBXF9ZVF4MskOKhu1LW4EftLhYLBHfcK9rlipuNLbu3fXyGwdHKF34HAnwLIBE+wA+SgEUgxU1rXjxbRHn5g74Mm9S6aCXtIoXW2GlWvJ1V3gVVeq8jt3VxnOVI6M/2tH+vTqaQ+/OE7q26k6QPMyFeqlRFjCtUnCvdUsdr5ifFbuYeqJB/GnCNOReOzJdiz2MmSXwLl1rd3axK+6filOX4bsaij0GbK0zi8nINBRId6aYdRWK4tgs9v12GdqRq5FjJjOUqwkj/kzQTK6dB1OZxc+6VyxqO6ksdeqPTsuYnyhyEwshSMBAgcMCDj5IsMEFfEoPEuSyWlJ508PRFUKQgIE+k58R7FMXoonafxM0S2fvninnDvhIv/ql/mY7DI7d38+rK663sw9D4TKMs3rAxa34eJubfYQ88UIGnYwyG/PCPhEw2ECBgwT/fGhpcIGCD+HT+KZB55uxnXjZ7fsb+XVYxgHyVC8M/Lz8ZrABgwv+0+GRgYE155xfy9foyi/78xQvD8gTu7zWF4ZtjGwgj/kiKXB6QJBrr9133qFLAwPHHlzCjz3/ViDg1uOW4RtSu6/cZb0EeMGSOm0QUN9HoOFfwvVZ1jyldtpHQMWXsQwDBgwYMGCFAQMGDFhgYBkGDCxhGUcodCwXooC3sblsZMS+eaz0mLEWeIeo/YiYRvzueKidWC0zmfizH7izzG1Ld1uG7ObQ3jeTQUnalesGErP2xt1obp+pc3omGzzHluvMJ+eWt/caZBShOmbo/+g5pAAc42LHWTDBgPvku8qEkd2cMDCBclK0VGGaiaIHJgehzDDVPEMdgYAWbBeQwSAqezajohiuYFSK3gx6VIxMeDSOsAlB0BL1imraMCyZWcsOqznNWzQ1lk4EmENDaUZZILF9Hfxd8/8G8GYRMhiYoMpvOUUVplkpemByEMoMU80z1BEIaMF2qWQwiMqezbWiGK5gVIreDHpUjEx4NI7QhEw4QY9q2ogpMcnWJSaFHOqQQBswIof6tLBJhLSNDjPi2jgb5/24vni6jmLtXJaWhdzjhMm9HXXvUXfDCZJGZzD7a6Sulo1ggFBRDA/AjdOFfgcVzHThyuGObnRjFv3HGlG7i+lO5nJ7ld2Zn8sXmr17fifXFJ465BLBU2fvnDeUP1xzXAD6BQDAAFwKsKAAAEAWDMBlAEABFlTrORWvq/p60reE1s0OpbDAHffcGahDvswhLCPYUZAHDACBCgoGDpFn7cN2Rz0BQLzAwcHBwcVZpcm2Qdh/luLA5/23MHZ9b7LuX/5dUcMHsOBGbLrc9CXxBbX4+6SoRQ8d6LiLM18+LaM9DOAajT349OjFkSJ1PBhd3Xm8ovJj9x4++KgSu47zjfc+KTRRsPQ61dNJczHS0Ll3dWsncfnW0d314M296zpPn5NiTZoGYtficpglIHPMjlOT3PBy05uHOauBCUoPc2sBW/zKCRpOOJWo7QBl2H7dzXZ882J9RxupIfd+Ly/LSc8WLMDLVc+ohGAIORERpKxUFrts99knZTI5hkaHFtyKW9hK1b5u+cwj9HLY4zTXbkJq6bxI0IRdr558nrsdVLiNEiO9wfbiMruIaUBchJPEQSkPiGn3i9fd9jfv3DyMiHSoWI9hwApxkXogIK5WDLQcJbrm7l2kZBgjupxKA16YqZfU3jE8Csm4HkUKoYR7NRmfyt6hmsd4jZKlTGKsadGjHime4ivZjabJTFy0EiiLwm3WkVjQxSQkcEbxi9hADqlfWJh8+Gic7rVpzCpFhCIPkI6RhaeCqw5ReBubTVBanBTWcLZMaqWior63HlPZJ1kq+8bxNiNG5txmJ3gzpiQ3NMESYRohUQNyyQdkhMJiU15HlhU1MZZ78R5tuvt5gO95NGLvE1Go9gg/Y/ZyswbMwR0L4DCF2e4YMCHFgKt5VOB0szIWzVr/uqVOBg+NU7VhpuX21houOwBZVPSg2KUC3UZvfqPtwfjX4IWhXedOuv3pZ3Qw1vnz9jh12whfWHajqoNZdzsFaJvbUky5OL28qmluaS13gpGP1Pu9L3hAp+ZeFPA8il8L6XZRzclFH8BzD/mfSujH8l2RpxaWMyo9BWYzyg3XZ6o4gMGTFN9tEq21yQafl4BBFCv+/fV8l8hZ2Vr20zxQ0olO+ykP29RDSgwnSBqdwWSd2AeaPqftdWN97YdNiWHj4NjgAyrz//cNeDyxbqo6n7qVuGmJIgnk0oRxMqt0aFQRSCYN1gACmTYfDheSGAleaEW2S2W438SWmaazVD+SigrSNNvFexXEkWkbZw8tkXQ1SiGPPIMscTZGiZFNVAWWEKE2JX6TALVsWLwKliZidBEQEI9SA1oyLxjVIQ1EL2pEFpkaRsWkFiN5q3AwsjGqjSVkoqos0qL7TQIrs2FWk0XWETKStBKscCNLliXwkNID6ZE4XRGpm4A4GyCqRDU2Gq9cTfDWdX4ACdnvv//wr8LW/RSdvyCevm0PF7Z/JHS+4zf6xdM4tO8CwWJga+20ZX+K8bp669u2vIFwnsQUhn2+X5t2uo8Qnkg4AHvAzC9cjpNbFlkUwxXCzpl+noOxNDaR50E7FmPRg65ld7c6oq+N87GxSN9+OfT9hZfCg8hLbn8zPOO3hOEfnKUPz/L6EZ/pl3e4gxIWvF1ESCvi29o9+p2GtjRBBt9fousWOU2o4pOkaw91Gy+dBvWSnwOczpkvE2IEd3KRgnGpFvtg0kHpB0XSwhtAoxvxgSUH5B7w3+YKl/w+da7skB1y+cWZDHmOlHNwfqVwm78KAdx+1KClH5bWLvgaRYmJjcGLNkxrwO1uzZPXPHLZLg6tmoEP5lh46dhZARzNcA8kH5B5QCTd6JebdCPI7T/4rvYnKvHAELfLAAAAAA==') format('woff2');
      }
      @font-face {
        font-family: 'Geist Mono';
        font-style: normal;
        font-weight: 500;
        font-display: swap;
        src: url('data:font/woff2;base64,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') format('woff2');
      }
      @font-face {
        font-family: 'Geist Mono';
        font-style: normal;
        font-weight: 600;
        font-display: swap;
        src: url('data:font/woff2;base64,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') format('woff2');
      }
      * {
        box-sizing: border-box;
        font-family: 'Geist Mono', 'SF Mono', 'JetBrains Mono', 'Cascadia Code', Consolas, ui-monospace, monospace;
        font-feature-settings: 'liga' 0, 'calt' 0;
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
      const r = await rbIpc('kiosk.on');
      if (!r.error) { con.printOk('kiosk on (native Electron)'); _setSb('kiosk', 'on', 'sb-warn'); return; }
      const br = bridge();
      if (!br) { con.printErr('native IPC failed (' + r.error + ') and bridge not detected'); return; }
      try { br.obj.enterKioskMode?.(); con.printOk('kiosk on (via bridge fallback)'); _setSb('kiosk', 'on', 'sb-warn'); } catch (e) { con.printErr(e.message); }
    } else if (mode === 'off') {
      const r = await rbIpc('kiosk.off');
      if (!r.error) { con.printOk('kiosk off (native Electron)'); _setSb('kiosk', 'off', 'sb-ok'); return; }
      const br = bridge();
      if (!br) { con.printErr('native IPC failed (' + r.error + ') and bridge not detected'); return; }
      try { br.obj.exitKioskMode?.(); con.printOk('kiosk off (via bridge fallback)'); _setSb('kiosk', 'off', 'sb-ok'); } catch (e) { con.printErr(e.message); }
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
  }, 'Toggle kiosk mode (on/off) -- uses native Electron, no bridge required');

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
