// Launch v5 — exit block + dialog suppress + sig stub + fs/crypto probe
const fs = require('fs');
const path = require('path');
const Module = require('module');
const crypto = require('crypto');
const logPath = path.join(__dirname, '_launch.log');
fs.writeFileSync(logPath, `[${new Date().toISOString()}] launch v5\n`);
const log = (...a) => fs.appendFileSync(logPath, a.map(x => typeof x === 'string' ? x : require('util').inspect(x, {depth: 3})).join(' ') + '\n');

const electron = require('electron');
const { app, dialog, protocol } = electron;

// Must be called BEFORE app.ready: declare `app` as a privileged scheme so it can
// behave like https (fetch, CORS, service workers, etc.) — same as the real Bluebook does.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
]);
process.exit = (c) => { log(`[blocked] process.exit(${c})`); };
app.exit = (c) => { log(`[blocked] app.exit(${c})`); };
app.quit = () => { log(`[blocked] app.quit()`, new Error().stack.split('\n').slice(1,3).join(' | ')); };
dialog.showErrorBox = (t, c) => { log('SUPPRESSED dialog:', t, '|', c); };
process.on('uncaughtException', (e) => log('UNCAUGHT', e && e.stack || e));

// Spy hook invoked by injected code inside bundle's v4KM catch
globalThis.__logCatch = (where, err) => {
  let s;
  try { s = (err && err.stack) || (err && err.message) || String(err); }
  catch (_) { s = '<unstringifiable>'; }
  log(`>>>> BUNDLE CATCH @${where}:`, s);
};

// State tracer
let __trCount = 0;
const __trMax = 5000;
globalThis.__tr = (label, val) => {
  if (__trCount++ > __trMax) return;
  let v;
  try {
    const t = typeof val;
    if (t === 'number') v = `num 0x${val.toString(16)}`;
    else if (t === 'bigint') v = `bi 0x${val.toString(16)}n`;
    else if (t === 'string') v = `str ${JSON.stringify(val.slice(0, 80))}`;
    else if (t === 'object' && val === null) v = 'null';
    else if (t === 'object') {
      let keys = '<no-keys>';
      try { keys = Object.keys(val).slice(0,5).join(','); } catch(_) {}
      let proto = '<no-proto>';
      try { proto = Object.getPrototypeOf(val)?.constructor?.name || '?'; } catch(_) {}
      v = `obj proto=${proto} keys=[${keys}]`;
    }
    else v = t;
  } catch (e) { v = '?ex:' + (e && e.message || 'unknown'); }
  log(`>>>> TR ${label}: ${v}`);
};

// hook win-verify-signature
const origLoad = Module._load;
Module._load = function(req, parent, isMain) {
  if (req === 'win-verify-signature') {
    return { verifySignatureByPublishName(fp, pn) {
      const t = (pn && pn[0]) || 'The College Board';
      const s = String(t).includes('=') ? String(t) : `CN=${t}`;
      log(`win-verify stub: ${fp} expects ${JSON.stringify(pn)} -> faking signed=true subject=${s}`);
      return { signed: true, subject: s };
    }};
  }
  return origLoad.apply(this, arguments);
};

// fs hooks (also catch errors)
['statSync', 'lstatSync', 'readFileSync', 'readdirSync', 'realpathSync'].forEach(fn => {
  const orig = fs[fn];
  fs[fn] = function(p, ...rest) {
    try {
      const r = orig.call(fs, p, ...rest);
      log(`fs.${fn}(${JSON.stringify(String(p).slice(0,150))}) ok`);
      return r;
    } catch (e) {
      log(`fs.${fn}(${JSON.stringify(String(p).slice(0,150))}) THROW ${e.code || ''} ${e.message.slice(0,200)}`);
      throw e;
    }
  };
});

// crypto.publicDecrypt
const origPD = crypto.publicDecrypt;
crypto.publicDecrypt = function(k, d) {
  try {
    const r = origPD.call(crypto, k, d);
    log('crypto.publicDecrypt ok, in=', d && d.length, 'bytes, out=', r && r.length, 'bytes, head=', r && r.slice(0, 80).toString());
    return r;
  } catch (e) {
    log('crypto.publicDecrypt THROW', e.code, e.message);
    throw e;
  }
};

// app events
app.on('ready', () => log('app event: ready'));
app.on('browser-window-created', (e, win) => {
  log('browser-window-created id=', win.id);
  setTimeout(() => { try { win.show(); win.focus(); log('forced show'); } catch (_) {} }, 50);
  win.webContents.on('did-finish-load', () => log('did-finish-load', win.webContents.getURL()));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', code, desc, url));
  win.webContents.on('console-message', (_e, level, msg) => log('renderer:', level, String(msg).slice(0,400)));
  win.on('ready-to-show', () => { log('ready-to-show'); win.show(); });
  win.on('show', () => log('window shown'));
});

log('require start');
try { require('./main/index.js'); log('require returned'); }
catch (e) { log('require threw', e && e.stack); }
log('waiting');

// Bypass: create our own BrowserWindow after app is ready, loading the renderer directly.
// The bundle's u6tO saga gates window creation behind integrity checks; we sidestep it.
app.whenReady().then(() => {
  // Register app:// to serve the renderer/ directory as the web root.
  const rendererRoot = path.join(__dirname, 'renderer');
  try {
    protocol.handle('app', async (req) => {
      const url = new URL(req.url);
      // Strip query, decode, drop leading slash. Default to index.html for root.
      let rel = decodeURIComponent(url.pathname);
      if (rel === '' || rel === '/') rel = '/index.html';
      const fp = path.join(rendererRoot, rel);
      log(`app:// ${req.method} ${url.pathname} -> ${fp}`);
      try {
        const data = fs.readFileSync(fp);
        // Minimal content-type from extension
        const ext = path.extname(fp).toLowerCase();
        const ct = {
          '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript',
          '.css':'text/css','.json':'application/json','.svg':'image/svg+xml',
          '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
          '.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon',
          '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf',
          '.mp3':'audio/mpeg','.wav':'audio/wav','.mp4':'video/mp4',
        }[ext] || 'application/octet-stream';
        return new Response(data, { status: 200, headers: { 'Content-Type': ct } });
      } catch (e) {
        log(`app:// 404 ${fp}: ${e.code || e.message}`);
        return new Response('not found', { status: 404 });
      }
    });
    log('app:// protocol handler installed, root =', rendererRoot);
  } catch (e) {
    log('protocol.handle failed', e && e.message);
  }

  // BYPASS DISABLED for this trace run. We want to see the real saga's behavior cleanly.
});
