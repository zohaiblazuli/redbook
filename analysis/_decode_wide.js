// Bigger windows + walk back/forward to find function boundaries
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync('F:/app_extracted/main/index.js', 'utf8');
const lines = src.split('\n');

// Reload x7 via patched compile
const Module = require('module');
const { app } = require('electron');
process.exit = () => {};
app.exit = () => {};
app.quit = () => {};
process.on('uncaughtException', () => {});

const bundlePath = path.join('F:/app_extracted', 'main', 'index.js');
const m = new Module(bundlePath, module);
m.filename = bundlePath;
m.paths = Module._nodeModulePaths(path.dirname(bundlePath));
try { m._compile(src + '\n;try{globalThis.__x7 = x7;}catch(_){}', bundlePath); } catch(_) {}
const x7 = globalThis.__x7;

const decode = (s) => s
  .replace(/u7Xm\.u3Kd\((\d+)\)/g, (_,n) => { try { return JSON.stringify(x7.u3Kd(+n)); } catch { return `u3Kd(${n})`; } })
  .replace(/u7Xm\.Q2wJ\((\d+)\)/g, (_,n) => { try { return JSON.stringify(x7.Q2wJ(+n)); } catch { return `Q2wJ(${n})`; } })
  .replace(/x7\.u3Kd\((\d+)\)/g,   (_,n) => { try { return JSON.stringify(x7.u3Kd(+n)); } catch { return `u3Kd(${n})`; } })
  .replace(/x7\.Q2wJ\((\d+)\)/g,   (_,n) => { try { return JSON.stringify(x7.Q2wJ(+n)); } catch { return `Q2wJ(${n})`; } });

const sites = [
  ['SITE 1: c5sf body (require-time check + sentry init)',     7, 3342416, 2200, 600],
  ['SITE 2: 56350 calling c5sf',                              349, 535932, 200, 100],
  ['SITE 3: v4KM (the saga-action that quits)',                 7, 3433000, 2200, 200],
  ['SITE 4: u6tO body (the failing saga state)',                7, 3370007, 3000, 2200],
  ['SITE 5: onError saga handler',                            349, 535255, 1500, 200],
];

let out = '';
for (const [label, line, col, back, fwd] of sites) {
  const L = lines[line-1];
  const start = Math.max(0, col-1-back);
  const end = Math.min(L.length, col-1+fwd);
  const window = L.slice(start, end);
  out += `\n\n================ ${label} ================\n`;
  out += `(line ${line} col ${col}, window [${start}..${end}])\n`;
  out += decode(window);
}

fs.writeFileSync('F:/app_extracted/_decoded_wide.txt', out);
console.log('wrote _decoded_wide.txt');
setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);
