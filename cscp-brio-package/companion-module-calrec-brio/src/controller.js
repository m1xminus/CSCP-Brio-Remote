'use strict';
/**
 * Everything the module can do to the desk, in plain functions (no Companion types).
 * Actions, presets and the HTTP handler all go through here.
 *
 * Numbering: faders are named like the desk ("A8", "B12", see addressing.js); mains and auxes are
 * numbered from 1 (as on the desk), internally they are 0 based.
 * Levels are given in dB; fades move the fader in steps of 100 ms (the desk accepts at most
 * 10 level updates per second per fader), in fader-travel terms - like moving the fader by hand.
 */
const { EventEmitter } = require('node:events');
const { Desk } = require('./lib/core/desk');
const Levels = require('./lib/shared/levels');
const Model = require('./lib/shared/model');
const { Addressing } = require('./addressing');

const STEP_MS = 100;
const GROUP_TYPES = [2, 3, 5];
const MAX_FADE_MS = 120000;

class Controller extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.desk = opts.desk || new Desk({ levelGapMs: STEP_MS });
    this.addr = new Addressing();
    this.cfg = {};
    this.timers = new Map(); // ramp / delayed step per target, so a new command replaces the old one
    this.saved = new Map(); // level before a "cut via level", to restore on "on"
    this.desk.on('patches', (patches) => {
      if (patches.some((p) => p.t === 'info' || p.t === 'reset')) this.configure(this.cfg);
      this.emit('patches', patches);
    });
    this.desk.on('log', (l) => this.emit('log', l));
  }

  get state() {
    return this.desk.state;
  }

  configure(cfg = {}) {
    this.cfg = cfg;
    this.addr.configure(cfg, this.state.protocolFaders);
    this.emit('layout');
  }

  connect(host, port) {
    this.desk.connect(host, port);
  }

  close() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.desk.close();
  }

  // ------------------------------------------------------------- resolving
  /** "A8", "B12", "p12" or the fader's label on the desk (case-insensitive) -> protocol index. */
  faderIndex(ref) {
    let i = this.addr.parse(ref);
    if (i < 0 && ref !== undefined && ref !== null && String(ref).trim()) {
      const want = String(ref).trim().toLowerCase();
      const hit = this.addr.list.find((e) => this.state.faders[e.index].label.trim().toLowerCase() === want);
      if (hit) i = hit.index;
    }
    if (i < 0) throw new Error(`Unknown fader "${ref}" (use names like A8 or B12)`);
    return i;
  }
  /** A group = group fader, VCA master, or a group that is slaved to a VCA (7.11 audio types 2, 3, 5). */
  isGroup(i) {
    return GROUP_TYPES.includes(this.state.faders[i].type);
  }
  groupList() {
    return this.addr.list.filter((e) => this.isGroup(e.index));
  }
  /** Same names as faders ("A11", a desk label ...), but it must be a group or VCA master. */
  groupIndex(ref) {
    const i = this.faderIndex(ref);
    if (!this.isGroup(i)) throw new Error(`"${ref}" is not a group or VCA master on this desk`);
    return i;
  }
  mainIndex(n) {
    const m = Math.round(Number(n)) - 1;
    if (!(m >= 0 && m < Model.NM)) throw new Error(`Unknown main "${n}"`);
    if (this.desk.seen.availMains && !this.state.mains[m].avail) throw new Error(`Main ${n} is not available on this desk`);
    return m;
  }
  auxIndex(n) {
    const a = Math.round(Number(n)) - 1;
    if (!(a >= 0 && a < Model.NA)) throw new Error(`Unknown aux "${n}"`);
    if (this.desk.seen.availAux && !this.state.aux[a].avail) throw new Error(`Aux ${n} is not available on this desk`);
    return a;
  }

  // -------------------------------------------------- level plumbing (kind: f | m | a)
  _item(kind, i) {
    return kind === 'f' ? this.state.faders[i] : kind === 'm' ? this.state.mains[i] : this.state.aux[i];
  }
  _write(kind, i, level) {
    if (kind === 'f') this.desk.setFaderLevel(i, level);
    else if (kind === 'm') this.desk.setMainLevel(i, level);
    else this.desk.setAuxLevel(i, level);
  }
  _curve(kind) {
    return kind === 'm' ? 'main' : 'ch';
  }

  _cancel(key) {
    const t = this.timers.get(key);
    if (t) {
      clearTimeout(t);
      clearInterval(t);
      this.timers.delete(key);
    }
  }
  _later(key, ms, fn) {
    this._cancel(key);
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); fn(); }, ms));
  }

  /** Move kind/i from where it is to `to` over `ms`; a new move on the same target replaces this one. */
  _move(kind, i, to, ms, done) {
    const key = kind + i;
    this._cancel(key);
    ms = Math.min(Math.max(0, Number(ms) || 0), MAX_FADE_MS);
    const from = this._item(kind, i).level;
    if (ms <= 0 || from === to) {
      this._write(kind, i, to);
      if (done) done();
      return;
    }
    const steps = Math.max(1, Math.round(ms / STEP_MS));
    let k = 0;
    const timer = setInterval(() => {
      k++;
      this._write(kind, i, Math.round(from + ((to - from) * k) / steps));
      if (k >= steps) {
        this._cancel(key);
        if (done) done();
      }
    }, STEP_MS);
    this.timers.set(key, timer);
  }

  _setDb(kind, i, db, ms) {
    const d = Number(db);
    if (!Number.isFinite(d)) throw new Error(`"${db}" is not a level in dB`);
    this._move(kind, i, Levels.dbToLevel(d, this._curve(kind)), ms);
  }

  _step(kind, i, stepDb) {
    const s = Number(stepDb);
    if (!Number.isFinite(s)) throw new Error(`"${stepDb}" is not a step in dB`);
    const curve = this._curve(kind);
    const cur = this._item(kind, i).level;
    const wasOff = Levels.isOff(cur, curve);
    let db = (wasOff ? -100 : Levels.levelToDb(cur, curve)) + s;
    if (wasOff && s > 0) db = Math.max(db, -90); // first audible position
    let to = Levels.dbToLevel(db, curve);
    if (Levels.isOff(to, curve)) to = 0;
    this._cancel(kind + i);
    this._write(kind, i, to);
  }

  /** "Cut" for things that have no cut in CSCP (mains, aux masters): drop to off and remember the level. */
  _muteViaLevel(kind, i, mode, ms) {
    const curve = this._curve(kind);
    const key = kind + i;
    const cur = this._item(kind, i).level;
    const isOff = Levels.isOff(cur, curve);
    const wantOff = mode === 'toggle' ? !isOff : mode === 'off';
    if (wantOff && !isOff) {
      this.saved.set(key, cur);
      this._move(kind, i, 0, ms);
    } else if (!wantOff && isOff) {
      const unity = Levels.UNITY[curve];
      this._move(kind, i, this.saved.get(key) ?? unity, ms);
    }
  }

  // ---------------------------------------------------------------- faders
  setFaderDb(ref, db, fadeMs = 0) {
    this._setDb('f', this.faderIndex(ref), db, fadeMs);
  }
  stepFader(ref, stepDb) {
    this._step('f', this.faderIndex(ref), stepDb);
  }
  /** mode: cut | on | toggle */
  faderCut(ref, mode) {
    const i = this.faderIndex(ref);
    const cut = mode === 'toggle' ? !this.state.faders[i].cut : mode === 'cut';
    this._cancel('f' + i);
    this.desk.setFaderCut(i, cut);
  }
  /** mode: on | off | toggle */
  faderPfl(ref, mode) {
    const i = this.faderIndex(ref);
    this.desk.setFaderPfl(i, mode === 'toggle' ? !this.state.faders[i].pfl : mode === 'on');
  }
  /** Un-cut and fade up to `db`. A cut fader starts from silence so nothing jumps in. */
  openFader(ref, db = 0, fadeMs = 0, fromSilence = true) {
    const i = this.faderIndex(ref);
    const d = Number(db);
    if (!Number.isFinite(d)) throw new Error(`"${db}" is not a level in dB`);
    const to = Levels.dbToLevel(d, 'ch');
    const wasCut = this.state.faders[i].cut;
    this._cancel('f' + i);
    if (wasCut && fromSilence && fadeMs > 0) {
      this.desk.setFaderLevel(i, 0);
      this._later('f' + i, 150, () => {
        this.desk.setFaderCut(i, false);
        this._move('f', i, to, fadeMs);
      });
    } else {
      if (wasCut) this.desk.setFaderCut(i, false);
      this._move('f', i, to, fadeMs);
    }
  }
  /** Fade down to off, then cut. */
  closeFader(ref, fadeMs = 0) {
    const i = this.faderIndex(ref);
    this._move('f', i, 0, fadeMs, () => this.desk.setFaderCut(i, true));
  }

  // ----------------------------------------------------------------- mains
  setMainDb(n, db, fadeMs = 0) {
    this._setDb('m', this.mainIndex(n), db, fadeMs);
  }
  stepMain(n, stepDb) {
    this._step('m', this.mainIndex(n), stepDb);
  }
  /** mode: off | on | toggle (there is no main cut in CSCP, so this is level based) */
  mainOff(n, mode, fadeMs = 0) {
    this._muteViaLevel('m', this.mainIndex(n), mode, fadeMs);
  }
  /** Fade up to `db` (default 0). Mains have no cut, so "open" is a level move. */
  openMain(n, db = 0, fadeMs = 0) {
    const m = this.mainIndex(n);
    this.saved.delete('m' + m);
    this._setDb('m', m, db, fadeMs);
  }
  closeMain(n, fadeMs = 0) {
    this._move('m', this.mainIndex(n), 0, fadeMs);
  }
  mainPfl(n, mode) {
    const m = this.mainIndex(n);
    this.desk.setMainPfl(m, mode === 'toggle' ? !this.state.mains[m].pfl : mode === 'on');
  }

  // ------------------------------------------------------------ aux masters
  setAuxDb(n, db, fadeMs = 0) {
    this._setDb('a', this.auxIndex(n), db, fadeMs);
  }
  stepAux(n, stepDb) {
    this._step('a', this.auxIndex(n), stepDb);
  }
  /** mode: off | on | toggle (the aux master has no cut in CSCP, so this is level based) */
  auxOff(n, mode, fadeMs = 0) {
    this._muteViaLevel('a', this.auxIndex(n), mode, fadeMs);
  }

  openAux(n, db = 0, fadeMs = 0) {
    const a = this.auxIndex(n);
    this.saved.delete('a' + a);
    this._setDb('a', a, db, fadeMs);
  }
  closeAux(n, fadeMs = 0) {
    this._move('a', this.auxIndex(n), 0, fadeMs);
  }

  // ---------------------------------------------------------------- routing
  /** mode: on | off | toggle */
  auxSend(ref, auxN, mode) {
    const i = this.faderIndex(ref);
    const a = this.auxIndex(auxN);
    this.desk.setAuxSend(a, i, mode === 'toggle' ? !Model.bit(this.state.auxOn[a], i) : mode === 'on');
  }
  routeMain(ref, mainN, mode) {
    const i = this.faderIndex(ref);
    const m = this.mainIndex(mainN);
    this.desk.setRoute(m, i, mode === 'toggle' ? !Model.bit(this.state.route[m], i) : mode === 'on');
  }
  /** leg: lb | rb */
  lrLeg(ref, leg, mode) {
    const i = this.faderIndex(ref);
    const f = this.state.faders[i];
    const want = mode === 'toggle' ? !f[leg] : mode === 'on';
    this.desk.setLR(i, leg === 'lb' ? want : f.lb, leg === 'rb' ? want : f.rb);
  }

  // ----------------------------------------------------------- read helpers
  faderDb(i) {
    return Levels.formatDb(this.state.faders[i].level, 'ch');
  }
  mainDbText(m) {
    return Levels.formatDb(this.state.mains[m].level, 'main');
  }
  auxDbText(a) {
    return Levels.formatDb(this.state.aux[a].level, 'ch');
  }
  faderIsOpen(i) {
    const f = this.state.faders[i];
    return !f.cut && !Levels.isOff(f.level, 'ch');
  }
  get online() {
    return this.desk.state.conn.status === 'online';
  }
}

module.exports = { Controller, STEP_MS };
