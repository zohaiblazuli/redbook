// trace wrapper v2 — swallow integrity bail and continue
const fs = require('fs');
const path = require('path');
const logPath = path.join(__dirname, '_trace.log');
fs.writeFileSync(logPath, `[${new Date().toISOString()}] wrapper boot v2\n`);
const log = (...a) => fs.appendFileSync(logPath, a.map(x => typeof x === 'string' ? x : require('util').inspect(x, {depth: 3})).join(' ') + '\n');

process.on('uncaughtException', (e) => { log('UNCAUGHT', e && e.stack || e); });
process.on('unhandledRejection', (e) => { log('UNHANDLED_REJECTION', e && e.stack || e); });
process.on('exit', (code) => { log('FINAL_EXIT code=', code); });

// Swallow process.exit completely
const origExit = process.exit.bind(process);
process.exit = (code) => {
  log('[blocked] process.exit(', code, ') from\n', new Error().stack);
  // do NOT actually exit
};

const { app } = require('electron');
app.exit = (code) => { log('[blocked] app.exit(', code, ') from\n', new Error().stack); };
app.quit = () => { log('[blocked] app.quit() from\n', new Error().stack); };
app.relaunch = (...a) => { log('[blocked] app.relaunch', a); };

app.on('ready', () => log('event: ready'));
app.on('window-all-closed', () => log('event: window-all-closed'));
app.on('browser-window-created', (e, win) => {
  log('event: browser-window-created -> id', win.id);
  win.webContents.on('did-finish-load', () => log('webContents did-finish-load', win.webContents.getURL()));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('webContents did-fail-load', code, desc, url));
  win.webContents.on('console-message', (_e, level, message, line, src) => log('renderer console:', level, message));
});

log('wrapper installed, loading main/index.js');
try {
  require('./main/index.js');
  log('main/index.js require() returned synchronously');
} catch (e) {
  log('main/index.js threw:', e && e.stack || e);
}
log('require finished — waiting for events');
