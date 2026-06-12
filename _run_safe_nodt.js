// SAFE MODE — no mods, no dev panel, AND no auto-opened DevTools.
// Hypothesis: the bundle's onDebuggerDetected (cumulative) is disabling login.
// If you can sign in via this launcher, DevTools open is the trigger.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const electron = require('electron');
const { app, dialog } = electron;

const logPath = path.join(__dirname, '_run_safe_nodt.log');
fs.writeFileSync(logPath, `[${new Date().toISOString()}] SAFE MODE - NO DEVTOOLS\n`);
const log = (...a) => fs.appendFileSync(logPath, a.map(x => typeof x === 'string' ? x : require('util').inspect(x, {depth: 3})).join(' ') + '\n');

Object.defineProperty(global, 'selfHealingCallbackFunction', {
  value: function selfHealingCallbackFunction() {},
  writable: false, configurable: false, enumerable: false,
});

process.exit = (c) => { log(`[blocked] process.exit(${c})`); };
app.exit = (c)     => { log(`[blocked] app.exit(${c})`); };
app.quit = ()      => { log(`[blocked] app.quit()`); };
dialog.showErrorBox = (t, c) => { log('SUPPRESSED dialog:', t, '|', c); };
process.on('uncaughtException', (e) => log('UNCAUGHT', e && e.stack || e));

const origLoad = Module._load;
Module._load = function(req, parent, isMain) {
  if (req === 'win-verify-signature') {
    return { verifySignatureByPublishName: (fp, pn) => {
      const t = (pn && pn[0]) || 'The College Board';
      const s = String(t).includes('=') ? String(t) : `CN=${t}`;
      return { signed: true, subject: s };
    }};
  }
  return origLoad.apply(this, arguments);
};

app.on('browser-window-created', (e, win) => {
  log('browser-window-created id=', win.id);
  setTimeout(() => { try { win.show(); win.focus(); log('forced show'); } catch (_) {} }, 50);
  // NO DEVTOOLS auto-open.
  win.webContents.on('did-finish-load', () => log('did-finish-load', win.webContents.getURL()));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', code, desc, url));
  win.on('ready-to-show', () => { log('ready-to-show'); win.show(); });
});

app.on('ready', () => log('app event: ready'));

const asarPath = path.join(__dirname, 'resources', 'app.asar');
app.setAppPath(asarPath);

log('require start');
try { require(path.join(asarPath, 'main', 'index.js')); log('require returned'); }
catch (e) { log('require threw', e && e.stack); }
