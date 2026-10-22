'use strict';
const F = require('./fields');
const Model = require('./lib/shared/model');
const Levels = require('./lib/shared/levels');

const RED = { bgcolor: 0xaa0000, color: 0xffffff };
const GREEN = { bgcolor: 0x007a1f, color: 0xffffff };
const AMBER = { bgcolor: 0xe0a800, color: 0x000000 };
const BLUE = { bgcolor: 0x0057b8, color: 0xffffff };

/** Boolean feedbacks (Companion adds an "Inverted" option to each). */
function buildFeedbacks(ctl, ch) {
  const safe = (fn) => (fb) => {
    try {
      return !!fn(fb.options);
    } catch {
      return false;
    }
  };
  const st = () => ctl.state;
  const fb = {
    fader_cut: {
      type: 'boolean',
      name: 'Fader is cut',
      options: [F.fader(ch)],
      defaultStyle: RED,
      callback: safe((o) => st().faders[ctl.faderIndex(o.fader)].cut),
    },
    fader_open: {
      type: 'boolean',
      name: 'Fader is open (not cut, above off)',
      options: [F.fader(ch)],
      defaultStyle: GREEN,
      callback: safe((o) => ctl.faderIsOpen(ctl.faderIndex(o.fader))),
    },
    fader_pfl: {
      type: 'boolean',
      name: 'Fader PFL is on',
      options: [F.fader(ch)],
      defaultStyle: AMBER,
      callback: safe((o) => st().faders[ctl.faderIndex(o.fader)].pfl),
    },
    main_off: {
      type: 'boolean',
      name: 'Main is cut (level at off)',
      options: [F.main(ch)],
      defaultStyle: RED,
      callback: safe((o) => Levels.isOff(st().mains[ctl.mainIndex(o.main)].level, 'main')),
    },
    main_pfl: {
      type: 'boolean',
      name: 'Main PFL is on',
      options: [F.main(ch)],
      defaultStyle: AMBER,
      callback: safe((o) => st().mains[ctl.mainIndex(o.main)].pfl),
    },
    aux_off: {
      type: 'boolean',
      name: 'Aux master is cut (level at off)',
      options: [F.aux(ch)],
      defaultStyle: RED,
      callback: safe((o) => Levels.isOff(st().aux[ctl.auxIndex(o.aux)].level, 'ch')),
    },
    aux_send: {
      type: 'boolean',
      name: 'Aux send is on (fader to aux)',
      options: [F.fader(ch), F.aux(ch)],
      defaultStyle: GREEN,
      callback: safe((o) => Model.bit(st().auxOn[ctl.auxIndex(o.aux)], ctl.faderIndex(o.fader))),
    },
    route_main: {
      type: 'boolean',
      name: 'Fader is routed to main',
      options: [F.fader(ch), F.main(ch)],
      defaultStyle: BLUE,
      callback: safe((o) => Model.bit(st().route[ctl.mainIndex(o.main)], ctl.faderIndex(o.fader))),
    },
    lr_leg: {
      type: 'boolean',
      name: 'Stereo input L>B / R>B is on',
      options: [F.fader(ch), F.LEG],
      defaultStyle: BLUE,
      callback: safe((o) => st().faders[ctl.faderIndex(o.fader)][o.leg === 'rb' ? 'rb' : 'lb']),
    },
    main_open: {
      type: 'boolean',
      name: 'Main is open (level above off)',
      options: [F.main(ch)],
      defaultStyle: GREEN,
      callback: safe((o) => !Levels.isOff(st().mains[ctl.mainIndex(o.main)].level, 'main')),
    },
    aux_open: {
      type: 'boolean',
      name: 'Aux master is open (level above off)',
      options: [F.aux(ch)],
      defaultStyle: GREEN,
      callback: safe((o) => !Levels.isOff(st().aux[ctl.auxIndex(o.aux)].level, 'ch')),
    },
    desk_online: {
      type: 'boolean',
      name: 'Desk is connected',
      options: [],
      defaultStyle: GREEN,
      callback: () => ctl.online,
    },
  };

  // ---- groups / VCA masters: the fader feedbacks with a group picker
  for (const id of ['cut', 'open', 'pfl']) {
    const base = fb[`fader_${id}`];
    fb[`group_${id}`] = {
      ...base,
      name: base.name.replace(/^Fader/, 'Group / VCA'),
      options: base.options.map((f) => (f.id === 'fader' ? F.group(ch) : f)),
      callback: safe((o) => {
        ctl.groupIndex(o.group);
        return base.callback({ options: { ...o, fader: o.group } });
      }),
    };
  }
  return fb;
}

module.exports = { buildFeedbacks };
