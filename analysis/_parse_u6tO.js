// Parse u6tO's state machine into a graph.
// For each case s0q73oY(0xHEX): body, capture:
//   - body text (truncated for output)
//   - all `l$$o = s0q73oY(0xHEX)` transitions found in body
//   - whether body contains keywords: throw, yield, t_g1, U9zG, loadURL, show, V_$0, v4KM, B$dw, q8sC, m2Bj
const fs = require('fs');
const s = fs.readFileSync('F:/app_extracted/main/index.js', 'utf8');

const start = s.indexOf('function* u6tO');
if (start < 0) { console.error('u6tO not found'); process.exit(1); }
// Find balanced end brace
let depth = 0, i = s.indexOf('{', start), end = -1;
for (; i < s.length; i++) {
  if (s[i] === '{') depth++;
  else if (s[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
}
console.log(`u6tO body: chars [${start}..${end}], length ${end-start}`);

const body = s.slice(start, end + 1);
// Locate the switch block
const switchHead = body.indexOf('switch(l$$o)');
const switchStart = body.indexOf('{', switchHead) + 1;
// Find matching close
let sd = 1, j = switchStart, switchEnd = -1;
for (; j < body.length; j++) {
  if (body[j] === '{') sd++;
  else if (body[j] === '}') { sd--; if (sd === 0) { switchEnd = j; break; } }
}
console.log(`switch body in u6tO: chars [${switchStart}..${switchEnd}], length ${switchEnd-switchStart}`);

const sw = body.slice(switchStart, switchEnd);

// Split into cases by regex on the case-marker
// Case markers look like: case s0q73oY(0xHEX):
const re = /case s0q73oY\((0x[0-9a-fA-F]+)\):/g;
const matches = [];
let m;
while ((m = re.exec(sw)) !== null) matches.push({ hex: m[1], start: m.index, headEnd: m.index + m[0].length });
console.log(`found ${matches.length} cases`);

// For each case, body = headEnd .. next case's start (or end of switch)
const cases = [];
for (let k = 0; k < matches.length; k++) {
  const c = matches[k];
  const next = k + 1 < matches.length ? matches[k+1].start : sw.length;
  const cbody = sw.slice(c.headEnd, next);
  cases.push({ hex: c.hex, body: cbody });
}

// Collapse duplicate case-keys: many will have identical body. Group by body identity.
const transRe = /l\$\$o\s*=\s*s0q73oY\((0x[0-9a-fA-F]+)\)/g;
function transitions(b) {
  const out = new Set();
  let mm;
  transRe.lastIndex = 0;
  while ((mm = transRe.exec(b)) !== null) out.add(mm[1]);
  return [...out];
}
function keywords(b) {
  const k = [];
  const tests = [
    ['THROW', /throw null/],
    ['YIELD', /yield /],
    ['t_g1', /t_g1\(/],
    ['U9zG', /U9zG\(/],
    ['loadURL', /loadURL/],
    ['SHOW', /\.show\(\)/],
    ['V_$0', /V_\$0\(/],
    ['v4KM', /v4KM\(/],
    ['B$dw', /B\$dw\(/],
    ['q8sC', /q8sC\(/],
    ['m2Bj', /m2Bj/],
    ['d$1m', /d\$1m\(/],
    ['z$6b', /z\$6b\(/],
    ['setupHandler', /setupHandler/],
    ['Q8eu', /Q8eu\(/],
    ['J26A', /J26A\(/],
    ['f26X', /f26X\(/],
    ['initTelemetry', /initTelemetrySender/],
    ['HASH', /createHash/],
    ['publicDecrypt', /publicDecrypt/],
    ['FAIL_MSG', /FAILED_FILE_INTEGRITY_CHECK/],
    ['SAGA_CANCEL', /CANCELLED/],
    ['Z27r', /Z27r/],
    ['U2DV', /U2DV/],
    ['MAGIC', /[Ww]ill-quit|requestSingleInstanceLock|app\["quit"\]/],
  ];
  for (const [name, re] of tests) if (re.test(b)) k.push(name);
  return k;
}

// Dedupe: cases with identical body
const byBody = new Map();
for (const c of cases) {
  const key = c.body;
  if (!byBody.has(key)) byBody.set(key, { hexes: [], body: c.body });
  byBody.get(key).hexes.push(c.hex);
}

const groups = [...byBody.values()];
console.log(`${groups.length} unique case bodies (some hex tokens share identical bodies)`);

// Print each group: hex(es), transitions, keywords, body snippet
const out = [];
for (const g of groups) {
  const trans = transitions(g.body);
  const kw = keywords(g.body);
  out.push({
    hexes: g.hexes,
    transitions: trans,
    keywords: kw,
    bodyLen: g.body.length,
    bodySnippet: g.body.length > 400 ? g.body.slice(0, 400) + '...' : g.body,
  });
}

// Sort by # of keywords (interesting first)
out.sort((a, b) => b.keywords.length - a.keywords.length);

let outText = '';
for (const o of out) {
  outText += `\n=== hexes: ${o.hexes.join(', ')} ===\n`;
  outText += `kw: [${o.keywords.join(', ')}]\n`;
  outText += `transitions: [${o.transitions.join(', ')}]\n`;
  outText += `bodyLen: ${o.bodyLen}\n`;
  outText += `body: ${o.bodySnippet}\n`;
}
fs.writeFileSync('F:/app_extracted/_u6tO_graph.txt', outText);
console.log('wrote _u6tO_graph.txt');

// Also dump a terse adjacency table
let adj = 'hex -> transitions | keywords\n';
for (const o of out) {
  for (const h of o.hexes) adj += `${h} -> ${o.transitions.join(',')} | ${o.keywords.join(',')}\n`;
}
fs.writeFileSync('F:/app_extracted/_u6tO_adj.txt', adj);
console.log('wrote _u6tO_adj.txt');
