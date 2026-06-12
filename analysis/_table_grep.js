// Brute-grep the full x7 string table for high-signal exam mode tokens.
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

// Collect ALL unique decodable strings from both decoders
const all = new Map();   // value -> {indices, decoders}
for (const fn of ['Q2wJ','u3Kd','g8js','W_Jb']) {
  for (let i = 0; i < 14000; i++) {
    try {
      const v = x7[fn](i);
      if (typeof v !== 'string') continue;
      if (!all.has(v)) all.set(v, { idx: [] });
      all.get(v).idx.push(fn+'#'+i);
    } catch (_) {}
  }
}
console.log('Total unique strings in x7 table:', all.size);

// Filter for high-signal patterns
function matches(re, label) {
  console.log('\n=== ' + label + ' ===');
  const matches = [];
  for (const [v, info] of all) if (re.test(v)) matches.push({ v, n: info.idx.length });
  matches.sort((a, b) => a.v.localeCompare(b.v));
  for (const m of matches.slice(0, 2000)) {
    console.log('  ' + (m.v.length > 100 ? m.v.slice(0, 100) + '…' : m.v));
  }
  console.log('  (' + matches.length + ' total)');
}

matches(/^[A-Z][A-Z0-9_]{3,40}$/, 'UPPER_SNAKE constants (≥4 chars)');
matches(/test|exam|asmt|kiosk|lockdown|deliver|proctor/i, 'test/exam/asmt/kiosk/lockdown/deliver/proctor strings');
matches(/^(BBP|BBE|BBT|BBV|BB-)/, 'BB-prefixed (Bluebook codes)');
matches(/^(DM|EVT|FT|MT|ST|TY)[-_]/, 'Short prefixed enums');
matches(/Type$|Method$|Mode$|State$|Phase$|Status$/, 'TypeMethodMode constants');
matches(/spid|SPID|packageId|PackageId/, 'spid / packageId');
matches(/(internal|staff|admin|dev)[-_ ]?(only|exam|mode|user)/i, 'internal/staff/dev gating');
matches(/^(actualExam|mockExam|previewTest|practiceTest|realExam|liveExam|fieldTest)$/i, 'exam-type identifiers');

setTimeout(() => process.kill(process.pid), 200);
