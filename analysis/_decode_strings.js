// Decode bundle strings via x7 string table — for keys involved in V_$0 install + counter-measure
const fs = require('fs');
const path = require('path');
const Module2 = require('module');
const { app } = require('electron');
process.exit = () => {};
app.exit = () => {};
app.quit = () => {};
process.on('uncaughtException', () => {});

// stub win-verify-signature
const origLoad = Module2._load;
Module2._load = function(r, p, m) {
  if (r === 'win-verify-signature') return { verifySignatureByPublishName: () => ({signed:true, subject:'CN=The College Board'}) };
  return origLoad.apply(this, arguments);
};

// stub setTimeout/setInterval to no-op so we don't trigger anti-debug timers
const origST = global.setTimeout;
global.setTimeout = () => 0;
global.setInterval = () => 0;

const src = fs.readFileSync('F:/app_extracted/main/index.js.orig', 'utf8');
const bp = path.join('F:/app_extracted/main', 'index.js');
const m = new Module2(bp, module);
m.filename = bp;
m.paths = Module2._nodeModulePaths(path.dirname(bp));
try { m._compile(src + '\n;try{globalThis.__x7=x7}catch(_){}', bp); } catch(e) { console.log('compile err:', e && e.message); }
const x7 = globalThis.__x7;
if (!x7) { console.log('x7 not exposed'); process.kill(process.pid); }

// Decode the keys we care about
const probes = [
  ['u3Kd', 2846, 'V_$0 install target'],
  ['Q2wJ', 2846, 'V_$0 install target alt'],
  ['u3Kd', 1901, ''],
  ['u3Kd', 4052, ''],
  ['Q2wJ', 2410, ''],
  ['u3Kd', 10649, ''],
  ['u3Kd', 6486, ''],
  ['u3Kd', 7503, ''],
  ['u3Kd', 7742, ''],
];
for (const [fn, num, note] of probes) {
  try {
    const v = x7[fn](num);
    console.log(`x7.${fn}(${num}) = ${JSON.stringify(v)}${note?' // '+note:''}`);
  } catch (e) {
    console.log(`x7.${fn}(${num}) THREW ${e && e.message}`);
  }
}
// Also dump a known sentinel
console.log('Z27r/U2DV checks:');
console.log('  x7.Q2wJ(2855) =', JSON.stringify(x7.Q2wJ(2855)));
console.log('  x7.u3Kd(8551) =', JSON.stringify(x7.u3Kd(8551)));

setTimeout = origST;
setTimeout(() => process.kill(process.pid), 200);
