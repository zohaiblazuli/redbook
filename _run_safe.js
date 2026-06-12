// SAFE MODE — minimal launcher, no mods, no dev panel, no IPC tracing.
// Identical to the pre-devpanel version that LO confirmed login was working with.
// Use this to isolate whether dev panel changes broke login (vs. server-side / session issues).
const fs = require('fs');
const path = require('path');
const Module = require('module');
const electron = require('electron');
const { app, dialog } = electron;

const logPath = path.join(__dirname, '_run_safe.log');
fs.writeFileSync(logPath, `[${new Date().toISOString()}] SAFE MODE\n`);
const log = (...a) => fs.appendFileSync(logPath, a.map(x => typeof x === 'string' ? x : require('util').inspect(x, {depth: 3})).join(' ') + '\n');

Object.defineProperty(global, 'selfHealingCallbackFunction', {
  value: function selfHealingCallbackFunction() {},
  writable: false, configurable: false, enumerable: false,
});
log('selfHealingCallbackFunction locked');

process.exit = (c) => { log(`[blocked] process.exit(${c})`); };
app.exit = (c)     => { log(`[blocked] app.exit(${c})`); };
app.quit = ()      => { log(`[blocked] app.quit() | ${(new Error().stack.split('\n').slice(1,3).join(' | '))}`); };
dialog.showErrorBox = (t, c) => { log('SUPPRESSED dialog:', t, '|', c); };
process.on('uncaughtException', (e) => log('UNCAUGHT', e && e.stack || e));

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

app.on('browser-window-created', (e, win) => {
  log('browser-window-created id=', win.id);
  setTimeout(() => { try { win.show(); win.focus(); log('forced show'); } catch (_) {} }, 50);
  win.webContents.once('dom-ready', () => {
    try { win.webContents.openDevTools({ mode: 'detach' }); } catch (_) {}
  });
  win.webContents.on('did-finish-load', () => log('did-finish-load', win.webContents.getURL()));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', code, desc, url));
  win.on('ready-to-show', () => { log('ready-to-show'); win.show(); });
});

app.on('ready', () => log('app event: ready'));

const asarPath = path.join(__dirname, 'resources', 'app.asar');
app.setAppPath(asarPath);
log('setAppPath:', asarPath);

log('require start');
try { require(path.join(asarPath, 'main', 'index.js')); log('require returned'); }
catch (e) { log('require threw', e && e.stack); }
log('waiting');
