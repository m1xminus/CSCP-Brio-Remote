'use strict';
/**
 * Bridge: serves the GUI and relays desk state/commands over a WebSocket.
 *
 *   node src/server.js                       GUI only, enter the desk address in Settings
 *   node src/server.js --host 10.0.0.50 --desk-port 49200
 *   node src/server.js --mock [--wiggle]     built-in simulated desk
 *
 * By default the GUI is reachable from this computer only (127.0.0.1).
 * Use --listen 0.0.0.0 to open it to the LAN (e.g. a tablet) - anyone who can
 * reach the page can then move faders, so only do that on a trusted network.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { Desk } = require('./core/desk');
const { MockDesk } = require('./mock/mockDesk');

const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
};
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function createApp(opts = {}) {
  const o = Object.assign(
    { listen: '127.0.0.1', port: 8787, host: null, deskPort: 49200, mock: false, wiggle: false,
      configFile: path.join(ROOT, 'config.json'), levelGapMs: 100, quiet: false },
    opts
  );
  const log = (...a) => { if (!o.quiet) console.log(...a); };
  const desk = new Desk({ levelGapMs: o.levelGapMs });
  let mock = null;
  let mode = 'idle'; // idle | real | mock

  // ----------------------------------------------------------------- HTTP
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    let file;
    if (rel.startsWith('/shared/')) file = path.join(ROOT, 'src', 'shared', rel.slice(8));
    else file = path.join(ROOT, 'public', rel);
    const base = rel.startsWith('/shared/') ? path.join(ROOT, 'src', 'shared') : path.join(ROOT, 'public');
    if (!file.startsWith(base + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });

  // ------------------------------------------------------------ WebSocket
  // Reject cross-site WebSocket connections (a random web page must not be able to
  // reach a mixer through the browser). Same-origin and non-browser clients pass.
  const wss = new WebSocketServer({
    server, path: '/ws',
    verifyClient: ({ origin, req }) => {
      if (!origin) return true;
      try { return new URL(origin).host === req.headers.host; } catch { return false; }
    },
  });

  const clients = new Set();
  let outPatches = [];
  let outLogs = [];
  let flushTimer = null;
  const scheduleFlush = () => {
    if (!flushTimer) flushTimer = setTimeout(flush, 40);
  };
  function flush() {
    flushTimer = null;
    const patches = outPatches;
    const logs = outLogs;
    outPatches = [];
    outLogs = [];
    for (const c of clients) {
      if (c.readyState !== 1) continue;
      const payload = c.wantLog ? patches.concat(logs) : patches;
      if (payload.length) c.send(JSON.stringify({ t: 'batch', patches: payload }));
    }
  }
  desk.on('patches', (ps) => { outPatches.push(...ps); scheduleFlush(); });
  desk.on('log', (e) => {
    outLogs.push({ t: 'log', ts: Date.now(), ...e });
    if (outLogs.length > 800) outLogs.splice(0, outLogs.length - 800);
    scheduleFlush();
  });

  const info = () => ({ mode, host: o.host, deskPort: o.deskPort, last: loadConfig() });
  function loadConfig() {
    try { return JSON.parse(fs.readFileSync(o.configFile, 'utf8')); } catch { return {}; }
  }
  function saveConfig(c) {
    try { fs.writeFileSync(o.configFile, JSON.stringify(c, null, 2)); } catch { /* read-only dir: ignore */ }
  }

  async function stopMock() {
    if (mock) { const m = mock; mock = null; await m.close(); }
  }
  async function connectReal(host, port) {
    await stopMock();
    mode = 'real';
    desk.connect(host, port);
    saveConfig({ host, port });
    log(`connecting to Calrec at ${host}:${port}`);
  }
  async function startMock() {
    await stopMock();
    mock = new MockDesk({ wiggle: o.wiggle });
    const port = await mock.listen();
    mode = 'mock';
    desk.connect('127.0.0.1', port);
    log(`mock desk on 127.0.0.1:${port}`);
  }
  function disconnect() {
    desk.disconnect();
    mode = 'idle';
    return stopMock();
  }

  function handle(c, m) {
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'level': if (isInt(m.i, 0, 191) && isInt(m.v, 0, 1023)) desk.setFaderLevel(m.i, m.v); break;
      case 'cut': if (isInt(m.i, 0, 191) && typeof m.cut === 'boolean') desk.setFaderCut(m.i, m.cut); break;
      case 'pfl': if (isInt(m.i, 0, 191) && typeof m.on === 'boolean') desk.setFaderPfl(m.i, m.on); break;
      case 'mlevel': if (isInt(m.i, 0, 15) && isInt(m.v, 0, 1023)) desk.setMainLevel(m.i, m.v); break;
      case 'mpfl': if (isInt(m.i, 0, 15) && typeof m.on === 'boolean') desk.setMainPfl(m.i, m.on); break;
      case 'alevel': if (isInt(m.i, 0, 19) && isInt(m.v, 0, 1023)) desk.setAuxLevel(m.i, m.v); break;
      case 'auxon': if (isInt(m.aux, 0, 19) && isInt(m.fader, 0, 191) && typeof m.on === 'boolean') desk.setAuxSend(m.aux, m.fader, m.on); break;
      case 'route': if (isInt(m.main, 0, 15) && isInt(m.fader, 0, 191) && typeof m.on === 'boolean') desk.setRoute(m.main, m.fader, m.on); break;
      case 'lr': if (isInt(m.i, 0, 191) && typeof m.lb === 'boolean' && typeof m.rb === 'boolean') desk.setLR(m.i, m.lb, m.rb); break;
      case 'connect':
        if (typeof m.host === 'string' && m.host.length < 256 && isInt(m.port, 1, 65535)) connectReal(m.host.trim(), m.port);
        break;
      case 'disconnect': disconnect(); break;
      case 'mock': (m.on ? startMock() : disconnect()).catch((e) => log('mock error', e.message)); break;
      case 'resync': if (desk.client.connected) desk.resync(); break;
      case 'log': c.wantLog = !!m.on; break;
      default: break;
    }
  }

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.wantLog = false;
    ws.send(JSON.stringify({ t: 'full', state: desk.state, server: info() }));
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      try { handle(ws, m); } catch (e) { log('command error', e.message); }
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  return {
    server, desk, o,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(o.port, o.listen, resolve);
      });
      const port = server.address().port;
      if (o.mock) await startMock();
      else if (o.host) await connectReal(o.host, o.deskPort);
      return port;
    },
    async close() {
      clearTimeout(flushTimer);
      for (const c of clients) c.terminate();
      desk.close();
      await stopMock();
      await new Promise((r) => wss.close(() => r()));
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
    },
  };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--mock') o.mock = true;
    else if (a === '--wiggle') o.wiggle = true;
    else if (a === '--listen') o.listen = next();
    else if (a === '--port') o.port = Number(next());
    else if (a === '--host') o.host = next();
    else if (a === '--desk-port') o.deskPort = Number(next());
    else if (a === '--level-gap') o.levelGapMs = Number(next());
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node src/server.js [--host <desk-ip> --desk-port <tcp-port>] [--mock [--wiggle]]
                          [--port 8787] [--listen 127.0.0.1] [--level-gap 100]`);
    process.exit(0);
  }
  const app = createApp(args);
  app.listen().then((port) => {
    console.log(`CSCP Brio remote: http://${app.o.listen === '0.0.0.0' ? 'localhost' : app.o.listen}:${port}`);
  }).catch((e) => { console.error(e.message); process.exit(1); });
  const bye = () => app.close().finally(() => process.exit(0));
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = { createApp, parseArgs };
