'use strict';
/** Option fields shared by actions and feedbacks. */

const fader = (ch) => ({
  id: 'fader',
  type: 'dropdown',
  label: 'Fader',
  tooltip: 'A1 = layer A, fader 1 ... B36 = layer B, fader 36. You can also type a desk label.',
  choices: ch.fader,
  default: ch.fader[0] ? ch.fader[0].id : 'A1',
  allowCustom: true,
  allowInvalidValues: true,
  minChoicesForSearch: 0,
});

const group = (ch) => ({
  id: 'group',
  type: 'dropdown',
  label: 'Group / VCA',
  tooltip: 'Groups and VCA masters found on the desk. You can also type a fader name (A11) or its label.',
  choices: ch.group,
  default: ch.group[0].id,
  allowCustom: true,
  allowInvalidValues: true,
  minChoicesForSearch: 0,
});

const main = (ch) => ({
  id: 'main',
  type: 'dropdown',
  label: 'Main',
  choices: ch.main,
  default: ch.main[0].id,
  allowCustom: true,
  allowInvalidValues: true,
});

const aux = (ch) => ({
  id: 'aux',
  type: 'dropdown',
  label: 'Aux',
  choices: ch.aux,
  default: ch.aux[0].id,
  allowCustom: true,
  allowInvalidValues: true,
});

const db = (id, label, def, min, max) => ({
  id,
  type: 'number',
  label,
  default: def,
  min,
  max,
  step: 0.5,
  clampValues: true,
  showMinAsNegativeInfinity: min <= -100,
});

const step = {
  id: 'step',
  type: 'number',
  label: 'Step (dB, negative = down)',
  default: 1,
  min: -40,
  max: 40,
  step: 0.5,
  clampValues: true,
};

const fade = (def = 0) => ({
  id: 'fade',
  type: 'number',
  label: 'Fade time (ms, 0 = instant)',
  default: def,
  min: 0,
  max: 120000,
  step: 100,
  asInteger: true,
  clampValues: true,
});

const choice = (id, label, choices, def) => ({ id, type: 'dropdown', label, choices, default: def });

const MODE_CUT = choice('mode', 'Action', [
  { id: 'cut', label: 'Cut' },
  { id: 'on', label: 'On (uncut)' },
  { id: 'toggle', label: 'Toggle cut / on' },
], 'toggle');
const MODE_OFF = choice('mode', 'Action', [
  { id: 'off', label: 'Cut (level to off)' },
  { id: 'on', label: 'On (restore level)' },
  { id: 'toggle', label: 'Toggle cut / on' },
], 'toggle');
const MODE_SWITCH = choice('mode', 'Action', [
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
  { id: 'toggle', label: 'Toggle' },
], 'toggle');
const LEG = choice('leg', 'Leg', [
  { id: 'lb', label: 'L>B (left to both)' },
  { id: 'rb', label: 'R>B (right to both)' },
], 'lb');

module.exports = { fader, group, main, aux, db, step, fade, choice, MODE_CUT, MODE_OFF, MODE_SWITCH, LEG };
