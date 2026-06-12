// Decode the env var path indices + the saga's kiosk/checkin gates.
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
try { m._compile(src + '\n;try{globalThis.__x7=x7}catch(_){}', bp); } catch(_){}
const x7 = globalThis.__x7;
if (!x7) { console.log('x7 missing'); process.kill(process.pid); }

console.log('=== Process env var name decoding ===');
const probes = [
  ['Q2wJ', 877],   // process[??]
  ['u3Kd', 2676],  // process[X][??]
  ['u3Kd', 11163], // process[??] (truthy check)
  ['Q2wJ', 11163],
  ['u3Kd', 5953],
  ['Q2wJ', 10299],
  ['u3Kd', 4316],
  ['Q2wJ', 9738],
  ['u3Kd', 9299],
  ['u3Kd', 8798],
  ['Q2wJ', 8798],
  ['Q2wJ', 1634],
  ['Q2wJ', 1097],
];
for (const [fn, idx] of probes) {
  try { console.log('  x7.'+fn+'('+idx+').padEnd ='.padEnd(28), JSON.stringify(x7[fn](idx))); }
  catch (e) { console.log('  '+fn+'('+idx+') THREW'); }
}

console.log('\n=== Scan for environment enum strings via x7 ===');
const known = ['PROD','INT','QA','LOCAL','DEV','UAT','STAGE','STAGING','PREVIEW','SANDBOX','INTERNAL','RC','PROD-RC'];
console.log('Searching x7 string table for env-enum tokens...');
// Brute force: try first 14000 indices on both decoders, look for the env values
const found = { Q2wJ: {}, u3Kd: {} };
for (const fn of ['Q2wJ','u3Kd']) {
  for (let i = 0; i < 14000; i++) {
    try {
      const v = x7[fn](i);
      if (typeof v !== 'string') continue;
      if (known.includes(v)) { found[fn][i] = v; }
    } catch (_) {}
  }
}
console.log('found indices:', JSON.stringify(found, null, 2));

console.log('\n=== Brute-find SPID-shaped UUIDs in x7 string table ===');
const uuids = { Q2wJ: [], u3Kd: [] };
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
for (const fn of ['Q2wJ','u3Kd']) {
  for (let i = 0; i < 14000; i++) {
    try {
      const v = x7[fn](i);
      if (typeof v === 'string' && uuidRe.test(v)) uuids[fn].push({ i, v });
    } catch (_) {}
  }
}
console.log('UUIDs found (first 20 each):');
console.log('Q2wJ:', uuids.Q2wJ.slice(0,20));
console.log('u3Kd:', uuids.u3Kd.slice(0,20));

console.log('\n=== Find "test type" / asmt enum strings in x7 table ===');
const enumTokens = ['DIGITAL_PRACTICE','DIGITAL_PROCTORED','DIGITAL','PROCTORED','PRACTICE','PREVIEW','LIVE','REGULAR','MOCK','REHEARSAL','SAT','PSAT','AP','CLEP'];
const enumFound = { Q2wJ: {}, u3Kd: {} };
for (const fn of ['Q2wJ','u3Kd']) {
  for (let i = 0; i < 14000; i++) {
    try {
      const v = x7[fn](i);
      if (typeof v === 'string' && enumTokens.some(t => v === t)) enumFound[fn][i] = v;
    } catch (_) {}
  }
}
console.log(JSON.stringify(enumFound, null, 2));

setTimeout(() => process.kill(process.pid), 200);
