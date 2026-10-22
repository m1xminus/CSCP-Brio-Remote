'use strict';
/**
 * Fader names the way you see them on the desk: "A8" = layer A, fader 8 (of the controlled faders).
 * Layer 1 uses plain "A8" / "B8"; extra layers (if enabled in the config) are "L2A8", "L3B12" ...
 * "p12" always means protocol fader #12 (0 based), a bare number means "A<number>".
 */
const Model = require('./lib/shared/model');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.round(Number(v)) : d);

class Addressing {
  constructor() {
    this.configure({});
  }

  configure(cfg = {}, protocolFaders = Model.NF) {
    this.N = clamp(int(cfg.surfaceFaders, 36), 1, 96);
    this.layers = clamp(int(cfg.layers, 1), 1, 12);
    this.bOff = !!cfg.bLayerOff;
    this.limit = clamp(int(protocolFaders, Model.NF), 1, Model.NF);
    this.list = [];
    this.byId = new Map();
    this.byIndex = new Map();
    const subs = this.bOff ? ['A'] : ['A', 'B'];
    for (let layer = 1; layer <= this.layers; layer++) {
      for (const sub of subs) {
        for (let pos = 0; pos < this.N; pos++) {
          const index = Model.protocolIndex(layer, sub, pos, this.N, this.bOff);
          if (index >= this.limit) continue;
          const id = (layer === 1 ? '' : `L${layer}`) + `${sub}${pos + 1}`;
          const e = { id, index, layer, sub, pos };
          this.list.push(e);
          this.byId.set(id, e);
          this.byIndex.set(index, e);
        }
      }
    }
  }

  /** Name or number -> protocol fader index, or -1. */
  parse(value) {
    if (value === undefined || value === null) return -1;
    const s = String(value).trim().toUpperCase();
    if (!s) return -1;
    if (this.byId.has(s)) return this.byId.get(s).index;
    let m = /^P(\d+)$/.exec(s);
    if (m) {
      const i = Number(m[1]);
      return i < this.limit ? i : -1;
    }
    m = /^(\d+)$/.exec(s);
    if (m) return this.parse(`A${m[1]}`);
    return -1;
  }

  idOf(index) {
    const e = this.byIndex.get(index);
    return e ? e.id : `p${index}`;
  }
}

module.exports = { Addressing };
