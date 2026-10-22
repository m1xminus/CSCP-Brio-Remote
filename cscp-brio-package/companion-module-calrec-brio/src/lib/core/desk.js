'use strict';
/**
 * Desk = CscpClient + state mirror + echo-verified writes.
 *
 * - Everything the desk reports is folded into `state` and announced as patches.
 * - Level / bitmap writes are applied optimistically (so read-modify-write of
 *   the aux/route bitmaps is correct), then the desk's echoed WRITE is treated
 *   as the truth. If the echo disagrees (VCA override, invalid route ...) or
 *   never arrives, the item is re-read and the mirror corrected.
 */
const { EventEmitter } = require('node:events');
const { CscpClient } = require('./client');
const { R, W, decode, describe, keyOf } = require('./messages');
const { toPatches } = require('./mirror');
const Model = require('../shared/model');
const Levels = require('../shared/levels');

const ECHO_TIMEOUT_MS = 1500; // write never echoed -> re-read
const MISMATCH_SETTLE_MS = 400; // echo disagrees -> wait for in-flight echoes, then re-read

class Desk extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = Object.assign({ levelGapMs: 100 }, opts);
    this.state = Model.createState();
    this.client = new CscpClient(opts.client || {});
    this.pending = new Map();
    this.stats = { rx: 0, tx: 0, acks: 0, naks: 0, mismatches: 0, rereads: 0 };
    this._reset();
    this._wire();
  }

  // ------------------------------------------------------------ connection
  connect(host, port) {
    this.client.connect(host, port);
  }
  disconnect() {
    this.client.disconnect();
  }
  close() {
    this.client.disconnect();
    this._clearSync();
    this._clearFallback();
    this._clearPending();
  }
  get online() {
    return this.state.conn.status === 'online' || this.state.conn.status === 'syncing';
  }

  /** Re-read everything from the desk (rate limited, low priority). */
  resync() {
    this.fullRead();
  }

  fullRead() {
    const c = this.client;
    const q = (key, build) => c.enqueue({ key: `fr:${key}`, prio: 1, build });
    q('info', R.info);
    q('name', R.name);
    q('availAux', R.availAux);
    q('availMains', R.availMains);
    const n = this.state.protocolFaders;
    for (let i = 0; i < n; i++) {
      q(`as${i}`, () => R.assign(i));
      q(`lb${i}`, () => R.faderLabel(i));
      q(`lv${i}`, () => R.faderLevel(i));
      q(`ct${i}`, () => R.faderCut(i));
      q(`pf${i}`, () => R.faderPfl(i));
    }
    for (let a = 0; a < Model.NA; a++) {
      if (this.seen.availAux && !this.state.aux[a].avail) continue;
      q(`ao${a}`, () => R.auxOn(a));
      q(`al${a}`, () => R.auxLevel(a));
    }
    for (let m = 0; m < Model.NM; m++) {
      if (this.seen.availMains && !this.state.mains[m].avail) continue;
      q(`ml${m}`, () => R.mainLevel(m));
      q(`mp${m}`, () => R.mainPfl(m));
      q(`mn${m}`, () => R.mainLabel(m));
      q(`rt${m}`, () => R.route(m));
    }
    q('lr', R.lr);
    this.emit('log', { dir: 'sys', text: 'full read queued' });
  }

  // ---------------------------------------------------------------- writes
  setFaderLevel(i, level) {
    level = Levels.clampLevel(level);
    this._optimistic([{ t: 'f', i, p: { level } }]);
    this._write(`lvl:${i}`, () => W.faderLevel(i, this.state.faders[i].level), () => R.faderLevel(i),
      (m) => m.level === level, this.opts.levelGapMs);
  }
  setFaderCut(i, cut) {
    this._write(`cut:${i}`, () => W.faderCut(i, cut), () => R.faderCut(i), (m) => m.cut === cut);
  }
  setFaderPfl(i, on) {
    this._write(`pfl:${i}`, () => W.faderPfl(i, on), () => R.faderPfl(i), (m) => m.pfl === on);
  }
  setMainLevel(m, level) {
    level = Levels.clampLevel(level);
    this._optimistic([{ t: 'm', i: m, p: { level } }]);
    this._write(`mlvl:${m}`, () => W.mainLevel(m, this.state.mains[m].level), () => R.mainLevel(m),
      (x) => x.level === level, this.opts.levelGapMs);
  }
  setMainPfl(m, on) {
    this._write(`mpfl:${m}`, () => W.mainPfl(m, on), () => R.mainPfl(m), (x) => x.pfl === on);
  }
  setAuxLevel(a, level) {
    level = Levels.clampLevel(level);
    this._optimistic([{ t: 'a', i: a, p: { level } }]);
    this._write(`alvl:${a}`, () => W.auxLevel(a, this.state.aux[a].level), () => R.auxLevel(a),
      (x) => x.level === level, this.opts.levelGapMs);
  }
  /** Switch one fader's send to one aux on/off (the protocol writes the whole 192-bit map). */
  setAuxSend(aux, fader, on) {
    const want = Model.setBit(this.state.auxOn[aux], fader, on);
    this._optimistic([{ t: 'auxOn', i: aux, bytes: want }]);
    this._write(`auxon:${aux}`, () => W.auxOn(aux, this.state.auxOn[aux]), () => R.auxOn(aux),
      (m) => Model.sameBytes(m.bytes, want));
  }
  setRoute(main, fader, on) {
    const want = Model.setBit(this.state.route[main], fader, on);
    this._optimistic([{ t: 'route', i: main, bytes: want }]);
    this._write(`route:${main}`, () => W.route(main, this.state.route[main]), () => R.route(main),
      (m) => Model.sameBytes(m.bytes, want));
  }
  setLR(fader, lb, rb) {
    this._optimistic([{ t: 'f', i: fader, p: { lb: !!lb, rb: !!rb } }]);
    const want = Model.packLR(this.state.faders);
    this._write('lr', () => W.lr(Model.packLR(this.state.faders)), () => R.lr(),
      (m) => Model.sameBytes(m.bytes, want));
  }

  // -------------------------------------------------------------- internals
  _reset() {
    this.seen = { info: false, availAux: false, availMains: false, assigns: 0 };
    this.lastMsgAt = 0;
    this.connectedAt = 0;
  }

  _emitPatches(patches) {
    if (patches.length) this.emit('patches', patches);
  }
  _applyAndEmit(patches) {
    for (const p of patches) Model.applyPatch(this.state, p);
    this._emitPatches(patches);
  }
  _optimistic(patches) {
    const real = [];
    for (const p of patches) {
      // keep only changes versus current mirror
      if (p.t === 'f') {
        const cur = this.state.faders[p.i];
        const d = {};
        for (const k of Object.keys(p.p)) if (cur[k] !== p.p[k]) d[k] = p.p[k];
        if (Object.keys(d).length) real.push({ t: 'f', i: p.i, p: d });
      } else if (p.t === 'm' || p.t === 'a') {
        const cur = p.t === 'm' ? this.state.mains[p.i] : this.state.aux[p.i];
        const d = {};
        for (const k of Object.keys(p.p)) if (cur[k] !== p.p[k]) d[k] = p.p[k];
        if (Object.keys(d).length) real.push({ t: p.t, i: p.i, p: d });
      } else {
        real.push(p);
      }
    }
    this._applyAndEmit(real);
  }

  _write(key, build, read, match, gap = 0) {
    if (!this.client.connected) {
      this.emit('log', { dir: 'sys', text: `not connected - ignored write ${key}` });
      return;
    }
    const old = this.pending.get(key);
    if (old) clearTimeout(old.timer);
    this.pending.set(key, {
      match, read, timer: setTimeout(() => this._pendingExpired(key, 'no echo'), ECHO_TIMEOUT_MS),
    });
    this.client.enqueue({ key, build, prio: 0, gap });
  }

  _pendingExpired(key, why) {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    this.stats.rereads++;
    this.emit('log', { dir: 'sys', text: `${key}: ${why} - re-reading from desk` });
    this.client.enqueue({ key: `rd:${key}`, prio: 0, build: p.read });
  }

  _clearPending() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  _wire() {
    const c = this.client;
    c.on('status', (s, extra) => this._onStatus(s, extra));
    c.on('message', (m) => this._onMessage(m));
    c.on('ack', () => this.stats.acks++);
    c.on('nak', (code, names) => {
      this.stats.naks++;
      this.emit('log', { dir: 'rx', hex: `05 ${code.toString(16).padStart(2, '0')}`, text: `NAK 0x${code.toString(16)} (${names.join(', ') || 'unknown'})` });
    });
    c.on('neterror', (e) => this.emit('log', { dir: 'sys', text: `network: ${e.message}` }));
    c.on('tx', (buf, frame) => {
      this.stats.tx++;
      this.emit('log', { dir: 'tx', hex: hex(buf), text: frame ? describe(decode(frame)) : '?' });
    });
    c.on('rx', (frame, msg) => {
      this.stats.rx++;
      this.emit('log', { dir: 'rx', hex: hex(rebuild(frame)), text: describe(msg) });
    });
  }

  _conn(status) {
    const conn = { status, host: this.client.host || '', port: this.client.port || 0 };
    this._applyAndEmit([{ t: 'conn', conn }]);
  }

  _onStatus(s) {
    switch (s) {
      case 'connecting':
        this._conn('connecting');
        break;
      case 'reconnecting':
        this._clearSync();
        this._clearFallback();
        this._clearPending();
        this._conn('reconnecting');
        break;
      case 'connected':
        this._clearPending();
        this._reset();
        this.connectedAt = Date.now();
        this._applyAndEmit([{ t: 'reset' }]);
        this._conn('syncing');
        this._startSyncWatch();
        // the desk sends its whole state by itself; these cheap reads make sure the basics arrive
        for (const [k, b] of [['name', R.name], ['availAux', R.availAux], ['availMains', R.availMains]]) {
          this.client.enqueue({ key: `init:${k}`, prio: 0, build: b });
        }
        break;
      case 'disconnected':
        this._clearSync();
        this._clearFallback();
        this._clearPending();
        this._conn('offline');
        break;
      default:
        break;
    }
  }

  _startSyncWatch() {
    this._clearSync();
    this._syncTimer = setInterval(() => {
      const now = Date.now();
      const quiet = now - this.lastMsgAt > 1200 && this.seen.info;
      const sinceConnect = now - this.connectedAt;
      if (this.state.conn.status === 'syncing' && (quiet || sinceConnect > 8000) && this.seen.info) {
        this._conn('online');
        this._clearSync();
      }
    }, 250);
    // Independent of the sync watch: a desk that answers reads but never dumps by itself
    // still gets its state, via explicit reads.
    clearTimeout(this._fallbackTimer);
    this._fallbackTimer = setTimeout(() => {
      if (this.client.connected && this.seen.assigns === 0) {
        this.emit('log', { dir: 'sys', text: 'no initial dump seen - requesting full state' });
        this.fullRead();
      }
    }, 3000);
  }
  _clearSync() {
    clearInterval(this._syncTimer);
    this._syncTimer = null;
  }
  _clearFallback() {
    clearTimeout(this._fallbackTimer);
    this._fallbackTimer = null;
  }

  _onMessage(m) {
    this.lastMsgAt = Date.now();
    if (m.type === 'info') this.seen.info = true;
    if (m.type === 'availAux') this.seen.availAux = true;
    if (m.type === 'availMains') this.seen.availMains = true;
    if (m.type === 'assign') this.seen.assigns++;

    const key = keyOf(m);
    const p = key && this.pending.get(key);
    if (p) {
      clearTimeout(p.timer);
      if (p.match(m)) {
        this.pending.delete(key);
      } else {
        // Echo of an older in-flight value, or the desk overrode us. Wait, then re-read.
        this.stats.mismatches++;
        p.timer = setTimeout(() => this._pendingExpired(key, 'echo differs'), MISMATCH_SETTLE_MS);
        return;
      }
    }
    this._applyAndEmit(toPatches(this.state, m));
  }
}

const hex = (buf) => Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join(' ');
function rebuild(frame) {
  const { encode } = require('./frame');
  return encode(frame.cmd, frame.data, frame.dev);
}

module.exports = { Desk };
