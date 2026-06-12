// Stage 1: leak the x7 decoder out of the bundle
// Stage 2: resolve every u3Kd/Q2wJ index seen in our integrity-check slices

const fs = require('fs');
const path = require('path');
const logPath = path.join(__dirname, '_decode.log');
fs.writeFileSync(logPath, `[${new Date().toISOString()}] decoder leak boot\n`);
const log = (...a) => fs.appendFileSync(logPath, a.map(x => typeof x === 'string' ? x : require('util').inspect(x, {depth: 4, maxArrayLength: 50})).join(' ') + '\n');

// ---- block all exits/quits as before ----
const origExit = process.exit.bind(process);
process.exit = (c) => { log('[blocked] process.exit', c); };
const { app } = require('electron');
app.exit = (c) => { log('[blocked] app.exit', c); };
app.quit = () => { log('[blocked] app.quit'); };
process.on('uncaughtException', (e) => log('UNCAUGHT', e && e.stack || e));
process.on('unhandledRejection', (e) => log('UNHANDLED', e && e.stack || e));

// ---- patch the bundle to leak x7 ----
const Module = require('module');
const bundlePath = path.join(__dirname, 'main', 'index.js');
const orig = fs.readFileSync(bundlePath, 'utf8');

// Append code at the very end that captures x7 to globalThis
const leak = '\n;try{globalThis.__x7 = x7;}catch(_){}';
const patched = orig + leak;

// Use Module._compile to evaluate the patched source as if it were the real file
log('compiling patched bundle, original size:', orig.length, 'patched size:', patched.length);
const m = new Module(bundlePath, module);
m.filename = bundlePath;
m.paths = Module._nodeModulePaths(path.dirname(bundlePath));

try {
  m._compile(patched, bundlePath);
  log('bundle compile finished');
} catch (e) {
  log('bundle threw during compile:', e && e.stack || e);
}

// ---- now use the leaked decoder ----
const x7 = globalThis.__x7;
if (!x7) {
  log('FAILED to capture x7');
  origExit(1);
}
log('captured x7. typeof u3Kd:', typeof x7.u3Kd, 'typeof Q2wJ:', typeof x7.Q2wJ);

// Try a few sample indices to confirm
function safe(fn, n) {
  try { const v = fn(n); return JSON.stringify(v); } catch (e) { return 'THROW: ' + e.message; }
}

log('\n=== sample decoder probes ===');
for (const n of [1499, 1719, 12782, 2877, 3603, 4592, 11300, 2350, 2715, 404, 6447, 12674, 3420, 6166, 2778, 12709, 12941, 3500, 7503]) {
  log(`u3Kd(${n}) = ${safe(x7.u3Kd && x7.u3Kd.bind(x7), n)}    Q2wJ(${n}) = ${safe(x7.Q2wJ && x7.Q2wJ.bind(x7), n)}`);
}

// Now reload the slices file and resolve every u3Kd/Q2wJ index in it
log('\n=== resolving all indices in _slices.txt ===');
const slices = fs.readFileSync(path.join(__dirname, '_slices.txt'), 'utf8');
const resolved = slices
  .replace(/u7Xm\.u3Kd\((\d+)\)/g, (_, n) => {
    const s = safe(x7.u3Kd && x7.u3Kd.bind(x7), Number(n));
    return `«u3Kd:${s}»`;
  })
  .replace(/u7Xm\.Q2wJ\((\d+)\)/g, (_, n) => {
    const s = safe(x7.Q2wJ && x7.Q2wJ.bind(x7), Number(n));
    return `«Q2wJ:${s}»`;
  });
fs.writeFileSync(path.join(__dirname, '_slices_resolved.txt'), resolved);
log('wrote _slices_resolved.txt');

log('\n=== done, exiting ===');
setTimeout(() => origExit(0), 300);
