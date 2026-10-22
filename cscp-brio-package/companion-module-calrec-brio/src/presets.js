'use strict';
/**
 * Ready-made buttons. Every preset has local variables (fader / group / main / aux ...) at the top of
 * the button: change that one value and the action, the feedback and the button text all follow.
 * The "one button per ..." groups give a pre-made button for every source.
 *
 * Same set for faders, groups / VCA masters, mains and aux masters:
 *   cut / on (with encoder), level up, level down, set level, open (fade up), close (fade down), PFL
 * Mains and aux masters have no cut in CSCP, so their cut / on works on the level; aux masters have no PFL.
 */

const WHITE = 0xffffff;
const DARK = 0x1a1a1a;
const RED = { bgcolor: 0xaa0000, color: WHITE };
const GREEN = { bgcolor: 0x007a1f, color: WHITE };
const AMBER = { bgcolor: 0xe0a800, color: 0x000000 };

function buildPresets(ctl, ch, label) {
  const V = (name) => `$(${label}:${name})`;
  const expr = (name) => ({ isExpression: true, value: `$(local:${name})` });
  const lv = (variableName, startupValue, headline) => ({ variableType: 'simple', variableName, startupValue, headline });
  const act = (actionId, options) => ({ actionId, options });
  const fb = (feedbackId, options, style) => ({ feedbackId, options, style });

  const STEP = (v) => lv('step', v, 'Step in dB');
  const DB = (v) => lv('db', v, 'Level in dB');
  const FADE = (v) => lv('fade', v, 'Fade time in ms (0 = instant)');

  const simple = ({ name, text, bg = DARK, locals, down = [], left, right, feedbacks = [], notes, size = '14' }) => ({
    type: 'simple',
    name,
    notes,
    style: { text, size, color: WHITE, bgcolor: bg },
    localVariables: locals,
    steps: [{ down, up: [], ...(left ? { rotate_left: left } : {}), ...(right ? { rotate_right: right } : {}) }],
    feedbacks,
  });

  const presets = {};

  // ----------------------------------------------- faders and groups (same buttons)
  function faderLike(kind, who, pick) {
    // kind: 'fader' | 'group'; pick: dropdown option / local variable name ('fader' | 'group')
    const first = ch[kind][0] ? ch[kind][0].id : kind === 'fader' ? 'A1' : '';
    const L = lv(pick, first, kind === 'fader' ? 'Fader, e.g. A8 or B12' : 'Group / VCA, e.g. A11 (fader name)');
    const x = expr(pick);
    const lab = V(`fader_$(local:${pick})_label`);
    const db = V(`fader_$(local:${pick})_db`);
    const opt = (extra = {}) => ({ [pick]: x, ...extra });
    Object.assign(presets, {
      [`${kind}_cut_on`]: simple({
        name: `${who}: cut / on`,
        notes: `Press: cut / on. Shows label and level. Turn an encoder to change the level. Change the "${pick}" local variable to pick the ${who.toLowerCase()}.`,
        text: `$(local:${pick})  ${lab}\\n${db} dB`,
        locals: [L],
        down: [act(`${kind}_cut`, opt({ mode: 'toggle' }))],
        left: [act(`${kind}_step`, opt({ step: -1 }))],
        right: [act(`${kind}_step`, opt({ step: 1 }))],
        feedbacks: [fb(`${kind}_open`, opt(), GREEN), fb(`${kind}_cut`, opt(), RED)],
      }),
      [`${kind}_up`]: simple({
        name: `${who}: level up`,
        text: `$(local:${pick})  ${lab}\\n+$(local:step) dB`,
        locals: [L, STEP(1)],
        down: [act(`${kind}_step`, opt({ step: expr('step') }))],
      }),
      [`${kind}_down`]: simple({
        name: `${who}: level down`,
        text: `$(local:${pick})  ${lab}\\n$(local:step) dB`,
        locals: [L, STEP(-1)],
        down: [act(`${kind}_step`, opt({ step: expr('step') }))],
      }),
      [`${kind}_set_level`]: simple({
        name: `${who}: set level`,
        text: `$(local:${pick})  ${lab}\\nSET $(local:db) dB`,
        locals: [L, DB(0), FADE(0)],
        down: [act(`${kind}_level`, opt({ db: expr('db'), fade: expr('fade') }))],
      }),
      [`${kind}_open`]: simple({
        name: `${who}: open (uncut + fade up)`,
        text: `OPEN\\n$(local:${pick})  ${lab}\\n$(local:db) dB`,
        bg: 0x0b3d17,
        locals: [L, DB(0), FADE(500)],
        down: [act(`${kind}_open`, opt({ db: expr('db'), fade: expr('fade'), silence: true }))],
        feedbacks: [fb(`${kind}_open`, opt(), GREEN)],
      }),
      [`${kind}_close`]: simple({
        name: `${who}: close (fade down + cut)`,
        text: `CLOSE\\n$(local:${pick})  ${lab}`,
        bg: 0x4a1010,
        locals: [L, FADE(500)],
        down: [act(`${kind}_close`, opt({ fade: expr('fade') }))],
        feedbacks: [fb(`${kind}_cut`, opt(), RED)],
      }),
      [`${kind}_pfl`]: simple({
        name: `${who}: PFL`,
        text: `PFL\\n$(local:${pick})  ${lab}`,
        locals: [L],
        down: [act(`${kind}_pfl`, opt({ mode: 'toggle' }))],
        feedbacks: [fb(`${kind}_pfl`, opt(), AMBER)],
      }),
    });
  }
  faderLike('fader', 'Fader', 'fader');
  faderLike('group', 'Group / VCA', 'group');

  // ------------------------------------------------------------ mains and aux masters
  function outputLike(kind, who, pick, hasPfl, maxDb, defDb) {
    // kind: 'main' | 'aux'
    const L = lv(pick, ch[kind][0].id, `${who} number`);
    const x = expr(pick);
    const opt = (extra = {}) => ({ [pick]: x, ...extra });
    const word = kind === 'main' ? 'MAIN' : 'AUX';
    const lab = kind === 'main' ? ` ${V('main_$(local:main)_label')}` : '';
    const dbv = V(`${kind}_$(local:${pick})_db`);
    const head = `${word} $(local:${pick})${lab}`;
    const off = `${kind}_off`;
    Object.assign(presets, {
      [`${kind}_cut_on`]: simple({
        name: `${who}: cut / on (via level)`,
        notes: `CSCP has no ${who.toLowerCase()} cut: Cut drops the level to off and remembers it, On restores it.`,
        text: `${head}\\n${dbv} dB`,
        locals: [L],
        down: [act(off, opt({ mode: 'toggle', fade: 0 }))],
        left: [act(`${kind}_step`, opt({ step: -1 }))],
        right: [act(`${kind}_step`, opt({ step: 1 }))],
        feedbacks: [fb(`${kind}_open`, opt(), GREEN), fb(off, opt(), RED)],
      }),
      [`${kind}_up`]: simple({
        name: `${who}: level up`,
        text: `${head}\\n+$(local:step) dB`,
        locals: [L, STEP(1)],
        down: [act(`${kind}_step`, opt({ step: expr('step') }))],
      }),
      [`${kind}_down`]: simple({
        name: `${who}: level down`,
        text: `${head}\\n$(local:step) dB`,
        locals: [L, STEP(-1)],
        down: [act(`${kind}_step`, opt({ step: expr('step') }))],
      }),
      [`${kind}_set_level`]: simple({
        name: `${who}: set level`,
        text: `${head}\\nSET $(local:db) dB`,
        locals: [L, DB(defDb), FADE(0)],
        down: [act(`${kind}_level`, opt({ db: expr('db'), fade: expr('fade') }))],
      }),
      [`${kind}_open`]: simple({
        name: `${who}: open (fade up)`,
        text: `OPEN\\n${head}\\n$(local:db) dB`,
        bg: 0x0b3d17,
        locals: [L, DB(defDb), FADE(500)],
        down: [act(`${kind}_open`, opt({ db: expr('db'), fade: expr('fade') }))],
        feedbacks: [fb(`${kind}_open`, opt(), GREEN)],
      }),
      [`${kind}_close`]: simple({
        name: `${who}: close (fade down)`,
        text: `CLOSE\\n${head}`,
        bg: 0x4a1010,
        locals: [L, FADE(500)],
        down: [act(`${kind}_close`, opt({ fade: expr('fade') }))],
        feedbacks: [fb(off, opt(), RED)],
      }),
    });
    if (hasPfl) {
      presets[`${kind}_pfl`] = simple({
        name: `${who}: PFL`,
        text: `PFL\\n${head}`,
        locals: [L],
        down: [act(`${kind}_pfl`, opt({ mode: 'toggle' }))],
        feedbacks: [fb(`${kind}_pfl`, opt(), AMBER)],
      });
    }
  }
  outputLike('main', 'Main', 'main', true, 0, -10);
  outputLike('aux', 'Aux master', 'aux', false, 10, 0);

  // ----------------------------------------------------------------- routing and desk
  const FADER = lv('fader', ch.fader[0] ? ch.fader[0].id : 'A1', 'Fader, e.g. A8 or B12');
  const MAIN = lv('main', ch.main[0].id, 'Main number');
  const AUX = lv('aux', ch.aux[0].id, 'Aux number');
  const fx = expr('fader');
  const mx = expr('main');
  const ax = expr('aux');
  const flab = V('fader_$(local:fader)_label');
  Object.assign(presets, {
    aux_send: simple({
      name: 'Aux send: on / off',
      notes: 'Switches the send of a fader to an aux. CSCP cannot set the send level.',
      text: `$(local:fader)  ${flab}\\n> AUX $(local:aux)`,
      locals: [FADER, AUX],
      down: [act('aux_send', { fader: fx, aux: ax, mode: 'toggle' })],
      feedbacks: [fb('aux_send', { fader: fx, aux: ax }, GREEN)],
    }),
    route_main: simple({
      name: 'Route fader to main',
      text: `$(local:fader)  ${flab}\\n> MAIN $(local:main)`,
      locals: [FADER, MAIN],
      down: [act('route_main', { fader: fx, main: mx, mode: 'toggle' })],
      feedbacks: [fb('route_main', { fader: fx, main: mx }, { bgcolor: 0x0057b8, color: WHITE })],
    }),
    lr_left: simple({
      name: 'Stereo input: L>B',
      text: `$(local:fader)\\nL>B`,
      locals: [FADER],
      down: [act('lr_leg', { fader: fx, leg: 'lb', mode: 'toggle' })],
      feedbacks: [fb('lr_leg', { fader: fx, leg: 'lb' }, { bgcolor: 0x0057b8, color: WHITE })],
    }),
    lr_right: simple({
      name: 'Stereo input: R>B',
      text: `$(local:fader)\\nR>B`,
      locals: [FADER],
      down: [act('lr_leg', { fader: fx, leg: 'rb', mode: 'toggle' })],
      feedbacks: [fb('lr_leg', { fader: fx, leg: 'rb' }, { bgcolor: 0x0057b8, color: WHITE })],
    }),
    desk_status: {
      type: 'simple',
      name: 'Desk status',
      style: { text: `${V('desk_name')}\\n${V('desk_status')}`, size: '14', color: WHITE, bgcolor: 0x4a1010 },
      steps: [{ down: [], up: [] }],
      feedbacks: [{ feedbackId: 'desk_online', options: {}, style: GREEN }],
    },
  });

  // ------------------------------------------------------------------- structure
  const faderValues = ctl.addr.list.map((e) => ({ name: `Fader ${e.id}`, value: e.id }));
  const groupValues = ch.group.filter((c) => c.id !== '').map((c) => ({ name: c.label, value: c.id }));
  const mainValues = ch.main.map((c) => ({ name: c.label, value: c.id }));
  const auxValues = ch.aux.map((c) => ({ name: c.label, value: c.id }));
  const group = (id, name, list) => ({ id, type: 'simple', name, presets: list });
  const all = (id, name, presetId, variable, values) => ({
    id, type: 'template', name, presetId, templateVariableName: variable, templateValues: values,
  });

  const structure = [
    {
      id: 'sec_fader',
      name: 'Fader',
      description: 'Pick a preset, then change "fader" in the button\'s local variables (A1 ... B36).',
      definitions: [
        group('g_fader_main', 'Level and cut / on', ['fader_cut_on', 'fader_up', 'fader_down', 'fader_set_level']),
        group('g_fader_fade', 'Open / close with a fade', ['fader_open', 'fader_close']),
        group('g_fader_pfl', 'PFL', ['fader_pfl']),
        all('g_fader_all_cut', 'Cut / on: one button per fader', 'fader_cut_on', 'fader', faderValues),
        all('g_fader_all_pfl', 'PFL: one button per fader', 'fader_pfl', 'fader', faderValues),
      ],
    },
    {
      id: 'sec_group',
      name: 'Group / VCA',
      description: 'Groups and VCA masters. Pick a preset, then change "group" in the local variables (the fader name, e.g. A11). The one-button-per-group lists are built from what the desk reports.',
      definitions: [
        group('g_group_main', 'Level and cut / on', ['group_cut_on', 'group_up', 'group_down', 'group_set_level']),
        group('g_group_fade', 'Open / close with a fade', ['group_open', 'group_close']),
        group('g_group_pfl', 'PFL', ['group_pfl']),
        ...(groupValues.length
          ? [
              all('g_group_all_cut', 'Cut / on: one button per group', 'group_cut_on', 'group', groupValues),
              all('g_group_all_pfl', 'PFL: one button per group', 'group_pfl', 'group', groupValues),
            ]
          : []),
      ],
    },
    {
      id: 'sec_main',
      name: 'Main',
      description: 'Change "main" in the button\'s local variables. CSCP has no main cut, so cut / on works on the level.',
      definitions: [
        group('g_main', 'Level and cut / on', ['main_cut_on', 'main_up', 'main_down', 'main_set_level']),
        group('g_main_fade', 'Open / close with a fade', ['main_open', 'main_close']),
        group('g_main_pfl', 'PFL', ['main_pfl']),
        all('g_main_all', 'Cut / on: one button per main', 'main_cut_on', 'main', mainValues),
        all('g_main_all_pfl', 'PFL: one button per main', 'main_pfl', 'main', mainValues),
      ],
    },
    {
      id: 'sec_aux',
      name: 'Aux master',
      description: 'Change "aux" in the button\'s local variables. CSCP has no aux master cut (cut / on works on the level) and no aux master PFL.',
      definitions: [
        group('g_aux', 'Level and cut / on', ['aux_cut_on', 'aux_up', 'aux_down', 'aux_set_level']),
        group('g_aux_fade', 'Open / close with a fade', ['aux_open', 'aux_close']),
        all('g_aux_all', 'Cut / on: one button per aux master', 'aux_cut_on', 'aux', auxValues),
      ],
    },
    {
      id: 'sec_routing',
      name: 'Routing',
      description: 'Aux sends (on / off), routes to mains and stereo L>B / R>B.',
      definitions: [group('g_routing', 'Routing', ['aux_send', 'route_main', 'lr_left', 'lr_right'])],
    },
    {
      id: 'sec_desk',
      name: 'Desk',
      definitions: [group('g_desk', 'Status', ['desk_status'])],
    },
  ];

  return { structure, presets };
}

module.exports = { buildPresets };
