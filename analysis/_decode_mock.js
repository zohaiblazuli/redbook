// Expose testPackageMockData itself + the class for full inspection.
const fs = require('fs');
const path = require('path');
const Module2 = require('module');
const { app } = require('electron');
process.exit = () => {};
app.exit = () => {};
app.quit = () => {};
process.on('uncaughtException', () => {});

const origLoad = Module2._load;
Module2._load = function(r, p, m) {
  if (r === 'win-verify-signature') return { verifySignatureByPublishName: () => ({ signed: true, subject: 'CN=The College Board' }) };
  return origLoad.apply(this, arguments);
};
Object.defineProperty(global, 'selfHealingCallbackFunction', { value: () => {}, writable: false, configurable: false });
global.setTimeout = () => 0;
global.setInterval = () => 0;

const src = fs.readFileSync('F:/app_extracted/main/index.js.orig', 'utf8');
const bp = path.join('F:/app_extracted/main', 'index.js');
const m = new Module2(bp, module);
m.filename = bp;
m.paths = Module2._nodeModulePaths(path.dirname(bp));

// Append code to expose internals at end of bundle
const tail = `
;try{
  globalThis.__tpmd = testPackageMockData;
  globalThis.__TestPackageMockData = TestPackageMockData;
  globalThis.__x7 = x7;
}catch(e){ globalThis.__exposeErr = String(e); }
`;
try { m._compile(src + tail, bp); } catch (e) { console.log('compile err:', e.message); }

console.log('\nExpose error:', globalThis.__exposeErr || '(none)');
const tpmd = globalThis.__tpmd;
const TPMD = globalThis.__TestPackageMockData;

console.log('\n=== testPackageMockData (instance — the magic mock test) ===');
if (tpmd === undefined) console.log('  undefined (not in scope at injection point)');
else {
  console.log('  type:', typeof tpmd);
  console.log('  keys:', Object.keys(tpmd));
  for (const k of Object.keys(tpmd)) {
    const v = tpmd[k];
    let display;
    if (typeof v === 'string') display = JSON.stringify(v.length > 200 ? v.slice(0, 200) + '…' : v);
    else if (typeof v === 'object' && v !== null) {
      try { display = '{' + Object.keys(v).slice(0, 8).join(',') + (Object.keys(v).length > 8 ? ',…' : '') + '}'; }
      catch (_) { display = '[object]'; }
    }
    else display = JSON.stringify(v);
    console.log(`    .${k.padEnd(20)} = ${display}`);
  }
  console.log('\n  spid =', JSON.stringify(tpmd.spid));
  // Dump JSON to file for full inspection
  try {
    fs.writeFileSync('F:/app_extracted/_tpmd_dump.json', JSON.stringify(tpmd, (k, v) => {
      if (typeof v === 'string' && v.length > 4000) return v.slice(0, 4000) + '…[truncated]';
      return v;
    }, 2));
    console.log('\n  full dump -> F:/app_extracted/_tpmd_dump.json');
  } catch (e) {
    console.log('  dump err:', e.message);
  }
}

console.log('\n=== TestPackageMockData (class/object) ===');
if (TPMD === undefined) console.log('  undefined');
else {
  console.log('  type:', typeof TPMD);
  console.log('  keys:', Object.keys(TPMD));
}

setTimeout(() => process.kill(process.pid), 200);
