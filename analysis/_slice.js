// slice key code windows out of the minified bundle by line:col
const fs = require('fs');
const src = fs.readFileSync('F:/app_extracted/main/index.js', 'utf8');
const lines = src.split('\n');

// stack-trace offsets from _trace.log (1-based line, 1-based col):
const sites = [
  ['c5sf  (app.exit wrapper)',     7, 3342416],
  ['56350 (require-time check)', 349, 535932],
  ['v4KM  (saga -> app.quit)',     7, 3433000],
  ['u6tO  (failing saga)',         7, 3370007],
  ['onError (saga error -> exit)',349, 535255],
];

const WINDOW_BEFORE = 250;
const WINDOW_AFTER  = 900;

const out = [];
for (const [label, line, col] of sites) {
  const L = lines[line - 1] || '';
  const start = Math.max(0, col - 1 - WINDOW_BEFORE);
  const end   = Math.min(L.length, col - 1 + WINDOW_AFTER);
  out.push(`\n========================================`);
  out.push(`SITE: ${label}  (line ${line}, col ${col})`);
  out.push(`========================================`);
  out.push(`«before» ${L.slice(start, col - 1)}`);
  out.push(`«AT»     ${L.slice(col - 1, col - 1 + 80)}`);
  out.push(`«after»  ${L.slice(col - 1 + 80, end)}`);
}
fs.writeFileSync('F:/app_extracted/_slices.txt', out.join('\n'));
console.log('wrote _slices.txt,', out.join('\n').length, 'bytes');
