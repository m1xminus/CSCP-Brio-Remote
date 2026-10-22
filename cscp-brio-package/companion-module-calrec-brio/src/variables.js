'use strict';
/** Variables: label, level (dB) and cut state per fader; level per main / aux master; desk status. */

function mainsOf(ch) {
  return ch.main.map((c) => c.id);
}
function auxOf(ch) {
  return ch.aux.map((c) => c.id);
}

function definitions(ctl, ch) {
  const d = {
    desk_name: { name: 'Desk name' },
    desk_status: { name: 'Connection status' },
    desk_version: { name: 'CSCP protocol version reported by the desk' },
  };
  for (const e of ctl.addr.list) {
    d[`fader_${e.id}_label`] = { name: `Fader ${e.id}: label` };
    d[`fader_${e.id}_db`] = { name: `Fader ${e.id}: level (dB)` };
    d[`fader_${e.id}_state`] = { name: `Fader ${e.id}: CUT or ON` };
  }
  for (const n of mainsOf(ch)) {
    d[`main_${n}_label`] = { name: `Main ${n}: label` };
    d[`main_${n}_db`] = { name: `Main ${n}: level (dB)` };
  }
  for (const n of auxOf(ch)) d[`aux_${n}_db`] = { name: `Aux master ${n}: level (dB)` };
  return d;
}

const STATUS_TEXT = {
  offline: 'Offline', connecting: 'Connecting', reconnecting: 'Reconnecting', syncing: 'Reading desk', online: 'Online',
};

function values(ctl, ch) {
  const s = ctl.state;
  const v = {
    desk_name: s.name || '',
    desk_status: STATUS_TEXT[s.conn.status] || s.conn.status,
    desk_version: s.info && s.info.version !== undefined ? String(s.info.version) : '',
  };
  for (const e of ctl.addr.list) {
    const f = s.faders[e.index];
    v[`fader_${e.id}_label`] = f.label || '';
    v[`fader_${e.id}_db`] = ctl.faderDb(e.index);
    v[`fader_${e.id}_state`] = f.cut ? 'CUT' : 'ON';
  }
  for (const n of mainsOf(ch)) {
    v[`main_${n}_label`] = s.mains[n - 1].label || '';
    v[`main_${n}_db`] = ctl.mainDbText(n - 1);
  }
  for (const n of auxOf(ch)) v[`aux_${n}_db`] = ctl.auxDbText(n - 1);
  return v;
}

module.exports = { definitions, values };
