'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MockDesk } = require('./support/mockDesk');
const { sleep, until } = require('./helpers');
const { BrioInstance } = require('../src/instance');

/** A stand-in for the Companion host, with the same shape the real library expects. */
function fakeContext() {
  const calls = { actions: [], feedbacks: [], variables: [], presets: [], values: {}, status: [], checks: 0 };
  const ctx = {
    _isInstanceContext: true, id: 'abc123', label: 'brio', upgradeScripts: [],
    saveConfig() {}, oscSend() {}, recordAction() {},
    updateStatus: (s, m) => calls.status.push([s, m]),
    setActionDefinitions: (d) => calls.actions.push(d),
    setFeedbackDefinitions: (d) => calls.feedbacks.push(d),
    setVariableDefinitions: (d) => calls.variables.push(d),
    setPresetDefinitions: (structure, presets) => calls.presets.push({ structure, presets }),
    setVariableValues: (v) => Object.assign(calls.values, v),
    getVariableValue: (id) => calls.values[id],
    subscribeActions() {}, unsubscribeActions() {}, unsubscribeFeedbacks() {}, checkFeedbacks() {}, checkFeedbacksById() {},
    checkAllFeedbacks: () => { calls.checks++; },
    sharedUdpSocketHandlers: new Map(),
  };
  return { ctx, calls };
}

test('instance on the real Companion base class: connects, publishes everything, follows desk and config changes', async () => {
  const mock = new MockDesk();
  const port = await mock.listen();
  const { ctx, calls } = fakeContext();
  const inst = new BrioInstance(ctx);
  try {
    await inst.init({ host: '127.0.0.1', port, surfaceFaders: 36, layers: 1, bLayerOff: false });
    await until(() => calls.status.some(([s]) => s === 'ok'), 8000, 'status ok');

    const a = calls.actions.at(-1);
    assert.ok(a.fader_cut && a.main_off && a.aux_send && a.fader_open);
    assert.equal(a.fader_cut.options[0].choices.length, 72);
    assert.ok(Object.keys(calls.feedbacks.at(-1)).includes('fader_cut'));
    assert.ok(!Array.isArray(calls.variables.at(-1)), 'variable definitions must be an object');
    assert.ok(calls.variables.at(-1).fader_A1_label);
    assert.ok(Object.keys(calls.presets.at(-1).presets).length >= 20);
    assert.equal(calls.presets.at(-1).structure.length, 6);

    await until(() => calls.values.fader_A1_label === 'MIC 1', 3000, 'variables filled');
    assert.equal(calls.values.desk_status, 'Online');
    assert.ok(calls.checks > 0, 'feedbacks are re-checked when the desk changes');

    // an action that goes through the exact definition Companion would call
    await a.fader_cut.callback({ options: { fader: 'A8', mode: 'cut' } });
    await until(() => mock.d.faders[7].cut === true, 3000, 'cut reached the desk');
    await until(() => calls.values.fader_A8_state === 'CUT', 3000, 'variable follows');

    // desk labels show up in the dropdowns
    mock.loadMemory();
    await until(() => calls.actions.at(-1).fader_cut.options[0].choices[0].label !== a.fader_cut.options[0].choices[0].label, 6000, 'dropdown labels updated');

    // HTTP through the instance
    const r = inst.handleHttpRequest({ method: 'GET', path: '/instance/brio/status', query: {} });
    assert.equal(JSON.parse(r.body).online, true);

    // layout change in the config
    await inst.configUpdated({ host: '127.0.0.1', port, surfaceFaders: 12, layers: 1, bLayerOff: false });
    assert.equal(calls.actions.at(-1).fader_cut.options[0].choices.length, 24);

    // no host -> bad config
    await inst.configUpdated({ host: '', port, surfaceFaders: 12 });
    assert.equal(calls.status.at(-1)[0], 'bad_config');
    assert.equal(inst.getConfigFields().some((f) => f.id === 'host'), true);
  } finally {
    await inst.destroy();
    await mock.close();
  }
});

test('destroy leaves nothing running', async () => {
  const mock = new MockDesk();
  const port = await mock.listen();
  const { ctx } = fakeContext();
  const inst = new BrioInstance(ctx);
  await inst.init({ host: '127.0.0.1', port });
  await sleep(300);
  await inst.destroy();
  await mock.close();
  assert.equal(inst.ctl.timers.size, 0);
});
