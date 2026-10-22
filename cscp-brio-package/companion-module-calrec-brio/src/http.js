'use strict';
/**
 * HTTP triggers, served by Companion at  http://<companion>:8000/instance/<connection label>/...
 * Simple GET urls so other software (a media player, a script) can open or close a fader.
 */

const HELP = `Calrec Brio - HTTP triggers
(base: http://<companion-ip>:8000/instance/<this connection's label>)

Faders (A1..A36, B1..B36, or the fader's label on the desk):
  /fader/A8/open?db=0&fade=500      un-cut and fade up to 0 dB over 500 ms
  /fader/A8/close?fade=1000         fade down and cut
  /fader/A8/level?db=-10&fade=0     set level (dB)
  /fader/A8/step?db=1               change level by 1 dB
  /fader/A8/cut   /on   /toggle     cut / on
  /fader/A8/pfl   (or /pfl/on /pfl/off)
  /fader/A8                         current state (json)

Groups and VCA masters (same urls as faders, but must be a group):
  /group/A11/open?db=0&fade=500     /group/FX GRP/close?fade=1000    ... cut, on, toggle, level, pfl

Mains / aux masters (numbered from 1):
  /main/1/open?db=-10&fade=500      /main/1/close?fade=500
  /main/1/level?db=-10&fade=500     /main/1/off  /on  /toggle  /pfl
  /aux/1/open?db=0&fade=500         /aux/1/close?fade=500
  /aux/1/level?db=0&fade=500        /aux/1/off   /on  /toggle

Routing:
  /send/A8/2/on                     fader A8 to aux 2: on | off | toggle
  /route/A8/1/on                    fader A8 to main 1: on | off | toggle

  /status                           connection state (json)
`;

const json = (status, obj) => ({ status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const modeOf = (s, allowed, def) => {
  const m = (s || def).toLowerCase();
  if (!allowed.includes(m)) throw new Error(`"${s}" is not one of: ${allowed.join(', ')}`);
  return m;
};

function handleHttp(ctl, req) {
  const path = String(req.path || '/').replace(/^\/instance\/[^/]+/, '');
  const parts = path.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const q = req.query || {};
  const db = q.db !== undefined ? q.db : q.level;
  const fade = num(q.fade !== undefined ? q.fade : q.ms, 0);
  const [kind, ref, action, extra] = parts;
  const done = (extraInfo = {}) => json(200, { ok: true, ...extraInfo });
  const need = (v, what) => {
    if (v === undefined || v === '' || !Number.isFinite(Number(v))) throw new Error(`${what} is required, e.g. ?db=-10`);
    return Number(v);
  };

  try {
    if (!kind || kind === 'help') return { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: HELP };
    if (kind === 'status') {
      const s = ctl.state;
      return json(200, { online: ctl.online, status: s.conn.status, desk: s.name, protocolFaders: s.protocolFaders });
    }

    if (kind === 'fader' || kind === 'group') {
      const i = kind === 'group' ? ctl.groupIndex(ref) : ctl.faderIndex(ref);
      const f = ctl.state.faders[i];
      switch (action) {
        case undefined:
          return json(200, { ok: true, fader: ctl.addr.idOf(i), label: f.label, db: ctl.faderDb(i), cut: f.cut, pfl: f.pfl });
        case 'open':
          ctl.openFader(ref, db === undefined ? 0 : need(db, 'db'), fade, q.silence !== '0' && q.silence !== 'false');
          return done();
        case 'close':
          ctl.closeFader(ref, fade);
          return done();
        case 'level':
          ctl.setFaderDb(ref, need(db, 'db'), fade);
          return done();
        case 'step':
          ctl.stepFader(ref, need(db, 'db'));
          return done();
        case 'cut':
          ctl.faderCut(ref, 'cut');
          return done();
        case 'on':
          ctl.faderCut(ref, 'on');
          return done();
        case 'toggle':
          ctl.faderCut(ref, 'toggle');
          return done();
        case 'pfl':
          ctl.faderPfl(ref, modeOf(extra, ['on', 'off', 'toggle'], 'toggle'));
          return done();
        default:
          throw new Error(`Unknown fader action "${action}" (see /help)`);
      }
    }

    if (kind === 'main' || kind === 'aux') {
      const isMain = kind === 'main';
      switch (action) {
        case 'open':
          if (isMain) ctl.openMain(ref, db === undefined ? 0 : need(db, 'db'), fade);
          else ctl.openAux(ref, db === undefined ? 0 : need(db, 'db'), fade);
          return done();
        case 'close':
          if (isMain) ctl.closeMain(ref, fade);
          else ctl.closeAux(ref, fade);
          return done();
        case 'level':
          if (isMain) ctl.setMainDb(ref, need(db, 'db'), fade);
          else ctl.setAuxDb(ref, need(db, 'db'), fade);
          return done();
        case 'step':
          if (isMain) ctl.stepMain(ref, need(db, 'db'));
          else ctl.stepAux(ref, need(db, 'db'));
          return done();
        case 'off':
        case 'on':
        case 'toggle':
          if (isMain) ctl.mainOff(ref, action, fade);
          else ctl.auxOff(ref, action, fade);
          return done();
        case 'pfl':
          if (!isMain) throw new Error('Aux masters have no PFL in CSCP');
          ctl.mainPfl(ref, modeOf(extra, ['on', 'off', 'toggle'], 'toggle'));
          return done();
        default:
          throw new Error(`Unknown ${kind} action "${action}" (see /help)`);
      }
    }

    if (kind === 'send') {
      ctl.auxSend(ref, action, modeOf(extra, ['on', 'off', 'toggle'], 'toggle'));
      return done();
    }
    if (kind === 'route') {
      ctl.routeMain(ref, action, modeOf(extra, ['on', 'off', 'toggle'], 'toggle'));
      return done();
    }
    return json(404, { ok: false, error: `Unknown path "${path}" (see /help)` });
  } catch (e) {
    return json(400, { ok: false, error: e.message });
  }
}

module.exports = { handleHttp, HELP };
