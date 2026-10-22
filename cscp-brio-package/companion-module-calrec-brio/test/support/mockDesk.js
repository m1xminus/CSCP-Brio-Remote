'use strict';
/**
 * A small simulated Calrec desk speaking CSCP over TCP. It follows the
 * behaviour described in the protocol document:
 *   - every valid message gets an ACK, the real answer follows ~40 ms later as a WRITE
 *   - unsolicited updates only after the first valid message; full dump on first contact
 *   - writes that change state are broadcast to every active connection
 *   - VCA master cut/PFL overrides slaves, invalid routes come back with different bits
 *   - a main sitting on a fader is reachable via 7.3 (channel curve) and 7.7 (main curve)
 *   - > 3 messages inside any 20 ms window are rejected (counted in stats.rateViolations)
 * It is a development tool, not a model of the real desk's internals.
 */
const net = require('node:net');
const { StreamParser, encode, ACK, NAK, NAK_BITS, DEV_CONTROLLER } = require('../../src/lib/core/frame');
const { CMD, u16 } = require('../../src/lib/core/messages');
const Levels = require('../../src/lib/shared/levels');
const Model = require('../../src/lib/shared/model');

const NF = 192, NM = 16, NA = 20;

const READ_LEN = {
  [CMD.NAME]: 0, [CMD.INFO]: 0, [CMD.FADER_LEVEL]: 2, [CMD.FADER_CUT]: 2, [CMD.FADER_PFL]: 2,
  [CMD.FADER_LABEL]: 2, [CMD.MAIN_LEVEL]: 2, [CMD.MAIN_PFL]: 2, [CMD.MAIN_LABEL]: 2,
  [CMD.AVAIL_AUX]: 0, [CMD.ASSIGN]: 2, [CMD.AUX_ON]: 1, [CMD.AUX_LEVEL]: 2,
  [CMD.AVAIL_MAINS]: 0, [CMD.ROUTE]: 1, [CMD.LR]: 0,
};
const WRITE_LEN = {
  [CMD.FADER_LEVEL]: 4, [CMD.FADER_CUT]: 3, [CMD.MAIN_LEVEL]: 4, [CMD.FADER_PFL]: 3,
  [CMD.MAIN_PFL]: 3, [CMD.AUX_ON]: 26, [CMD.AUX_LEVEL]: 4, [CMD.ROUTE]: 26, [CMD.LR]: 48,
};

// [protocol fader, label, audio type, width, initial dB]
const PRESET = [
  [0, 'MIC 1', 1, 1, -6], [1, 'MIC 2', 1, 1, -8], [2, 'MIC 3', 1, 1, -12], [3, 'MIC 4', 1, 1, -100],
  [4, 'ATMOS', 1, 2, -14], [5, 'AMB FX', 1, 2, -20], [6, 'VT 1', 1, 2, -100], [7, 'VT 2', 1, 2, -100],
  [8, 'COMM 1', 1, 1, -10], [9, 'COMM 2', 1, 1, -10], [10, 'FX GRP', 2, 2, 0], [11, 'VCA ATM', 3, 1, 0],
  [12, 'CAM 1', 1, 1, -9], [13, 'CAM 2', 1, 1, -9], [14, 'CAM 3', 1, 1, -12], [15, 'CAM 4', 1, 1, -12],
  [16, 'CAM 5', 1, 1, -100], [17, 'CAM 6', 1, 1, -100], [18, 'EFX 1', 1, 2, -18], [19, 'EFX 2', 1, 2, -18],
  [20, 'TRK 1', 8, 2, 0], [21, 'AUXOUT', 10, 2, 0],
  [24, 'PGM', 6, 2, 0], [25, 'CLEAN', 6, 2, 0],
  // B sub-layer of a 36-fader surface starts at protocol fader 36
  [36, 'B MIC 1', 1, 1, -10], [37, 'B MIC 2', 1, 1, -10], [38, 'GRP B', 2, 2, 0],
];
const VCA_SLAVES = { 11: [4, 5] }; // master -> slaves
const MAIN_ON_FADER = { 0: 24, 1: 25 }; // main -> protocol fader carrying it
const AVAIL_MAINS = [0, 1, 2];
const AVAIL_AUX = [0, 1, 2, 3, 4, 5];
const MAIN_LABELS = ['PGM', 'CLEAN', 'IFB'];

const ascii = (s) => Array.from(Buffer.from(s, 'ascii'));
const isChGrp = (f) => f.type === 1 || f.type === 2;

function makeInitial(o) {
  const d = Model.createState();
  d.protocolFaders = NF;
  d.name = o.name;
  for (const [i, label, type, width, db] of PRESET) {
    Object.assign(d.faders[i], { label, type, width, id: 1000 + i, level: Levels.dbToLevel(db, 'ch'), cut: false });
  }
  d.faders[3].cut = true;
  d.faders[16].cut = true;
  d.faders[8].pfl = false;
  for (const m of AVAIL_MAINS) {
    Object.assign(d.mains[m], { avail: true, label: MAIN_LABELS[m], level: Levels.dbToLevel(-10, 'main') });
  }
  for (const a of AVAIL_AUX) Object.assign(d.aux[a], { avail: true, level: Levels.dbToLevel(-6, 'ch') });
  // default routing: all channels/groups to main 0, some to main 1; some aux sends
  for (let i = 0; i < NF; i++) {
    if (!isChGrp(d.faders[i])) continue;
    d.route[0] = Model.setBit(d.route[0], i, true);
    if (i >= 12 && i < 18) d.route[1] = Model.setBit(d.route[1], i, true);
    if (i < 4) d.auxOn[0] = Model.setBit(d.auxOn[0], i, true);
    if (i === 8 || i === 9) d.auxOn[1] = Model.setBit(d.auxOn[1], i, true);
  }
  d.faders[4].lb = false;
  d.faders[6].lb = true; // stereo VT 1 listening to left only (demo)
  d.memory = 1;
  return d;
}

class MockDesk {
  constructor(opts = {}) {
    this.o = Object.assign(
      { host: '127.0.0.1', port: 0, wiggle: false, ackMs: 3, replyMs: 40, name: 'BRIO-MOCK', version: 22, label: 'BRIO' },
      opts
    );
    this.d = makeInitial(this.o);
    this.socks = new Set();
    this.stats = { frames: 0, rateViolations: 0, naks: 0, writes: 0, dumps: 0 };
    this.server = null;
    this.port = null;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((s) => this._onConn(s));
      this.server.once('error', reject);
      this.server.listen(this.o.port, this.o.host, () => {
        this.port = this.server.address().port;
        if (this.o.wiggle) this._startWiggle();
        resolve(this.port);
      });
    });
  }

  close() {
    clearInterval(this._wiggle);
    for (const s of this.socks) s.destroy();
    this.socks.clear();
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** Drop every client connection (to test reconnect). */
  dropClients() {
    for (const s of this.socks) s.destroy();
  }

  /** Simulate "user memory loaded at the desk": new labels and a full re-dump to everyone. */
  loadMemory() {
    const d = this.d;
    d.memory++;
    d.faders.forEach((f, i) => {
      if (f.type) f.label = `M${d.memory}-${i}`.slice(0, 8);
    });
    this._broadcastDump();
  }

  // ------------------------------------------------------------ connection
  _onConn(sock) {
    sock.setNoDelay(true);
    sock.active = false;
    sock.times = [];
    const parser = new StreamParser();
    parser.on('frame', (f) => this._onFrame(sock, f));
    sock.on('data', (c) => parser.push(c));
    sock.on('error', () => {});
    sock.on('close', () => this.socks.delete(sock));
    this.socks.add(sock);
  }

  _send(sock, buf, delay) {
    setTimeout(() => {
      if (!sock.destroyed) sock.write(buf);
    }, delay);
  }
  _nak(sock, code) {
    this.stats.naks++;
    this._send(sock, Buffer.from([NAK, code]), this.o.ackMs);
  }
  _reply(sock, cmd, data) {
    this._send(sock, encode(0x8000 | cmd, data, DEV_CONTROLLER), this.o.replyMs);
  }
  _broadcast(cmd, data) {
    for (const s of this.socks) if (s.active) this._reply(s, cmd, data);
  }

  _onFrame(sock, f) {
    this.stats.frames++;
    const now = Date.now();
    sock.times = sock.times.filter((t) => now - t < 20);
    sock.times.push(now);
    if (sock.times.length > 3) {
      this.stats.rateViolations++;
      return this._nak(sock, NAK_BITS.undefined);
    }
    const cmd = f.cmd & 0x7fff;
    const write = (f.cmd & 0x8000) !== 0;
    const want = (write ? WRITE_LEN : READ_LEN)[cmd];
    if (want === undefined) {
      return this._nak(sock, write && READ_LEN[cmd] !== undefined ? NAK_BITS.protocol : NAK_BITS.commandNotSupported);
    }
    if (f.data.length !== want) return this._nak(sock, NAK_BITS.byteCount);

    this._send(sock, Buffer.from([ACK]), this.o.ackMs);
    const first = !sock.active;
    sock.active = true;
    let ok = true;
    try {
      ok = write ? this._handleWrite(sock, cmd, f.data) : this._handleRead(sock, cmd, f.data);
    } catch (e) {
      ok = false;
    }
    if (ok === false) this._nak(sock, NAK_BITS.undefined);
    if (first) this._dump(sock);
  }

  // ----------------------------------------------------------------- reads
  _handleRead(sock, cmd, data) {
    const msgs = this._read(cmd, data);
    if (!msgs) return false;
    for (const [c, bytes] of msgs) this._reply(sock, c, bytes);
    return true;
  }

  _read(cmd, data) {
    const d = this.d;
    const idx = (data[0] << 8) | data[1];
    switch (cmd) {
      case CMD.NAME: return [[CMD.NAME, ascii(d.name)]];
      case CMD.INFO: return [this._info()];
      case CMD.FADER_LEVEL: return idx < NF ? [this._mLevel(idx)] : null;
      case CMD.FADER_CUT: return idx < NF ? [this._mCut(idx)] : null;
      case CMD.FADER_PFL: return idx < NF ? [this._mPfl(idx)] : null;
      case CMD.FADER_LABEL: return idx < NF ? [this._mLabel(idx)] : null;
      case CMD.ASSIGN: return idx < NF ? [this._mAssign(idx)] : null;
      case CMD.MAIN_LEVEL: return idx < NM ? [this._mMainLevel(idx)] : null;
      case CMD.MAIN_PFL: return idx < NM ? [this._mMainPfl(idx)] : null;
      case CMD.MAIN_LABEL: return idx < NM ? [this._mMainLabel(idx)] : null;
      case CMD.AVAIL_AUX: return [this._mAvailAux()];
      case CMD.AVAIL_MAINS: return [this._mAvailMains()];
      case CMD.AUX_ON: return data[0] < NA ? [this._mAuxOn(data[0])] : null;
      case CMD.AUX_LEVEL: return idx < NA ? [this._mAuxLevel(idx)] : null;
      case CMD.ROUTE: return data[0] < NM ? [this._mRoute(data[0])] : null;
      case CMD.LR: return [this._mLR()];
      default: return null;
    }
  }

  // message builders (cmd, data) from desk truth
  _info() {
    const b = [...u16(this.o.version), ...u16(96), ...u16(AVAIL_MAINS.length > 0 ? 16 : 0), 0, 0, 0, 0, 0, 0];
    const lbl = ascii(this.o.label.padEnd(8, ' ').slice(0, 8));
    return [CMD.INFO, [...b, ...lbl]];
  }
  _effCut(i) {
    const f = this.d.faders[i];
    for (const [master, slaves] of Object.entries(VCA_SLAVES)) {
      if (slaves.includes(i) && this.d.faders[master].cut) return true;
    }
    return f.cut;
  }
  _effPfl(i) {
    const f = this.d.faders[i];
    for (const [master, slaves] of Object.entries(VCA_SLAVES)) {
      if (slaves.includes(i) && this.d.faders[master].pfl) return true;
    }
    return f.pfl;
  }
  _mLevel(i) { return [CMD.FADER_LEVEL, [...u16(i), ...u16(this.d.faders[i].level)]]; }
  _mCut(i) { return [CMD.FADER_CUT, [...u16(i), this._effCut(i) ? 0 : 1]]; }
  _mPfl(i) { return [CMD.FADER_PFL, [...u16(i), this._effPfl(i) ? 1 : 0]]; }
  _mLabel(i) { return [CMD.FADER_LABEL, [...u16(i), ...ascii(this.d.faders[i].label)]]; }
  _mAssign(i) {
    const f = this.d.faders[i];
    return [CMD.ASSIGN, [...u16(i), f.type, f.width, ...u16(f.id)]];
  }
  _mMainLevel(m) { return [CMD.MAIN_LEVEL, [...u16(m), ...u16(this.d.mains[m].level)]]; }
  _mMainPfl(m) { return [CMD.MAIN_PFL, [...u16(m), this.d.mains[m].pfl ? 1 : 0]]; }
  _mMainLabel(m) { return [CMD.MAIN_LABEL, [...u16(m), ...ascii(this.d.mains[m].label)]]; }
  _mAvailAux() {
    const b = [0, 0, 0, 0];
    this.d.aux.forEach((a, n) => { if (a.avail) b[n >> 3] |= 1 << (n & 7); });
    return [CMD.AVAIL_AUX, b];
  }
  _mAvailMains() {
    const b = [0, 0];
    this.d.mains.forEach((m, n) => { if (m.avail) b[n >> 3] |= 1 << (n & 7); });
    return [CMD.AVAIL_MAINS, b];
  }
  _mAuxOn(a) { return [CMD.AUX_ON, [a, 0, ...this.d.auxOn[a]]]; }
  _mAuxLevel(a) { return [CMD.AUX_LEVEL, [...u16(a), ...u16(this.d.aux[a].level)]]; }
  _mRoute(m) { return [CMD.ROUTE, [m, 0, ...this.d.route[m]]]; }
  _mLR() { return [CMD.LR, Model.packLR(this.d.faders)]; }

  // ---------------------------------------------------------------- writes
  /** @returns {boolean} false -> NAK */
  _handleWrite(sock, cmd, data) {
    this.stats.writes++;
    const d = this.d;
    const idx = (data[0] << 8) | data[1];
    const out = []; // messages describing the resulting state
    let changed = false;

    switch (cmd) {
      case CMD.FADER_LEVEL: {
        if (idx >= NF) return false;
        const lvl = Math.min(1023, (data[2] << 8) | data[3]);
        changed = d.faders[idx].level !== lvl;
        d.faders[idx].level = lvl;
        out.push(this._mLevel(idx));
        const m = Object.keys(MAIN_ON_FADER).find((k) => MAIN_ON_FADER[k] === idx);
        if (m !== undefined) {
          // fader reaches the main through the channel curve; main tops out at 0 dB
          const db = Math.min(0, Levels.levelToDb(lvl, 'ch'));
          d.mains[m].level = Levels.dbToLevel(db, 'main');
          if (Levels.levelToDb(lvl, 'ch') > 0) { d.faders[idx].level = Levels.UNITY.ch; out[0] = this._mLevel(idx); }
          out.push(this._mMainLevel(+m));
        }
        break;
      }
      case CMD.FADER_CUT: {
        if (idx >= NF) return false;
        const cut = data[2] === 0;
        const before = [idx, ...(VCA_SLAVES[idx] || [])].map((i) => this._effCut(i));
        const isSlaveOfCutMaster = Object.entries(VCA_SLAVES).some(([mst, sl]) => sl.includes(idx) && d.faders[mst].cut);
        if (!isSlaveOfCutMaster) d.faders[idx].cut = cut;
        const after = [idx, ...(VCA_SLAVES[idx] || [])].map((i) => this._effCut(i));
        changed = before.some((v, k) => v !== after[k]);
        [idx, ...(VCA_SLAVES[idx] || [])].forEach((i) => out.push(this._mCut(i)));
        break;
      }
      case CMD.FADER_PFL: {
        if (idx >= NF) return false;
        const on = data[2] !== 0;
        const group = [idx, ...(VCA_SLAVES[idx] || [])];
        const before = group.map((i) => this._effPfl(i));
        const isSlaveOfPflMaster = Object.entries(VCA_SLAVES).some(([mst, sl]) => sl.includes(idx) && d.faders[mst].pfl);
        if (!isSlaveOfPflMaster) d.faders[idx].pfl = on;
        changed = before.some((v, k) => v !== this._effPfl(group[k]));
        group.forEach((i) => out.push(this._mPfl(i)));
        break;
      }
      case CMD.MAIN_LEVEL: {
        if (idx >= NM || !d.mains[idx].avail) return false;
        const lvl = Math.min(1023, (data[2] << 8) | data[3]);
        changed = d.mains[idx].level !== lvl;
        d.mains[idx].level = lvl;
        out.push(this._mMainLevel(idx));
        const fi = MAIN_ON_FADER[idx];
        if (fi !== undefined) {
          d.faders[fi].level = Levels.dbToLevel(Levels.levelToDb(lvl, 'main'), 'ch');
          out.push(this._mLevel(fi));
        }
        break;
      }
      case CMD.MAIN_PFL: {
        if (idx >= NM || !d.mains[idx].avail) return false;
        const on = data[2] !== 0;
        changed = d.mains[idx].pfl !== on;
        d.mains[idx].pfl = on;
        out.push(this._mMainPfl(idx));
        break;
      }
      case CMD.AUX_LEVEL: {
        if (idx >= NA || !d.aux[idx].avail) return false;
        const lvl = Math.min(1023, (data[2] << 8) | data[3]);
        changed = d.aux[idx].level !== lvl;
        d.aux[idx].level = lvl;
        out.push(this._mAuxLevel(idx));
        break;
      }
      case CMD.AUX_ON: {
        const a = data[0];
        if (a >= NA || !d.aux[a].avail) return false;
        const req = Array.from(data.subarray(2, 26));
        let bytes = new Array(24).fill(0);
        for (let n = 0; n < NF; n++) {
          if (Model.bit(req, n) && isChGrp(d.faders[n])) bytes = Model.setBit(bytes, n, true); // invalid requests dropped
        }
        changed = !Model.sameBytes(bytes, d.auxOn[a]);
        d.auxOn[a] = bytes;
        out.push(this._mAuxOn(a));
        break;
      }
      case CMD.ROUTE: {
        const m = data[0];
        if (m >= NM || !d.mains[m].avail) return false;
        const req = Array.from(data.subarray(2, 26));
        let bytes = new Array(24).fill(0);
        for (let n = 0; n < NF; n++) {
          if (Model.bit(req, n) && isChGrp(d.faders[n])) bytes = Model.setBit(bytes, n, true);
        }
        changed = !Model.sameBytes(bytes, d.route[m]);
        d.route[m] = bytes;
        out.push(this._mRoute(m));
        break;
      }
      case CMD.LR: {
        const req = Array.from(data);
        let any = false;
        for (let n = 0; n < NF; n++) {
          const want = Model.unpackLR(req, n);
          const f = d.faders[n];
          const stereo = isChGrp(f) && f.width === 2;
          const lb = stereo && want.lb, rb = stereo && want.rb;
          if (f.lb !== lb || f.rb !== rb) any = true;
          f.lb = lb;
          f.rb = rb;
        }
        changed = any;
        out.push(this._mLR());
        break;
      }
      default:
        return false;
    }

    for (const [c, b] of out) {
      if (changed) this._broadcast(c, b); // state change -> every connection hears it
      else this._reply(sock, c, b); // no change -> confirmation to the requester only
    }
    return true;
  }

  // ------------------------------------------------------------------ dump
  _dumpMessages() {
    const d = this.d;
    const out = [[CMD.NAME, ascii(d.name)], this._info()];
    for (let i = 0; i < d.protocolFaders; i++) {
      out.push(this._mAssign(i), this._mLabel(i), this._mLevel(i), this._mCut(i), this._mPfl(i));
    }
    out.push(this._mAvailAux());
    for (let a = 0; a < NA; a++) out.push(this._mAuxOn(a), this._mAuxLevel(a));
    out.push(this._mAvailMains());
    for (let m = 0; m < NM; m++) out.push(this._mMainLevel(m), this._mMainPfl(m), this._mMainLabel(m), this._mRoute(m));
    out.push(this._mLR());
    return out;
  }

  _dump(sock) {
    this.stats.dumps++;
    const msgs = this._dumpMessages();
    let i = 0;
    const pump = () => {
      if (sock.destroyed) return;
      const chunk = msgs.slice(i, i + 60).map(([c, b]) => encode(0x8000 | c, b, DEV_CONTROLLER));
      if (chunk.length) sock.write(Buffer.concat(chunk));
      i += 60;
      if (i < msgs.length) setTimeout(pump, 4);
    };
    setTimeout(pump, this.o.replyMs);
  }
  _broadcastDump() {
    for (const s of this.socks) if (s.active) this._dump(s);
  }

  _startWiggle() {
    this._wiggle = setInterval(() => {
      const cand = [];
      this.d.faders.forEach((f, i) => { if (f.type === 1 && f.level > 60 && !f.cut) cand.push(i); });
      if (!cand.length) return;
      const i = cand[Math.floor(Math.random() * cand.length)];
      const f = this.d.faders[i];
      f.level = Math.max(60, Math.min(1000, f.level + Math.round((Math.random() - 0.5) * 60)));
      const [c, b] = this._mLevel(i);
      this._broadcast(c, b);
    }, 700);
  }
}

module.exports = { MockDesk, PRESET };
