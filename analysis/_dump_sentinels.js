const fs = require('fs');
const path = require('path');
const Module = require('module');
const { app } = require('electron');
process.exit = () => {};
app.exit = () => {};
app.quit = () => {};
process.on('uncaughtException', () => {});

const Module2 = require('module');
const origLoad = Module2._load;
Module2._load = function(r, p, m) {
  if (r === 'win-verify-signature') return { verifySignatureByPublishName: (f, n) => ({signed:true, subject: 'CN='+(n[0]||'x')}) };
  return origLoad.apply(this, arguments);
};

const src = fs.readFileSync('F:/app_extracted/main/index.js', 'utf8');
const bp = path.join('F:/app_extracted/main', 'index.js');
const m = new Module2(bp, module);
m.filename = bp;
m.paths = Module2._nodeModulePaths(path.dirname(bp));
try { m._compile(src + '\n;try{globalThis.__x7=x7}catch(_){}', bp); } catch(_) {}
const x7 = globalThis.__x7;
console.log('Z27r = u7Xm.Q2wJ(2855) =', JSON.stringify(x7.Q2wJ(2855)));
console.log('U2DV = u7Xm.u3Kd(8551) =', JSON.stringify(x7.u3Kd(8551)));
setTimeout(() => process.kill(process.pid), 200);
