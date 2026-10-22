'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Desk } = require('../src/core/desk');
const { MockDesk } = require('../src/mock/mockDesk');
const Levels = require('../src/shared/levels');
const Model = require('../src/shared/model');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, what = 'condition') {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

async function setup(deskOpts = {}) {
  const mock = new MockDesk();
  const port = await mock.listen();
  const desk = new Desk(deskOpts);
  desk.connect('127.0.0.1', port);
  await until(() => desk.state.conn.status === 'online', 6000, 'online');
  return { mock, desk, port, done: async () => { desk.close(); await mock.close(); } };
}

test('connect: mirror is built from the desk dump', async () => {
  const { desk, done } = await setup();
  try {
    assert.equal(desk.state.info.version, 22);
    assert.equal(desk.state.protocolFaders, 192);
    assert.equal(desk.state.faders[0].label, 'MIC 1');
    assert.equal(desk.state.faders[11].type, 3); // VCA master
    assert.equal(desk.state.faders[4].width, 2);
    assert.deepEqual(desk.state.mains.filter((m) => m.avail).map((m) => m.label), ['PGM', 'CLEAN', 'IFB']);
    assert.equal(desk.state.aux.filter((a) => a.avail).length, 6);
    assert.ok(Model.bit(desk.state.route[0], 0));
    assert.ok(Model.bit(desk.state.auxOn[0], 1));
    assert.equal(desk.state.faders[3].cut, true);
    assert.ok(desk.stats.rx > 1000, `rx=${desk.stats.rx}`);
  } finally { await done(); }
});

test('writes: level / cut / pfl are echoed by the desk and mirrored', async () => {
  const { desk, mock, done } = await setup();
  try {
    desk.setFaderLevel(1, 650);
    desk.setFaderCut(0, true);
    desk.setFaderPfl(2, true);
    await until(() => desk.pending.size === 0, 3000, 'echoes');
    assert.equal(mock.d.faders[1].level, 650);
    assert.equal(mock.d.faders[0].cut, true);
    assert.equal(desk.state.faders[0].cut, true);
    assert.equal(desk.state.faders[2].pfl, true);
    desk.setFaderCut(0, false);
    await until(() => desk.state.faders[0].cut === false, 3000, 'uncut');
  } finally { await done(); }
});

test('writes: mains and aux masters', async () => {
  const { desk, mock, done } = await setup();
  try {
    desk.setMainLevel(1, 800);
    desk.setMainPfl(1, true);
    desk.setAuxLevel(3, 555);
    await until(() => desk.pending.size === 0, 3000, 'echoes');
    assert.equal(mock.d.mains[1].level, 800);
    assert.equal(desk.state.mains[1].pfl, true);
    assert.equal(desk.state.aux[3].level, 555);
  } finally { await done(); }
});

test('main on a fader: both 7.3 (channel curve) and 7.7 (main curve) are kept in step', async () => {
  const { desk, done } = await setup();
  try {
    desk.setFaderLevel(24, Levels.UNITY.ch); // 0 dB on the channel curve -> main 0 dB
    await until(() => desk.state.mains[0].level === Levels.UNITY.main, 3000, 'main follows fader');
    desk.setMainLevel(0, Levels.dbToLevel(-20, 'main'));
    await until(() => Math.abs(Levels.levelToDb(desk.state.faders[24].level, 'ch') - -20) < 0.5, 3000, 'fader follows main');
  } finally { await done(); }
});

test('aux send / route / L>B are read-modify-write on the whole bitmap, rapid toggles survive', async () => {
  const { desk, mock, done } = await setup();
  try {
    desk.setAuxSend(2, 5, true);
    desk.setAuxSend(2, 6, true);
    desk.setAuxSend(2, 7, true);
    desk.setRoute(1, 0, true);
    desk.setRoute(1, 1, true);
    desk.setLR(5, true, false);
    desk.setLR(5, true, true);
    await until(() => desk.pending.size === 0, 3000, 'echoes');
    await sleep(150);
    for (const n of [5, 6, 7]) assert.ok(Model.bit(mock.d.auxOn[2], n), `aux2 fader ${n}`);
    assert.ok(Model.bit(mock.d.route[1], 0) && Model.bit(mock.d.route[1], 1));
    assert.deepEqual([mock.d.faders[5].lb, mock.d.faders[5].rb], [true, true]);
    for (const n of [5, 6, 7]) assert.ok(Model.bit(desk.state.auxOn[2], n));
    assert.deepEqual([desk.state.faders[5].lb, desk.state.faders[5].rb], [true, true]);
  } finally { await done(); }
});

test('desk rules: invalid route is corrected by the echo; VCA master cut overrides slaves', async () => {
  const { desk, done } = await setup();
  try {
    desk.setAuxSend(0, 22, true); // fader 22 has no audio: desk drops the bit
    await until(() => desk.stats.rereads > 0 || (desk.pending.size === 0 && !Model.bit(desk.state.auxOn[0], 22)), 3000, 'correction');
    await until(() => desk.pending.size === 0 && !Model.bit(desk.state.auxOn[0], 22), 3000, 'bit cleared');

    desk.setFaderCut(11, true); // VCA master
    await until(() => desk.state.faders[11].cut && desk.state.faders[4].cut && desk.state.faders[5].cut, 3000, 'slaves cut');
    desk.setFaderCut(4, false); // slave cannot be uncut while the master is cut
    await sleep(900);
    assert.equal(desk.state.faders[4].cut, true);
    desk.setFaderCut(11, false);
    await until(() => !desk.state.faders[4].cut, 3000, 'slave released');
  } finally { await done(); }
});

test('rate limit: a flood of writes never exceeds 3 messages per 20 ms at the desk', async () => {
  const { desk, mock, done } = await setup();
  try {
    // Police the SENDER with a high-resolution clock: no sliding 20 ms span may hold > 3 frames.
    const tx = [];
    desk.client.on('tx', () => tx.push(Number(process.hrtime.bigint()) / 1e6));
    const before = mock.stats.frames;
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 24; i++) desk.setFaderLevel(i, 100 + round * 100 + i);
      for (let i = 0; i < 12; i++) desk.setFaderCut(i, round % 2 === 0);
    }
    await until(() => desk.pending.size === 0, 8000, 'echoes');
    let j = 0, worst = 0;
    for (let i = 0; i < tx.length; i++) {
      while (tx[i] - tx[j] >= 20) j++;
      worst = Math.max(worst, i - j + 1);
    }
    assert.ok(tx.length > 30, `only ${tx.length} frames observed`);
    assert.ok(worst <= 3, `sender put ${worst} frames inside a 20 ms span`);
    assert.equal(mock.stats.rateViolations, 0);
    assert.equal(mock.stats.naks, 0);
    // coalescing: 6 rounds x 24 level writes collapse to far fewer frames
    const sentLevels = mock.stats.frames - before;
    assert.ok(sentLevels < 6 * 36, `frames sent ${sentLevels}`);
    assert.equal(mock.d.faders[3].level, 600 + 3);
  } finally { await done(); }
});

test('per-fader level rate cap: a fader being dragged is limited to ~10 values/s', async () => {
  const { desk, mock, done } = await setup({ levelGapMs: 100 });
  try {
    const before = mock.stats.writes;
    const t0 = Date.now();
    for (let v = 100; v < 700; v += 3) { desk.setFaderLevel(8, v); await sleep(5); }
    await until(() => desk.pending.size === 0, 5000, 'settled');
    const secs = (Date.now() - t0) / 1000;
    const writes = mock.stats.writes - before;
    assert.ok(writes / secs <= 12, `${writes} writes in ${secs.toFixed(2)}s`);
    assert.equal(mock.d.faders[8].level, 697); // trailing value always arrives
  } finally { await done(); }
});

test('unsolicited updates from the desk surface are mirrored (and duplicates ignored)', async () => {
  const { desk, mock, done } = await setup();
  try {
    const seen = [];
    desk.on('patches', (ps) => seen.push(...ps));
    mock.d.faders[2].level = 321;
    const [c, b] = mock._mLevel(2);
    mock._broadcast(c, b);
    mock._broadcast(c, b); // duplicate (redundant master / serial box)
    await until(() => desk.state.faders[2].level === 321, 2000, 'unsolicited');
    await sleep(100);
    assert.equal(seen.filter((p) => p.t === 'f' && p.i === 2).length, 1);
  } finally { await done(); }
});

test('memory load on the desk re-dumps everything and the mirror follows', async () => {
  const { desk, mock, done } = await setup();
  try {
    mock.loadMemory();
    await until(() => desk.state.faders[0].label === 'M2-0', 4000, 'new labels');
    assert.equal(desk.state.faders[1].label, 'M2-1');
  } finally { await done(); }
});

test('reconnect: connection loss is detected, mirror is rebuilt, writes work again', async () => {
  const mock = new MockDesk();
  const port = await mock.listen();
  const desk = new Desk({ client: { backoffMs: [100, 200] } });
  try {
    desk.connect('127.0.0.1', port);
    await until(() => desk.state.conn.status === 'online', 6000, 'online');
    const statuses = [];
    desk.on('patches', (ps) => ps.forEach((p) => p.t === 'conn' && statuses.push(p.conn.status)));
    mock.dropClients();
    await until(() => desk.state.conn.status === 'reconnecting', 3000, 'reconnecting');
    await until(() => desk.state.conn.status === 'online', 8000, 'online again');
    assert.ok(statuses.includes('reconnecting') && statuses.includes('syncing'));
    assert.equal(desk.state.faders[0].label, 'MIC 1');
    desk.setFaderLevel(0, 444);
    await until(() => desk.pending.size === 0, 3000, 'echo');
    assert.equal(mock.d.faders[0].level, 444);
  } finally { desk.close(); await mock.close(); }
});

test('writes while offline are ignored, not queued', async () => {
  const desk = new Desk();
  desk.setFaderLevel(1, 100);
  assert.equal(desk.pending.size, 0);
  desk.close();
});

test('fallback: if the desk never dumps by itself, a full read is requested', async () => {
  const mock = new MockDesk();
  mock._dump = () => {}; // desk that stays silent until asked
  const port = await mock.listen();
  const desk = new Desk();
  const logs = [];
  desk.on('log', (e) => logs.push(e.text));
  try {
    desk.connect('127.0.0.1', port);
    await until(() => desk.state.faders[0].label === 'MIC 1', 15000, 'full read');
    assert.ok(logs.some((t) => /requesting full state/.test(t)));
    assert.equal(mock.stats.rateViolations, 0);
  } finally { desk.close(); await mock.close(); }
});
