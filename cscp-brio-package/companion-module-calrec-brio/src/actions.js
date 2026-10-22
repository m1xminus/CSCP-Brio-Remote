'use strict';
const F = require('./fields');

/**
 * Companion actions. `ch` = dropdown choices, `fail(err)` reports a problem in the Companion log.
 * Mains and aux masters have no cut in CSCP, so their "cut / on" works on the level (see HELP.md).
 */
function buildActions(ctl, ch, fail) {
  const run = (fn) => async (ev) => {
    try {
      fn(ev.options);
    } catch (e) {
      fail(e);
    }
  };
  const faderDb = () => F.db('db', 'Level (dB)', 0, -100, 10);
  const mainDb = () => F.db('db', 'Level (dB)', -10, -100, 0);

  const defs = {
    // ---- faders
    fader_level: {
      name: 'Fader: set level',
      options: [F.fader(ch), faderDb(), F.fade(0)],
      callback: run((o) => ctl.setFaderDb(o.fader, o.db, o.fade)),
    },
    fader_step: {
      name: 'Fader: step level up / down',
      options: [F.fader(ch), F.step],
      callback: run((o) => ctl.stepFader(o.fader, o.step)),
    },
    fader_open: {
      name: 'Fader: open (uncut + fade up)',
      description: 'Un-cuts the fader and fades it up to the level. A cut fader starts from silence.',
      options: [
        F.fader(ch), faderDb(), F.fade(500),
        { id: 'silence', type: 'checkbox', label: 'If cut, start from silence', default: true },
      ],
      callback: run((o) => ctl.openFader(o.fader, o.db, o.fade, o.silence !== false)),
    },
    fader_close: {
      name: 'Fader: close (fade down + cut)',
      options: [F.fader(ch), F.fade(500)],
      callback: run((o) => ctl.closeFader(o.fader, o.fade)),
    },
    fader_cut: {
      name: 'Fader: cut / on',
      options: [F.fader(ch), F.MODE_CUT],
      callback: run((o) => ctl.faderCut(o.fader, o.mode)),
    },
    fader_pfl: {
      name: 'Fader: PFL',
      options: [F.fader(ch), F.MODE_SWITCH],
      callback: run((o) => ctl.faderPfl(o.fader, o.mode)),
    },

    // ---- mains
    main_level: {
      name: 'Main: set level',
      options: [F.main(ch), mainDb(), F.fade(0)],
      callback: run((o) => ctl.setMainDb(o.main, o.db, o.fade)),
    },
    main_step: {
      name: 'Main: step level up / down',
      options: [F.main(ch), F.step],
      callback: run((o) => ctl.stepMain(o.main, o.step)),
    },
    main_off: {
      name: 'Main: cut / on (via level)',
      description: 'CSCP has no main cut. Cut drops the main to off and remembers the level; On restores it.',
      options: [F.main(ch), F.MODE_OFF, F.fade(0)],
      callback: run((o) => ctl.mainOff(o.main, o.mode, o.fade)),
    },
    main_pfl: {
      name: 'Main: PFL',
      options: [F.main(ch), F.MODE_SWITCH],
      callback: run((o) => ctl.mainPfl(o.main, o.mode)),
    },

    // ---- aux masters
    aux_level: {
      name: 'Aux master: set level',
      options: [F.aux(ch), F.db('db', 'Level (dB)', 0, -100, 10), F.fade(0)],
      callback: run((o) => ctl.setAuxDb(o.aux, o.db, o.fade)),
    },
    aux_step: {
      name: 'Aux master: step level up / down',
      options: [F.aux(ch), F.step],
      callback: run((o) => ctl.stepAux(o.aux, o.step)),
    },
    aux_off: {
      name: 'Aux master: cut / on (via level)',
      description: 'CSCP has no aux master cut. Cut drops the aux master to off and remembers the level; On restores it.',
      options: [F.aux(ch), F.MODE_OFF, F.fade(0)],
      callback: run((o) => ctl.auxOff(o.aux, o.mode, o.fade)),
    },

    // ---- routing
    aux_send: {
      name: 'Aux send: on / off (fader to aux)',
      description: 'Switches the send of one fader to one aux. CSCP cannot set the send level.',
      options: [F.fader(ch), F.aux(ch), F.MODE_SWITCH],
      callback: run((o) => ctl.auxSend(o.fader, o.aux, o.mode)),
    },
    route_main: {
      name: 'Route: fader to main on / off',
      options: [F.fader(ch), F.main(ch), F.MODE_SWITCH],
      callback: run((o) => ctl.routeMain(o.fader, o.main, o.mode)),
    },
    lr_leg: {
      name: 'Stereo input: L>B / R>B',
      options: [F.fader(ch), F.LEG, F.MODE_SWITCH],
      callback: run((o) => ctl.lrLeg(o.fader, o.leg, o.mode)),
    },

    // ---- main / aux master: fade up and down (no cut exists, so these move the level)
    main_open: {
      name: 'Main: open (fade up to level)',
      options: [F.main(ch), mainDb(), F.fade(500)],
      callback: run((o) => ctl.openMain(o.main, o.db, o.fade)),
    },
    main_close: {
      name: 'Main: close (fade down to off)',
      options: [F.main(ch), F.fade(500)],
      callback: run((o) => ctl.closeMain(o.main, o.fade)),
    },
    aux_open: {
      name: 'Aux master: open (fade up to level)',
      options: [F.aux(ch), F.db('db', 'Level (dB)', 0, -100, 10), F.fade(500)],
      callback: run((o) => ctl.openAux(o.aux, o.db, o.fade)),
    },
    aux_close: {
      name: 'Aux master: close (fade down to off)',
      options: [F.aux(ch), F.fade(500)],
      callback: run((o) => ctl.closeAux(o.aux, o.fade)),
    },
  };

  // ---- groups / VCA masters: the fader actions, with a picker that lists only groups
  for (const id of ['level', 'step', 'open', 'close', 'cut', 'pfl']) {
    const base = defs[`fader_${id}`];
    defs[`group_${id}`] = {
      ...base,
      name: base.name.replace(/^Fader:/, 'Group / VCA:'),
      options: base.options.map((f) => (f.id === 'fader' ? F.group(ch) : f)),
      callback: run((o) => {
        ctl.groupIndex(o.group); // must really be a group
        base.callback({ options: { ...o, fader: o.group } });
      }),
    };
  }
  return defs;
}

module.exports = { buildActions };
