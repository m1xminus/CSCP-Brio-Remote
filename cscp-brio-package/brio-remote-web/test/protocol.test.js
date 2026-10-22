'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encode, StreamParser, checksum, decodeNak, NAK_BITS } = require('../src/core/frame');
const { R, W, decode, CMD, keyOf } = require('../src/core/messages');
const { toPatches } = require('../src/core/mirror');
const Levels = require('../src/shared/levels');
const Model = require('../src/shared/model');

const hex = (b) => Buffer.from(b).toString('hex');

test('frame: Calrec worked example (write fader 3 to 744)', () => {
  assert.equal(hex(encode(0x8000, [0, 3, 2, 0xe8])), 'f1060080000003' + '02e8' + '93');
  assert.equal(hex(W.faderLevel(3, 744)), 'f106008000000302e893');
});

test('frame: read-info request matches the documented bytes', () => {
  assert.equal(hex(R.info()), 'f10200' + '0008' + 'f8');
});

test('frame: BC limit enforced', () => {
  assert.throws(() => encode(0x8016, new Array(49).fill(0)));
  assert.doesNotThrow(() => encode(0x8016, new Array(48).fill(0))); // 7.17 is exactly 50
  assert.equal(W.lr(new Array(48).fill(0))[1], 0x32);
  assert.equal(W.auxOn(0, new Array(24).fill(0))[1], 0x1c);
});

test('parser: reassembles frames split across arbitrary chunks, plus ACK/NAK', () => {
  const frames = [W.faderLevel(1, 100), W.faderCut(2, true), W.faderPfl(5, true)];
  const stream = Buffer.concat([Buffer.from([0x04]), ...frames, Buffer.from([0x05, 0x40])]);
  for (const chunk of [1, 2, 3, 7, stream.length]) {
    const p = new StreamParser();
    const got = { frames: [], ack: 0, nak: [] };
    p.on('frame', (f) => got.frames.push(f));
    p.on('ack', () => got.ack++);
    p.on('nak', (c) => got.nak.push(c));
    for (let i = 0; i < stream.length; i += chunk) p.push(stream.subarray(i, i + chunk));
    assert.equal(got.frames.length, 3, `chunk=${chunk}`);
    assert.equal(got.ack, 1);
    assert.deepEqual(got.nak, [0x40]);
    assert.equal(p.pending, 0);
  }
});

test('parser: resyncs after garbage and bad checksum', () => {
  const good = W.faderLevel(9, 321);
  const bad = Buffer.from(good);
  bad[bad.length - 1] ^= 0xff;
  const p = new StreamParser();
  const got = [];
  p.on('frame', (f) => got.push(decode(f)));
  p.push(Buffer.concat([Buffer.from([1, 2, 3, 0xff]), bad, good]));
  assert.equal(got.length, 1);
  assert.equal(got[0].level, 321);
  assert.ok(p.stats.badChecksum >= 1);
});

test('parser: 0xF1 inside a valid message is data', () => {
  // level 0x00F1 = 241 puts F1 in the payload
  const f = W.faderLevel(0xf1, 0xf1);
  const p = new StreamParser();
  const got = [];
  p.on('frame', (x) => got.push(decode(x)));
  p.push(f);
  assert.equal(got.length, 1);
  assert.equal(got[0].fader, 0xf1);
  assert.equal(got[0].level, 0xf1);
});

test('parser: stale partial frame can be dropped to resync', () => {
  const p = new StreamParser();
  const got = [];
  p.on('frame', (x) => got.push(x));
  const good = W.faderLevel(1, 5);
  p.push(Buffer.concat([Buffer.from([0xf1, 0x06]), good])); // false header swallowing a real one
  assert.equal(got.length, 1); // real frame found by byte-wise resync
});

test('NAK bytes seen on a real Brio (2026-10-22 probe): 0x40 unknown command, 0x05 wrong data length', () => {
  assert.deepEqual(decodeNak(0x40), ['commandNotSupported']);
  assert.deepEqual(decodeNak(0x05), ['byteCount', 'protocol']);
});

test('NAK bits decode', () => {
  assert.deepEqual(decodeNak(NAK_BITS.checksum | NAK_BITS.timeout), ['timeout', 'checksum']);
});

test('levels: anchor points from the Calrec table', () => {
  const near = (a, b, tol = 0.11) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
  near(Levels.levelToDb(760, 'ch'), 0);
  near(Levels.levelToDb(519, 'ch'), -10);
  near(Levels.levelToDb(162, 'ch'), -40);
  near(Levels.levelToDb(1004, 'ch'), 10);
  near(Levels.levelToDb(1023, 'ch'), 10);
  near(Levels.levelToDb(340, 'ch'), -25.1);
  near(Levels.levelToDb(600, 'ch'), -6.7);
  near(Levels.levelToDb(880, 'ch'), 4.9);
  near(Levels.levelToDb(760, 'main'), -10);
  near(Levels.levelToDb(1004, 'main'), 0);
  near(Levels.levelToDb(400, 'main'), -30);
  assert.equal(Levels.levelToDb(0, 'ch'), -100);
});

test('levels: dB <-> level round trip and off thresholds', () => {
  for (const c of ['ch', 'main']) {
    for (let v = 60; v <= 1004; v += 7) {
      const back = Levels.dbToLevel(Levels.levelToDb(v, c), c);
      assert.ok(Math.abs(back - v) <= 1, `${c} ${v}->${back}`);
    }
  }
  assert.ok(Levels.isOff(49, 'ch') && !Levels.isOff(50, 'ch'));
  assert.ok(Levels.isOff(42, 'main') && !Levels.isOff(43, 'main'));
  assert.equal(Levels.formatDb(0, 'ch'), '-∞');
  assert.equal(Levels.formatDb(760, 'ch'), '0.0');
  assert.equal(Levels.formatDb(1004, 'ch'), '+10.0');
  assert.equal(Levels.dbToLevel(0, 'ch'), Levels.UNITY.ch);
  assert.equal(Levels.dbToLevel(0, 'main'), Levels.UNITY.main);
});

test('messages: decode of every read/write form', () => {
  const frameOf = (buf) => ({ cmd: (buf[3] << 8) | buf[4], data: buf.subarray(5, 3 + buf[1]) });
  assert.deepEqual(decode(frameOf(W.faderLevel(7, 1000))), { type: 'faderLevel', fader: 7, level: 1000 });
  assert.deepEqual(decode(frameOf(W.faderCut(7, true))), { type: 'faderCut', fader: 7, cut: true });
  assert.deepEqual(decode(frameOf(W.faderCut(7, false))), { type: 'faderCut', fader: 7, cut: false });
  assert.deepEqual(decode(frameOf(W.faderPfl(7, true))), { type: 'faderPfl', fader: 7, pfl: true });
  assert.deepEqual(decode(frameOf(W.mainLevel(2, 500))), { type: 'mainLevel', main: 2, level: 500 });
  assert.deepEqual(decode(frameOf(W.mainPfl(2, true))), { type: 'mainPfl', main: 2, pfl: true });
  assert.deepEqual(decode(frameOf(W.auxLevel(4, 900))), { type: 'auxLevel', aux: 4, level: 900 });
  const bytes = Model.setBit(new Array(24).fill(0), 191, true);
  const aux = decode(frameOf(W.auxOn(3, bytes)));
  assert.equal(aux.aux, 3);
  assert.equal(aux.bytes[23], 0x80);
  assert.equal(decode(frameOf(W.route(1, bytes))).main, 1);
  assert.equal(decode(frameOf(R.faderLevel(1))).type, 'unknown'); // a read request has no payload to decode as a value
});

test('messages: ASCII labels tolerate zero termination and padding', () => {
  const f = { cmd: 0x800b, data: Buffer.from([0, 4, 0x4d, 0x49, 0x43, 0x20, 0x31, 0x00, 0x00]) };
  assert.deepEqual(decode(f), { type: 'faderLabel', fader: 4, label: 'MIC 1' });
});

test('messages: console info layout', () => {
  const data = Buffer.from([0, 22, 0, 96, 0, 16, 0, 0, 0, 0, 0, 0, ...Buffer.from('BRIO    ')]);
  assert.deepEqual(decode({ cmd: 0x8008, data }), { type: 'info', version: 22, maxFaders: 96, maxMains: 16, label: 'BRIO' });
});

test('messages: pending-write keys are shared between request and echo', () => {
  assert.equal(keyOf({ type: 'faderLevel', fader: 3 }), 'lvl:3');
  assert.equal(keyOf({ type: 'auxOn', aux: 2 }), 'auxon:2');
  assert.equal(keyOf({ type: 'route', main: 1 }), 'route:1');
  assert.equal(keyOf({ type: 'lr' }), 'lr');
  assert.equal(keyOf({ type: 'info' }), null);
});

test('model: bitmap bit order (fader 0 = LSB of byte 0, fader 191 = MSB of byte 23)', () => {
  let b = new Array(24).fill(0);
  b = Model.setBit(b, 0, true);
  b = Model.setBit(b, 9, true);
  b = Model.setBit(b, 191, true);
  assert.deepEqual([b[0], b[1], b[23]], [1, 2, 0x80]);
  assert.ok(Model.bit(b, 9) && !Model.bit(b, 10));
  assert.ok(!Model.bit(Model.setBit(b, 9, false), 9));
});

test('model: L>B / R>B packing (4 faders per byte, L low bit, R high bit)', () => {
  const st = Model.createState();
  st.faders[0].lb = true; // byte0 bit0
  st.faders[1].rb = true; // byte0 bit3
  st.faders[3].lb = true; st.faders[3].rb = true; // byte0 bits 6,7
  st.faders[191].rb = true; // byte47 bit7
  const b = Model.packLR(st.faders);
  assert.equal(b.length, 48);
  assert.equal(b[0], 0b11001001);
  assert.equal(b[47], 0x80);
  assert.deepEqual(Model.unpackLR(b, 1), { lb: false, rb: true });
});

test('model: surface layout follows the Calrec allocation example', () => {
  // example from the doc: 16 surface faders, B layer on
  assert.deepEqual(Model.surfaceOf(0, 16, false), { layer: 1, sub: 'A', pos: 0 });
  assert.deepEqual(Model.surfaceOf(15, 16, false), { layer: 1, sub: 'A', pos: 15 });
  assert.deepEqual(Model.surfaceOf(16, 16, false), { layer: 1, sub: 'B', pos: 0 });
  assert.deepEqual(Model.surfaceOf(32, 16, false), { layer: 2, sub: 'A', pos: 0 });
  assert.deepEqual(Model.surfaceOf(191, 16, false), { layer: 6, sub: 'B', pos: 15 });
  // B layer off: protocol 16 -> layer 2 A
  assert.deepEqual(Model.surfaceOf(16, 16, true), { layer: 2, sub: 'A', pos: 0 });
  assert.deepEqual(Model.surfaceOf(191, 16, true), { layer: 12, sub: 'A', pos: 15 });
  for (const bOff of [false, true]) {
    for (let p = 0; p < 192; p++) {
      const s = Model.surfaceOf(p, 12, bOff);
      assert.equal(Model.protocolIndex(s.layer, s.sub, s.pos, 12, bOff), p);
    }
  }
  assert.equal(Model.layerCount(192, 16, false), 6);
  assert.equal(Model.layerCount(192, 16, true), 12);
});

test('mirror: duplicate responses produce no patches', () => {
  const st = Model.createState();
  const m = { type: 'faderLevel', fader: 2, level: 700 };
  const first = toPatches(st, m);
  assert.equal(first.length, 1);
  for (const p of first) Model.applyPatch(st, p);
  assert.equal(toPatches(st, m).length, 0);
  assert.equal(toPatches(st, { type: 'faderLevel', fader: 999, level: 1 }).length, 0); // out of range ignored
});

test('mirror: info message sets the protocol fader count (half-reported)', () => {
  const st = Model.createState();
  const [p] = toPatches(st, { type: 'info', version: 22, maxFaders: 48, maxMains: 16, label: 'X' });
  Model.applyPatch(st, p);
  assert.equal(st.protocolFaders, 96);
});

// Rows copied from the Appendix "Protocol Level to dB conversion table" of the Calrec CSCP
// document (rev 2.10): [protocol value, main dB, channel dB].
// Row 100 is excluded: the doc lists main = -67.2 there, a typo (neighbours give -65.2).
const CALREC_TABLE = [
  [0, -100.0, -100.0], [41, -99.3, -99.0], [45, -96.3, -95.0], [46, -95.5, -94.0], [60, -85.0, -80.0],
  [80, -70.0, -60.0], [81, -69.8, -59.8], [121, -60.0, -50.0], [162, -50.0, -40.0], [163, -50.0, -40.0],
  [200, -46.9, -36.9], [281, -40.0, -30.0], [340, -35.1, -25.1], [400, -30.0, -20.0], [460, -25.0, -15.0],
  [519, -20.0, -10.0], [520, -20.0, -10.0], [600, -16.7, -6.7], [640, -15.0, -5.0], [700, -12.5, -2.5],
  [740, -10.9, -0.9], [760, -10.0, 0.0], [800, -8.4, 1.6], [882, -5.0, 5.0], [931, -3.0, 7.0],
  [974, -1.3, 8.7], [981, -1.0, 9.0], [1004, 0.0, 10.0], [1011, 0.0, 10.0], [1023, 0.0, 10.0],
];

test('levels: sampled rows of the Calrec appendix table (max error 0.11 dB)', () => {
  for (const [v, main, ch] of CALREC_TABLE) {
    assert.ok(Math.abs(Levels.levelToDb(v, 'main') - main) <= 0.11, `main ${v}: ${Levels.levelToDb(v, 'main').toFixed(2)} vs ${main}`);
    assert.ok(Math.abs(Levels.levelToDb(v, 'ch') - ch) <= 0.11, `ch ${v}: ${Levels.levelToDb(v, 'ch').toFixed(2)} vs ${ch}`);
  }
});
