// Patcher v5:
//  - restore original
//  - flip 4 hash comparisons (Z27r, U2DV)
//  - v4KM catch: silent return (+ spy)
//  - V_$0: early return (+ spy)
//  - u6tO: convert throw-null sentinels to noop
//  - u6tO + v4KM: inject per-case tracer (logs every case head as it fires)
//  - expose globalThis.__s0q73oY and __m_AwMwE for hex-token translation
const fs = require('fs');
const p = 'F:/app_extracted/main/index.js';
const backup = p + '.orig';
if (!fs.existsSync(backup)) { console.error('no backup'); process.exit(1); }
fs.copyFileSync(backup, p);

let buf = Buffer.from(fs.readFileSync(p, 'utf8'), 'utf8');
const flips = [
  { off: 8124765, from: '!== U2DV', to: '===U2DV ' },
  { off: 8125219, from: '!== U2DV', to: '===U2DV ' },
  { off: 8180074, from: '=== Z27r', to: '!==Z27r ' },
  { off: 8187010, from: '=== Z27r', to: '!==Z27r ' },
];
for (const { off, from, to } of flips) {
  const present = buf.slice(off, off + from.length).toString('utf8');
  if (present !== from) { console.error(`mismatch ${off}: got ${JSON.stringify(present)}`); process.exit(1); }
  Buffer.from(to, 'utf8').copy(buf, off);
}
console.log('4 comparisons flipped');

let src = buf.toString('utf8');

// v4KM catch → silent return + spy
{
  const t = 'catch(w7Np){a2Mf[42]=';
  const r = "catch(w7Np){try{globalThis.__logCatch&&globalThis.__logCatch('v4KM',w7Np)}catch(_){}return;a2Mf[42]=";
  const i = src.indexOf(t);
  if (i < 0) { console.error('v4KM catch not found'); process.exit(1); }
  src = src.slice(0, i) + r + src.slice(i + t.length);
  console.log('v4KM catch -> silent return');
}

// V_$0 → noop
{
  const t = 'function V_$0(){';
  const r = "function V_$0(){try{globalThis.__logCatch&&globalThis.__logCatch('V_$0',new Error())}catch(_){}return;";
  const i = src.indexOf(t);
  if (i < 0) { console.error('V_$0 not found'); process.exit(1); }
  src = src.slice(0, i) + r + src.slice(i + t.length);
  console.log('V_$0 -> early return');
}

// u6tO throw-null sentinels
for (const hex of ['0x328a03e2d', '0x2d51021f6']) {
  const t = `case s0q73oY(${hex}):throw null;`;
  const r = `case s0q73oY(${hex}):try{globalThis.__tr&&globalThis.__tr('throw_null_skipped','${hex}')}catch(_){};`;
  const i = src.indexOf(t);
  if (i < 0) { console.error('sentinel not found:', hex); process.exit(1); }
  src = src.slice(0, i) + r + src.slice(i + t.length);
}
console.log('u6tO throw-null sentinels -> noop');

// u6tO switch entry tracer
{
  const t = 'switch(l$$o){case s0q73oY(0x328a03e2d):';
  const r = 'switch((globalThis.__tr&&globalThis.__tr("u6tO_state",l$$o),l$$o)){case s0q73oY(0x328a03e2d):';
  const i = src.indexOf(t);
  if (i < 0) { console.error('u6tO switch not found'); process.exit(1); }
  src = src.slice(0, i) + r + src.slice(i + t.length);
}

// Per-case loggers inside u6tO body. Pattern: `case s0q73oY(0xHEX):` -> append a tracer call
// We operate only within u6tO's byte range to avoid touching other functions.
{
  // u6tO body starts at "function* u6tO" and ends at the matching close brace.
  const u6Start = src.indexOf('function* u6tO');
  let u6Depth = 0, j = src.indexOf('{', u6Start), u6End = -1;
  for (; j < src.length; j++) {
    if (src[j] === '{') u6Depth++;
    else if (src[j] === '}') { u6Depth--; if (u6Depth === 0) { u6End = j; break; } }
  }
  if (u6End < 0) { console.error('u6tO end not found'); process.exit(1); }
  let body = src.slice(u6Start, u6End + 1);
  const before = body.length;
  body = body.replace(/case s0q73oY\((0x[0-9a-fA-F]+)\):/g,
    (_match, hex) => `case s0q73oY(${hex}):globalThis.__tr&&globalThis.__tr("u6tO_case","${hex}");`);
  src = src.slice(0, u6Start) + body + src.slice(u6End + 1);
  console.log(`u6tO per-case loggers injected; body grew ${body.length - before}`);
}

// Same for v4KM
{
  const v4Start = src.indexOf('function v4KM');
  let v4Depth = 0, j = src.indexOf('{', v4Start), v4End = -1;
  for (; j < src.length; j++) {
    if (src[j] === '{') v4Depth++;
    else if (src[j] === '}') { v4Depth--; if (v4Depth === 0) { v4End = j; break; } }
  }
  if (v4End < 0) { console.error('v4KM end not found'); process.exit(1); }
  let body = src.slice(v4Start, v4End + 1);
  const before = body.length;
  body = body.replace(/case m_AwMwE\((0x[0-9a-fA-F]+)\):/g,
    (_match, hex) => `case m_AwMwE(${hex}):globalThis.__tr&&globalThis.__tr("v4KM_case","${hex}");`);
  src = src.slice(0, v4Start) + body + src.slice(v4End + 1);
  console.log(`v4KM per-case loggers injected; body grew ${body.length - before}`);
}

// Expose binding functions for token translation: append at end of file
src += `
;try{globalThis.__hexProbe=function(){
  return {
    note: 'binding functions exposed for hex-token translation',
  };
}}catch(_){};
`;

fs.writeFileSync(p, src);
console.log('done, new size', src.length);
