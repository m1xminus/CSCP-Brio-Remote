'use strict';
/**
 * Turns decoded desk messages into minimal state patches (only what changed
 * versus the current mirror). Duplicate responses - e.g. from a redundant
 * master pair or a serial-to-TCP box - therefore produce no patches.
 */
const M = require('../shared/model');

function diff(obj, p) {
  const out = {};
  let any = false;
  for (const k of Object.keys(p)) {
    if (obj[k] !== p[k]) {
      out[k] = p[k];
      any = true;
    }
  }
  return any ? out : null;
}

function fader(state, i, p) {
  if (!(i >= 0 && i < M.NF)) return [];
  const d = diff(state.faders[i], p);
  return d ? [{ t: 'f', i, p: d }] : [];
}
function main(state, i, p) {
  if (!(i >= 0 && i < M.NM)) return [];
  const d = diff(state.mains[i], p);
  return d ? [{ t: 'm', i, p: d }] : [];
}
function aux(state, i, p) {
  if (!(i >= 0 && i < M.NA)) return [];
  const d = diff(state.aux[i], p);
  return d ? [{ t: 'a', i, p: d }] : [];
}

function toPatches(state, m) {
  switch (m.type) {
    case 'name':
      return state.name !== m.name ? [{ t: 'name', name: m.name }] : [];
    case 'info': {
      const info = { version: m.version, maxFaders: m.maxFaders, maxMains: m.maxMains, label: m.label };
      return JSON.stringify(state.info) !== JSON.stringify(info) ? [{ t: 'info', info }] : [];
    }
    case 'faderLevel': return fader(state, m.fader, { level: m.level });
    case 'faderCut': return fader(state, m.fader, { cut: m.cut });
    case 'faderPfl': return fader(state, m.fader, { pfl: m.pfl });
    case 'faderLabel': return fader(state, m.fader, { label: m.label });
    case 'assign': return fader(state, m.fader, { type: m.audioType, width: m.width, id: m.id });
    case 'mainLevel': return main(state, m.main, { level: m.level });
    case 'mainPfl': return main(state, m.main, { pfl: m.pfl });
    case 'mainLabel': return main(state, m.main, { label: m.label });
    case 'availAux': return m.avail.flatMap((v, i) => aux(state, i, { avail: v }));
    case 'availMains': return m.avail.flatMap((v, i) => main(state, i, { avail: v }));
    case 'auxLevel': return aux(state, m.aux, { level: m.level });
    case 'auxOn':
      if (!(m.aux >= 0 && m.aux < M.NA)) return [];
      return M.sameBytes(state.auxOn[m.aux], m.bytes) ? [] : [{ t: 'auxOn', i: m.aux, bytes: m.bytes }];
    case 'route':
      if (!(m.main >= 0 && m.main < M.NM)) return [];
      return M.sameBytes(state.route[m.main], m.bytes) ? [] : [{ t: 'route', i: m.main, bytes: m.bytes }];
    case 'lr': {
      const out = [];
      for (let n = 0; n < M.NF; n++) out.push(...fader(state, n, M.unpackLR(m.bytes, n)));
      return out;
    }
    default:
      return [];
  }
}

module.exports = { toPatches };
