'use strict';
const { MockDesk } = require('./support/mockDesk');
const { Controller } = require('../src/controller');
const { allChoices } = require('../src/choices');
const { buildActions } = require('../src/actions');
const { buildFeedbacks } = require('../src/feedbacks');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, what = 'condition') {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

/** A controller connected to a simulated desk, plus ready-to-call action / feedback definitions. */
async function setup(cfg = {}) {
  const mock = new MockDesk();
  const port = await mock.listen();
  const ctl = new Controller();
  ctl.configure(cfg);
  const errors = [];
  ctl.connect('127.0.0.1', port);
  await until(() => ctl.online, 8000, 'online');
  const ch = allChoices(ctl);
  const actions = buildActions(ctl, ch, (e) => errors.push(e.message));
  const feedbacks = buildFeedbacks(ctl, ch);
  const act = async (id, options) => actions[id].callback({ options });
  const fbk = (id, options) => feedbacks[id].callback({ options });
  return {
    mock, ctl, ch, actions, feedbacks, errors, act, fbk,
    done: async () => { ctl.close(); await mock.close(); },
  };
}

module.exports = { setup, sleep, until };
