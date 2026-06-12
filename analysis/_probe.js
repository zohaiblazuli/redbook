// Probe v1: unmodified bundle, log every Function.prototype.toString query,
// lock down global.selfHealingCallbackFunction so the bundle can't reassign it.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const logPath = path.join(__dirname, '_probe.log');
fs.writeFileSync(logPath, `[${new Date().toISOString()}] probe v1\n`);
const log = (...a) => fs.appendFileSync(logPath, a.map(x => typeof x === 'string' ? x : require('util').inspect(x, {depth: 3})).join(' ') + '\n');

const electron = require('electron');
const { app, dialog, protocol } = electron;

// Register app:// as privileged (must be before ready)
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
]);

process.exit = (c) => { log(`[blocked] process.exit(${c})`); };
app.exit = (c) => { log(`[blocked] app.exit(${c})`); };
app.quit = () => { log(`[blocked] app.quit()`, new Error().stack.split('\n').slice(1,3).join(' | ')); };
dialog.showErrorBox = (t, c) => { log('SUPPRESSED dialog:', t, '|', c); };
process.on('uncaughtException', (e) => log('UNCAUGHT', e && e.stack || e));

// --- LOCKDOWN selfHealingCallbackFunction with a non-writable noop BEFORE require ---
// The bundle will try `global.selfHealingCallbackFunction = V_$0` in non-strict mode;
// that assignment will silently fail and our noop stays. The counter-measure invokes
// global.selfHealingCallbackFunction() expecting it to recurse/throw; we just return.
let __shcfCalls = 0;
function __noopSelfHealing() {
  __shcfCalls++;
  if (__shcfCalls <= 20) {
    const st = new Error().stack.split('\n').slice(1, 8).join(' || ');
    log(`>>>> selfHealingCallbackFunction CALLED #${__shcfCalls}: ${st}`);
  }
}
Object.defineProperty(global, 'selfHealingCallbackFunction', {
  value: __noopSelfHealing,
  writable: false,
  configurable: false,
  enumerable: false,
});
log('selfHealingCallbackFunction locked to noop');

// --- Hook Function.prototype.toString to log every query ---
// We want to know which functions are interrogated and what the check pattern is.
const origToString = Function.prototype.toString;
let __tsCalls = 0;
const __tsMax = 200;
Function.prototype.toString = function() {
  const result = origToString.call(this);
  if (__tsCalls++ < __tsMax) {
    const name = (this && this.name) || '<anon>';
    const len = result.length;
    const head = result.length > 100 ? result.slice(0, 100) + '...' : result;
    // Try to identify caller from stack
    let caller = '?';
    try { caller = (new Error().stack.split('\n')[2] || '').trim().slice(0, 200); } catch (_) {}
    log(`ts#${__tsCalls} name=${name} len=${len} from=${caller} src=${JSON.stringify(head)}`);
  }
  return result;
};
log('Function.prototype.toString hooked');

// --- Standard hooks (sig stub, fs probe) ---
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

app.on('ready', () => log('app event: ready'));
app.on('browser-window-created', (e, win) => {
  log('browser-window-created id=', win.id);
  setTimeout(() => { try { win.show(); } catch (_) {} }, 50);
  win.webContents.on('did-finish-load', () => log('did-finish-load', win.webContents.getURL()));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', code, desc, url));
});

log('require start');
try { require('./main/index.js'); log('require returned'); }
catch (e) { log('require threw', e && e.stack); }
log('waiting');
