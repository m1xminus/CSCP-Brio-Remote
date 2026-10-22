'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, sleep, until } = require('./helpers');
const { Addressing } = require('../src/addressing');
const Levels = require('../src/lib/shared/levels');
const Model = require('../src/lib/shared/model');
const { handleHttp } = require('../src/http');
const { buildPresets } = require('../src/presets');
const Variables = require('../src/variables');

test('fader names follow the Brio layout: A1..A36 then B1..B36', () => {
  const a = new Addressing();
  a.configure({ surfaceFaders: 36, layers: 1, bLayerOff: false });
  assert.equal(a.list.length, 72);
  assert.equal(a.parse('A1'), 0);
  assert.equal(a.parse('A12'), 11);
  assert.equal(a.parse('A13'), 12);
  assert.equal(a.parse('A36'), 35);
  assert.equal(a.parse('B1'), 36);
  assert.equal(a.parse('b36'), 71);
  assert.equal(a.parse('p5'), 5);
  assert.equal(a.parse('8'), 7); // bare number = A8
  assert.equal(a.parse('A37'), -1);
  assert.equal(a.parse('C1'), -1);
  assert.equal(a.idOf(36), 'B1');
  a.configure({ surfaceFaders: 12, layers: 2 });
  assert.equal(a.parse('L2A1'), 24);
  a.configure({ surfaceFaders: 36, layers: 1, bLayerOff: true });
  assert.equal(a.parse('B1'), -1);
  assert.equal(a.list.length, 36);
});

test('fader actions: level, step, cut, pfl reach the desk', async () => {
  const t = await setup();
  try {
    await t.act('fader_level', { fader: 'A1', db: -10, fade: 0 });
    await until(() => t.mock.d.faders[0].level === Levels.dbToLevel(-10, 'ch'), 3000, 'level -10 dB');

    const before = t.ctl.state.faders[0].level;
    await t.act('fader_step', { fader: 'A1', step: 3 });
    await until(() => t.mock.d.faders[0].level > before, 3000, 'step up');
    assert.ok(Math.abs(Levels.levelToDb(t.mock.d.faders[0].level, 'ch') - -7) < 0.2);

    assert.equal(t.mock.d.faders[7].cut, false);
    await t.act('fader_cut', { fader: 'A8', mode: 'toggle' });
    await until(() => t.mock.d.faders[7].cut === true, 3000, 'cut');
    await t.act('fader_cut', { fader: 'A8', mode: 'on' });
    await until(() => t.mock.d.faders[7].cut === false, 3000, 'uncut');
    await t.act('fader_cut', { fader: 'A8', mode: 'cut' });
    await until(() => t.mock.d.faders[7].cut === true, 3000, 'cut again');

    await t.act('fader_pfl', { fader: 'B1', mode: 'on' });
    await until(() => t.mock.d.faders[36].pfl === true && t.ctl.state.faders[36].pfl === true, 3000, 'pfl on layer B');
    await t.act('fader_pfl', { fader: 'B1', mode: 'toggle' });
    await until(() => t.mock.d.faders[36].pfl === false, 3000, 'pfl off');
    assert.deepEqual(t.errors, []);
  } finally { await t.done(); }
});

test('fader open / close with fades', async () => {
  const t = await setup();
  try {
    // fader index 3 starts cut (level 0) in the simulated desk; park it at -10 dB while cut
    assert.equal(t.mock.d.faders[3].cut, true);
    await t.act('fader_level', { fader: 'A4', db: -10, fade: 0 });
    await until(() => t.ctl.state.faders[3].level === Levels.dbToLevel(-10, 'ch') && t.mock.d.faders[3].level === t.ctl.state.faders[3].level, 3000, 'parked');
    const seen = new Set();
    t.ctl.on('patches', (ps) => ps.forEach((p) => { if (p.t === 'f' && p.i === 3 && p.p.level !== undefined) seen.add(p.p.level); }));
    await t.act('fader_open', { fader: 'A4', db: -10, fade: 500, silence: true });
    await until(() => t.mock.d.faders[3].cut === false && t.mock.d.faders[3].level === Levels.dbToLevel(-10, 'ch'), 4000, 'opened');
    assert.ok(seen.size >= 4, `fade should pass through several levels, saw ${[...seen]}`);
    assert.ok(seen.has(0), 'a cut fader opens from silence');

    await t.act('fader_close', { fader: 'A4', fade: 400 });
    await until(() => t.mock.d.faders[3].cut === true && t.mock.d.faders[3].level === 0, 4000, 'closed');

    // a new command replaces a running fade
    await t.act('fader_open', { fader: 'A4', db: 0, fade: 3000, silence: true });
    await sleep(500);
    await t.act('fader_close', { fader: 'A4', fade: 0 });
    await until(() => t.mock.d.faders[3].cut === true, 3000, 'closed again');
    await sleep(400);
    assert.equal(t.mock.d.faders[3].level, 0);
    assert.equal(t.mock.d.faders[3].cut, true);
    assert.deepEqual(t.errors, []);
  } finally { await t.done(); }
});

test('mains and aux masters: level, step, cut / on via level (restores the old level)', async () => {
  const t = await setup();
  try {
    const m0 = t.mock.d.mains[0].level;
    await t.act('main_off', { main: 1, mode: 'toggle', fade: 0 });
    await until(() => t.mock.d.mains[0].level === 0, 3000, 'main cut');
    assert.equal(t.fbk('main_off', { main: 1 }), true);
    await t.act('main_off', { main: 1, mode: 'toggle', fade: 0 });
    await until(() => t.mock.d.mains[0].level === m0, 3000, 'main restored');
    assert.equal(t.fbk('main_off', { main: 1 }), false);

    await t.act('main_level', { main: 2, db: -20, fade: 0 });
    await until(() => t.mock.d.mains[1].level === Levels.dbToLevel(-20, 'main'), 3000, 'main level');
    await t.act('main_pfl', { main: 1, mode: 'on' });
    await until(() => t.mock.d.mains[0].pfl === true, 3000, 'main pfl');

    const a0 = t.mock.d.aux[0].level;
    await t.act('aux_off', { aux: 1, mode: 'off', fade: 0 });
    await until(() => t.mock.d.aux[0].level === 0, 3000, 'aux cut');
    await t.act('aux_off', { aux: 1, mode: 'on', fade: 0 });
    await until(() => t.mock.d.aux[0].level === a0, 3000, 'aux restored');
    await t.act('aux_level', { aux: 3, db: -5, fade: 0 });
    await until(() => t.mock.d.aux[2].level === Levels.dbToLevel(-5, 'ch'), 3000, 'aux level');
    assert.deepEqual(t.errors, []);
  } finally { await t.done(); }
});

test('routing: aux send, route to main, L>B / R>B', async () => {
  const t = await setup();
  try {
    assert.equal(Model.bit(t.mock.d.auxOn[2], 0), false);
    await t.act('aux_send', { fader: 'A1', aux: 3, mode: 'on' });
    await until(() => Model.bit(t.mock.d.auxOn[2], 0), 3000, 'send on');
    assert.equal(t.fbk('aux_send', { fader: 'A1', aux: 3 }), true);
    await t.act('aux_send', { fader: 'A1', aux: 3, mode: 'toggle' });
    await until(() => !Model.bit(t.mock.d.auxOn[2], 0), 3000, 'send off');

    await t.act('route_main', { fader: 'B1', main: 3, mode: 'on' });
    await until(() => Model.bit(t.mock.d.route[2], 36), 3000, 'route on');
    assert.equal(t.fbk('route_main', { fader: 'B1', main: 3 }), true);

    await t.act('lr_leg', { fader: 'A7', leg: 'rb', mode: 'on' });
    await until(() => t.mock.d.faders[6].rb === true, 3000, 'R>B on');
    assert.equal(t.mock.d.faders[6].lb, true, 'the other leg is untouched');
    assert.equal(t.fbk('lr_leg', { fader: 'A7', leg: 'rb' }), true);
    assert.deepEqual(t.errors, []);
  } finally { await t.done(); }
});

test('bad input is reported, never thrown, and does nothing to the desk', async () => {
  const t = await setup();
  try {
    await t.act('fader_cut', { fader: 'Z99', mode: 'cut' });
    await t.act('main_level', { main: 9, db: 0, fade: 0 }); // only 3 mains configured
    await t.act('fader_level', { fader: 'A1', db: 'abc', fade: 0 });
    assert.equal(t.errors.length, 3, t.errors.join(' | '));
    assert.equal(t.fbk('fader_cut', { fader: 'Z99' }), false);
  } finally { await t.done(); }
});

test('feedbacks follow the desk', async () => {
  const t = await setup();
  try {
    assert.equal(t.fbk('fader_cut', { fader: 'A4' }), true);
    assert.equal(t.fbk('fader_open', { fader: 'A4' }), false);
    assert.equal(t.fbk('fader_open', { fader: 'A1' }), true);
    assert.equal(t.fbk('fader_pfl', { fader: 'A1' }), false);
    assert.equal(t.fbk('desk_online', {}), true);
    assert.equal(t.fbk('aux_off', { aux: 1 }), false);
  } finally { await t.done(); }
});

test('HTTP triggers: open / close / level / cut / send, path prefix and errors', async () => {
  const t = await setup();
  try {
    const get = (path, query = {}) => handleHttp(t.ctl, { method: 'GET', path, query });
    let r = get('/instance/brio/fader/A4/open', { db: '-10', fade: '300' });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).ok, true);
    await until(() => t.mock.d.faders[3].cut === false && t.mock.d.faders[3].level === Levels.dbToLevel(-10, 'ch'), 4000, 'http open');

    r = get('/fader/A4/close', { fade: '300' });
    assert.equal(r.status, 200);
    await until(() => t.mock.d.faders[3].cut === true, 4000, 'http close');

    r = get('/fader/MIC 1/level', { db: '-20' });
    assert.equal(r.status, 200);
    await until(() => t.mock.d.faders[0].level === Levels.dbToLevel(-20, 'ch'), 3000, 'http level by label');

    r = get('/fader/A8/cut');
    await until(() => t.mock.d.faders[7].cut === true, 3000, 'http cut');
    r = get('/send/A1/2/on');
    await until(() => Model.bit(t.mock.d.auxOn[1], 0), 3000, 'http send');
    r = get('/main/1/off');
    await until(() => t.mock.d.mains[0].level === 0, 3000, 'http main off');

    await until(() => t.ctl.state.faders[7].cut === true, 3000, 'mirror sees the cut');
    r = get('/fader/A8');
    assert.equal(JSON.parse(r.body).cut, true);
    assert.equal(JSON.parse(get('/status').body).online, true);
    assert.match(get('/help').body, /Calrec Brio/);

    assert.equal(get('/fader/ZZZ/cut').status, 400);
    assert.equal(get('/fader/A1/level').status, 400); // db missing
    assert.equal(get('/nothing').status, 404);
  } finally { await t.done(); }
});

test('presets are consistent: ids exist, locals are declared, actions and feedbacks are defined', async () => {
  const t = await setup();
  try {
    const { structure, presets } = buildPresets(t.ctl, t.ch, 'brio');
    const ids = new Set(Object.keys(presets));
    for (const sec of structure) {
      for (const g of sec.definitions) {
        if (g.type === 'simple') for (const id of g.presets) assert.ok(ids.has(id), `group ${g.id}: missing preset ${id}`);
        else {
          assert.ok(ids.has(g.presetId), `group ${g.id}: missing template preset`);
          const locals = presets[g.presetId].localVariables.map((l) => l.variableName);
          assert.ok(locals.includes(g.templateVariableName), `group ${g.id}: template variable not on the preset`);
          assert.ok(g.templateValues.length > 0);
        }
      }
    }
    for (const [id, p] of Object.entries(presets)) {
      const declared = new Set((p.localVariables || []).map((l) => l.variableName));
      const text = JSON.stringify(p);
      for (const m of text.matchAll(/\$\(local:([a-z]+)\)/g)) assert.ok(declared.has(m[1]), `${id}: uses undeclared local "${m[1]}"`);
      for (const s of p.steps) for (const a of [...s.down, ...(s.rotate_left || []), ...(s.rotate_right || [])]) {
        assert.ok(t.actions[a.actionId], `${id}: unknown action ${a.actionId}`);
        for (const k of Object.keys(a.options)) {
          assert.ok(t.actions[a.actionId].options.some((o) => o.id === k), `${id}: action ${a.actionId} has no option ${k}`);
        }
      }
      for (const f of p.feedbacks) {
        assert.ok(t.feedbacks[f.feedbackId], `${id}: unknown feedback ${f.feedbackId}`);
        for (const k of Object.keys(f.options)) {
          assert.ok(t.feedbacks[f.feedbackId].options.some((o) => o.id === k), `${id}: feedback ${f.feedbackId} has no option ${k}`);
        }
      }
    }
  } finally { await t.done(); }
});

test('variables: every value has a definition and vice versa; labels and dB come from the desk', async () => {
  const t = await setup();
  try {
    const defs = Variables.definitions(t.ctl, t.ch);
    const vals = Variables.values(t.ctl, t.ch);
    assert.deepEqual(Object.keys(defs).sort(), Object.keys(vals).sort());
    assert.equal(vals.fader_A1_label, 'MIC 1');
    assert.equal(vals.fader_A1_db, Levels.formatDb(t.mock.d.faders[0].level, 'ch'));
    assert.equal(vals.fader_A4_state, 'CUT');
    assert.equal(vals.fader_B1_label, 'B MIC 1');
    assert.equal(vals.main_1_label, 'PGM');
    assert.equal(vals.desk_status, 'Online');
    assert.equal(vals.desk_version, '22');
    assert.ok(!('aux_7_db' in vals), 'only auxes the desk has');
    assert.ok(!('main_4_db' in vals), 'only mains the desk has');
  } finally { await t.done(); }
});

test('groups and VCA masters: own picker, same actions, refuses non-groups', async () => {
  const t = await setup();
  try {
    // found by audio type: FX GRP (A11), VCA ATM (A12), GRP B (B3)
    assert.deepEqual(t.ch.group.map((c) => c.id), ['A11', 'A12', 'B3']);
    assert.deepEqual(t.ch.group.map((c) => c.label), ['FX GRP (A11)', 'VCA ATM (A12)', 'GRP B (B3)']);

    await t.act('group_level', { group: 'A11', db: -12, fade: 0 });
    await until(() => t.mock.d.faders[10].level === Levels.dbToLevel(-12, 'ch'), 3000, 'group level');
    await t.act('group_cut', { group: 'B3', mode: 'cut' });
    await until(() => t.mock.d.faders[38].cut === true && t.ctl.state.faders[38].cut === true, 3000, 'group cut');
    assert.equal(t.fbk('group_cut', { group: 'B3' }), true);
    await t.act('group_pfl', { group: 'A12', mode: 'on' });
    await until(() => t.mock.d.faders[11].pfl === true, 3000, 'vca pfl');
    await t.act('group_open', { group: 'B3', db: -6, fade: 0, silence: true });
    await until(() => t.mock.d.faders[38].cut === false && t.mock.d.faders[38].level === Levels.dbToLevel(-6, 'ch')
      && t.ctl.state.faders[38].cut === false && t.ctl.state.faders[38].level === t.mock.d.faders[38].level, 3000, 'group open');
    assert.equal(t.fbk('group_open', { group: 'B3' }), true);

    // a plain channel is not a group
    await t.act('group_cut', { group: 'A1', mode: 'cut' });
    assert.equal(t.errors.length, 1);
    assert.match(t.errors[0], /not a group/);
    assert.equal(t.mock.d.faders[0].cut, false);
    assert.equal(t.fbk('group_cut', { group: 'A1' }), false);
  } finally { await t.done(); }
});

test('mains and aux masters fade open / close', async () => {
  const t = await setup();
  try {
    await t.act('main_close', { main: 1, fade: 300 });
    await until(() => t.mock.d.mains[0].level === 0 && t.ctl.state.mains[0].level === 0, 3000, 'main closed');
    assert.equal(t.fbk('main_open', { main: 1 }), false);
    await t.act('main_open', { main: 1, db: -10, fade: 300 });
    await until(() => t.mock.d.mains[0].level === Levels.dbToLevel(-10, 'main') && t.ctl.state.mains[0].level === t.mock.d.mains[0].level, 3000, 'main opened');
    assert.equal(t.fbk('main_open', { main: 1 }), true);

    await t.act('aux_close', { aux: 2, fade: 300 });
    await until(() => t.mock.d.aux[1].level === 0, 3000, 'aux closed');
    await t.act('aux_open', { aux: 2, db: -3, fade: 300 });
    await until(() => t.mock.d.aux[1].level === Levels.dbToLevel(-3, 'ch') && t.ctl.state.aux[1].level === t.mock.d.aux[1].level, 3000, 'aux opened');
    assert.equal(t.fbk('aux_open', { aux: 2 }), true);
    assert.deepEqual(t.errors, []);
  } finally { await t.done(); }
});

test('HTTP: group, main and aux open / close', async () => {
  const t = await setup();
  try {
    const get = (path, query = {}) => handleHttp(t.ctl, { method: 'GET', path, query });
    assert.equal(get('/group/B3/cut').status, 200);
    await until(() => t.mock.d.faders[38].cut === true, 3000, 'http group cut');
    assert.equal(get('/group/FX GRP/level', { db: '-20' }).status, 200);
    await until(() => t.mock.d.faders[10].level === Levels.dbToLevel(-20, 'ch'), 3000, 'http group by label');
    const bad = get('/group/A1/cut');
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.body).error, /not a group/);

    assert.equal(get('/main/1/close', { fade: '200' }).status, 200);
    await until(() => t.mock.d.mains[0].level === 0, 3000, 'http main close');
    assert.equal(get('/main/1/open', { db: '-10', fade: '200' }).status, 200);
    await until(() => t.mock.d.mains[0].level === Levels.dbToLevel(-10, 'main'), 3000, 'http main open');
    assert.equal(get('/aux/1/open', { db: '-5' }).status, 200);
    await until(() => t.mock.d.aux[0].level === Levels.dbToLevel(-5, 'ch'), 3000, 'http aux open');
    assert.equal(get('/aux/1/pfl').status, 400); // no aux master PFL in CSCP
  } finally { await t.done(); }
});

test('presets cover faders, groups, mains and aux masters the same way', async () => {
  const t = await setup();
  try {
    const { structure, presets } = buildPresets(t.ctl, t.ch, 'brio');
    assert.deepEqual(structure.map((s) => s.name), ['Fader', 'Group / VCA', 'Main', 'Aux master', 'Routing', 'Desk']);
    for (const kind of ['fader', 'group', 'main', 'aux']) {
      for (const p of ['cut_on', 'up', 'down', 'set_level', 'open', 'close']) assert.ok(presets[`${kind}_${p}`], `${kind}_${p}`);
    }
    for (const kind of ['fader', 'group', 'main']) assert.ok(presets[`${kind}_pfl`], `${kind}_pfl`);
    assert.ok(!presets.aux_pfl, 'aux masters have no PFL');
    const groupSec = structure[1];
    const allCut = groupSec.definitions.find((g) => g.id === 'g_group_all_cut');
    assert.deepEqual(allCut.templateValues.map((v) => v.value), ['A11', 'A12', 'B3']);
    // a group preset points at the group actions and group picker
    const s = presets.group_cut_on.steps[0];
    assert.equal(s.down[0].actionId, 'group_cut');
    assert.deepEqual(s.down[0].options.group, { isExpression: true, value: '$(local:group)' });
  } finally { await t.done(); }
});
