'use strict';
/** Dropdown choices, built from what the desk has told us (labels, available mains / auxes). */

function faderChoices(ctl) {
  return ctl.addr.list.map((e) => {
    const l = (ctl.state.faders[e.index].label || '').trim();
    return { id: e.id, label: l ? `${e.id} · ${l}` : e.id };
  });
}

function mainChoices(ctl) {
  const known = ctl.desk.seen.availMains;
  const out = [];
  for (let m = 0; m < ctl.state.mains.length; m++) {
    const x = ctl.state.mains[m];
    if (known && !x.avail) continue;
    const l = (x.label || '').trim();
    out.push({ id: m + 1, label: l ? `Main ${m + 1} · ${l}` : `Main ${m + 1}` });
  }
  return out.length ? out : [{ id: 1, label: 'Main 1' }];
}

function auxChoices(ctl) {
  const known = ctl.desk.seen.availAux;
  const out = [];
  for (let a = 0; a < ctl.state.aux.length; a++) {
    if (known && !ctl.state.aux[a].avail) continue;
    out.push({ id: a + 1, label: `Aux ${a + 1}` });
  }
  return out.length ? out : [{ id: 1, label: 'Aux 1' }];
}

/** Group faders and VCA masters, found by their audio type; shown by desk label. */
function groupChoices(ctl) {
  const out = ctl.groupList().map((e) => {
    const l = (ctl.state.faders[e.index].label || '').trim();
    return { id: e.id, label: l ? `${l} (${e.id})` : e.id };
  });
  return out.length ? out : [{ id: '', label: '(no groups found yet - type a fader name)' }];
}

function allChoices(ctl) {
  return { fader: faderChoices(ctl), group: groupChoices(ctl), main: mainChoices(ctl), aux: auxChoices(ctl) };
}

/** Changes whenever the dropdowns would look different. */
function signature(ch) {
  return JSON.stringify([ch.fader, ch.group, ch.main, ch.aux]);
}

module.exports = { allChoices, signature };
