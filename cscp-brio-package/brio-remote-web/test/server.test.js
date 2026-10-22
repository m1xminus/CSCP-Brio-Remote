'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { createApp } = require('../src/server');
const Model = require('../src/shared/model');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, what = 'condition') {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(15);
  }
}
const get = (port, path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
  }).on('error', reject);
});

async function boot(opts = {}) {
  const app = createApp({ port: 0, quiet: true, configFile: '/tmp/claude-0/cscp-test-config.json', ...opts });
  const port = await app.listen();
  return { app, port };
}

/** Mirror of what the browser does: keep a local state by applying batches. */
function client(port, headers) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const st = Model.createState();
  const logs = [];
  const c = { ws, st, logs, got: 0 };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    c.got++;
    if (m.t === 'full') { Model.applyPatch(st, { t: 'full', state: m.state }); c.server = m.server; }
    if (m.t === 'batch') for (const p of m.patches) (p.t === 'log' ? logs.push(p) : Model.applyPatch(st, p));
  });
  c.open = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  c.send = (o) => ws.send(JSON.stringify(o));
  return c;
}

test('serves the GUI and shared modules, blocks path traversal', async () => {
  const { app, port } = await boot();
  try {
    const idx = await get(port, '/');
    assert.equal(idx.status, 200);
    assert.match(idx.type, /text\/html/);
    assert.match(idx.body, /CSCP Brio Remote/);
    assert.equal((await get(port, '/app.js')).status, 200);
    assert.equal((await get(port, '/shared/levels.js')).status, 200);
    assert.equal((await get(port, '/shared/model.js')).status, 200);
    assert.equal((await get(port, '/nope.js')).status, 404);
    assert.notEqual((await get(port, '/..%2f..%2fpackage.json')).status, 200);
    assert.notEqual((await get(port, '/shared/..%2f..%2fpackage.json')).status, 200);
  } finally { await app.close(); }
});

test('browser mirror follows the desk and commands reach it', async () => {
  const { app, port } = await boot({ mock: true });
  const c = client(port);
  try {
    await c.open;
    await until(() => c.st.conn.status === 'online' && c.st.faders[0].label === 'MIC 1', 8000, 'synced');
    assert.equal(c.server.mode, 'mock');

    c.send({ t: 'level', i: 1, v: 700 });
    c.send({ t: 'cut', i: 0, cut: true });
    c.send({ t: 'pfl', i: 2, on: true });
    c.send({ t: 'mlevel', i: 0, v: 800 });
    c.send({ t: 'alevel', i: 1, v: 600 });
    c.send({ t: 'auxon', aux: 3, fader: 2, on: true });
    c.send({ t: 'route', main: 2, fader: 3, on: true });
    c.send({ t: 'lr', i: 4, lb: true, rb: false });
    await until(() => c.st.faders[1].level === 700 && c.st.faders[0].cut && c.st.faders[2].pfl
      && c.st.mains[0].level === 800 && c.st.aux[1].level === 600
      && Model.bit(c.st.auxOn[3], 2) && Model.bit(c.st.route[2], 3) && c.st.faders[4].lb, 5000, 'commands applied');
    // desk truth == browser mirror
    assert.deepEqual(app.desk.state.faders[1], c.st.faders[1]);
  } finally { c.ws.close(); await app.close(); }
});

test('invalid / hostile commands are ignored', async () => {
  const { app, port } = await boot({ mock: true });
  const c = client(port);
  try {
    await c.open;
    await until(() => c.st.conn.status === 'online', 8000, 'online');
    const before = app.desk.stats.tx;
    for (const bad of [
      { t: 'level', i: 999, v: 5 }, { t: 'level', i: 1, v: 5000 }, { t: 'level', i: '1', v: 5 },
      { t: 'cut', i: 1, cut: 'yes' }, { t: 'route', main: 99, fader: 1, on: true },
      { t: 'connect', host: 'x', port: 99999 }, { t: 'nonsense' }, 'junk',
    ]) c.ws.send(typeof bad === 'string' ? bad : JSON.stringify(bad));
    await sleep(300);
    assert.equal(app.desk.stats.tx, before);
  } finally { c.ws.close(); await app.close(); }
});

test('log subscription: traffic is streamed only to clients that ask', async () => {
  const { app, port } = await boot({ mock: true });
  const quiet = client(port);
  const loud = client(port);
  try {
    await Promise.all([quiet.open, loud.open]);
    loud.send({ t: 'log', on: true });
    await until(() => loud.st.conn.status === 'online', 8000, 'online');
    loud.send({ t: 'level', i: 1, v: 321 });
    await until(() => loud.logs.some((l) => l.dir === 'tx' && /fader 1 level 321/.test(l.text)), 4000, 'tx logged');
    assert.ok(loud.logs.some((l) => l.dir === 'rx' && l.hex));
    assert.equal(quiet.logs.length, 0);
  } finally { quiet.ws.close(); loud.ws.close(); await app.close(); }
});

test('two browsers stay in sync', async () => {
  const { app, port } = await boot({ mock: true });
  const a = client(port), b = client(port);
  try {
    await Promise.all([a.open, b.open]);
    await until(() => a.st.conn.status === 'online' && b.st.faders[0].label === 'MIC 1', 8000, 'synced');
    a.send({ t: 'level', i: 2, v: 612 });
    await until(() => b.st.faders[2].level === 612, 3000, 'b follows a');
  } finally { a.ws.close(); b.ws.close(); await app.close(); }
});

test('cross-site WebSocket connections are rejected, same-origin allowed', async () => {
  const { app, port } = await boot();
  try {
    const evil = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'http://evil.example' } });
    const outcome = await new Promise((res) => { evil.once('open', () => res('open')); evil.once('error', () => res('rejected')); });
    assert.equal(outcome, 'rejected');
    const ok = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    const outcome2 = await new Promise((res) => { ok.once('open', () => res('open')); ok.once('error', () => res('rejected')); });
    assert.equal(outcome2, 'open');
    ok.close();
  } finally { await app.close(); }
});

test('connect to a real (here: mock) desk by address, then disconnect', async () => {
  const { MockDesk } = require('../src/mock/mockDesk');
  const mock = new MockDesk();
  const deskPort = await mock.listen();
  const { app, port } = await boot();
  const c = client(port);
  try {
    await c.open;
    assert.equal(c.st.conn.status, 'offline');
    c.send({ t: 'connect', host: '127.0.0.1', port: deskPort });
    await until(() => c.st.conn.status === 'online', 8000, 'online');
    assert.equal(c.st.conn.port, deskPort);
    c.send({ t: 'disconnect' });
    await until(() => c.st.conn.status === 'offline', 3000, 'offline');
  } finally { c.ws.close(); await app.close(); await mock.close(); }
});
