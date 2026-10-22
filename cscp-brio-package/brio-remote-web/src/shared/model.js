/* State model + patch application + fader layout maths. Node and browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CSCPModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NF = 192; // protocol faders
  const NM = 16; // mains
  const NA = 20; // aux outputs
  const BITMAP_BYTES = 24;

  const TYPE_BADGE = {
    0: '', 1: 'CH', 2: 'GRP', 3: 'VCA', 4: 'VCA·CH', 5: 'VCA·GRP',
    6: 'MAIN', 7: 'VCA·MN', 8: 'TRK', 9: 'VCA·TRK', 10: 'AUX', 11: 'VCA·AUX',
  };
  const WIDTH_BADGE = { 0: '', 1: 'MONO', 2: 'ST', 6: 'SURR' };

  const newFader = () => ({
    level: 0, cut: false, pfl: false, label: '',
    type: 0, width: 0, id: 0, lb: false, rb: false,
  });

  function createState() {
    return {
      conn: { status: 'offline', host: '', port: 0 },
      name: '',
      info: null,
      protocolFaders: NF,
      faders: Array.from({ length: NF }, newFader),
      mains: Array.from({ length: NM }, () => ({ level: 0, pfl: false, label: '', avail: false })),
      aux: Array.from({ length: NA }, () => ({ level: 0, avail: false })),
      auxOn: Array.from({ length: NA }, () => new Array(BITMAP_BYTES).fill(0)),
      route: Array.from({ length: NM }, () => new Array(BITMAP_BYTES).fill(0)),
    };
  }

  // ---- bitmaps (LSB-first, fader 0 = bit 0 of byte 0) ----
  const bit = (bytes, n) => ((bytes[n >> 3] >> (n & 7)) & 1) === 1;
  function setBit(bytes, n, on) {
    const out = Array.from(bytes);
    if (on) out[n >> 3] |= 1 << (n & 7);
    else out[n >> 3] &= ~(1 << (n & 7)) & 0xff;
    return out;
  }
  const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  /** 48-byte L>B / R>B block (4 faders per byte, L>B low bit, R>B high bit of each pair). */
  function packLR(faders) {
    const out = new Array(48).fill(0);
    for (let n = 0; n < NF; n++) {
      const sh = (n & 3) * 2;
      if (faders[n].lb) out[n >> 2] |= 1 << sh;
      if (faders[n].rb) out[n >> 2] |= 1 << (sh + 1);
    }
    return out;
  }
  function unpackLR(bytes, n) {
    const sh = (n & 3) * 2;
    return { lb: ((bytes[n >> 2] >> sh) & 1) === 1, rb: ((bytes[n >> 2] >> (sh + 1)) & 1) === 1 };
  }

  function applyPatch(s, p) {
    switch (p.t) {
      case 'full': {
        Object.assign(s, p.state);
        break;
      }
      case 'reset': {
        const conn = s.conn;
        Object.assign(s, createState());
        s.conn = conn;
        break;
      }
      case 'conn': s.conn = Object.assign({}, s.conn, p.conn); break;
      case 'name': s.name = p.name; break;
      case 'info':
        s.info = p.info;
        s.protocolFaders = Math.max(1, Math.min(NF, (p.info.maxFaders || NF / 2) * 2));
        break;
      case 'f': Object.assign(s.faders[p.i], p.p); break;
      case 'm': Object.assign(s.mains[p.i], p.p); break;
      case 'a': Object.assign(s.aux[p.i], p.p); break;
      case 'auxOn': s.auxOn[p.i] = p.bytes; break;
      case 'route': s.route[p.i] = p.bytes; break;
      default: break;
    }
  }

  // ---- surface layout: protocol fader <-> (layer, sub-layer, position) ----
  // N = surface faders in the controlled run, bOff = "B layer off" option.
  function surfaceOf(p, N, bOff) {
    if (bOff) return { layer: Math.floor(p / N) + 1, sub: 'A', pos: p % N };
    const per = 2 * N;
    const r = p % per;
    return { layer: Math.floor(p / per) + 1, sub: r < N ? 'A' : 'B', pos: r % N };
  }
  function protocolIndex(layer, sub, pos, N, bOff) {
    if (bOff) return (layer - 1) * N + pos;
    return (layer - 1) * 2 * N + (sub === 'B' ? N : 0) + pos;
  }
  function layerCount(protocolFaders, N, bOff) {
    const per = bOff ? N : 2 * N;
    return Math.max(1, Math.min(12, Math.ceil(protocolFaders / per)));
  }

  const typeBadge = (f) => TYPE_BADGE[f.type] || '';
  const widthBadge = (f) => WIDTH_BADGE[f.width] || '';

  return {
    NF, NM, NA, BITMAP_BYTES, TYPE_BADGE, WIDTH_BADGE,
    createState, applyPatch, bit, setBit, sameBytes, packLR, unpackLR,
    surfaceOf, protocolIndex, layerCount, typeBadge, widthBadge,
  };
});
