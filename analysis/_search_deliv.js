const fs = require('fs');
const main = fs.readFileSync('F:/app_extracted/main/index.js','utf8');

// 1) Hex-escaped scans for delivery / event type / start mode tokens
function hexEsc(s){ return s.split('').map(c=>'\\x'+c.charCodeAt(0).toString(16)).join(''); }

const enumTokens = [
  'DIGITAL','PROCTORED','UNPROCTORED','STANDARD','NON_STANDARD',
  'STUDENT_AVAILABLE','PRACTICE','PREVIEW','LIVE','REGULAR',
  'PROD_RC','FIELD_TEST','TRIAL','DEMO','MOCK_TEST',
  'TUTORIAL','TUT','OPERATIONAL','BENCHMARK',
  'SAT','PSAT','AP_CS','AP_LIT','BLUEBOOK','BLUEBOOK_DEMO'
];
console.log('=== Hex-escaped enum token scan ===');
for (const t of enumTokens) {
  const hex = hexEsc(t);
  const re = new RegExp(hex,'g');
  const m = main.match(re);
  if (m) console.log('  '+t.padEnd(22)+' ->', m.length, 'hex-encoded hits');
}

// 2) Find every literal between quotes that uses CB enum naming style (UPPER_SNAKE)
console.log('\n=== Top UPPER_SNAKE_CASE literals in main bundle ===');
const re2 = /"([A-Z][A-Z0-9_]{3,40})"/g;
const counts = {};
let m;
while ((m = re2.exec(main)) !== null) counts[m[1]] = (counts[m[1]] || 0) + 1;
const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0, 60);
for (const [k,v] of sorted) console.log('  '+k.padEnd(35), v);

// 3) Decode an obfuscated string-table look that might be `spid:`
console.log('\n=== Look for the constant assignment pattern: ([key]: literal-UUID) ===');
const re3 = /\[u7Xm\.(?:Q2wJ|u3Kd)\(1153\)\]\s*[:=]/g;
let c = 0;
while ((m = re3.exec(main)) !== null && c < 6) {
  c++;
  console.log('@'+m.index+':', JSON.stringify(main.slice(Math.max(0,m.index-150), m.index+400)));
}
