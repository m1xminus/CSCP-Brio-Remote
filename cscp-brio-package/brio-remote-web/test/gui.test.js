'use strict';
/**
 * GUI logic test in jsdom: loads the real index.html + shared modules + app.js,
 * replaces WebSocket with a fake, then drives it with state from the real
 * Desk/MockDesk stack. (jsdom has no layout engine or CSS animation, so this checks
 * behaviour and DOM structure, not pixels or blinking - those were checked in Chromium.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { Desk } = require('../src/core/desk');
const { MockDesk } = require('../src/mock/mockDesk');
const Model = require('../src/shared/model');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, what = 'condition') {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(15);
  }
}

async function boot() {
  const mock = new MockDesk();
  const port = await mock.listen();
  const desk = new Desk();
  desk.connect('127.0.0.1', port);
  await until(() => desk.state.conn.status === 'online', 8000, 'desk online');

  const sent = [];
  const dom = new JSDOM(read('public/index.html').replace(/<script[^>]*><\/script>/g, ''), {
    url: 'http://localhost:8787/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  class FakeWS {
    constructor() { this.readyState = 1; FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
    send(s) { sent.push(JSON.parse(s)); }
    close() {}
  }
  w.WebSocket = FakeWS;
  w.eval(read('src/shared/levels.js'));
  w.eval(read('src/shared/model.js'));
  w.eval(read('public/app.js'));
  const ws = FakeWS.last;
  const deliver = (m) => ws.onmessage({ data: JSON.stringify(m) });
  deliver({ t: 'full', state: desk.state, server: { mode: 'real', last: { host: '10.1.1.5', port: 49201 } } });
  await sleep(60);
  return { w, doc: w.document, ws, deliver, sent, desk, mock, app: w.__cscp, done: async () => { desk.close(); await mock.close(); w.close(); } };
}

const strips = (doc) => [...doc.querySelectorAll('#bay .strip')];
const byLabel = (doc, label) => strips(doc).find((s) => s.querySelector('.lcd').textContent === label);
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
const viewBtn = (doc, v) => doc.querySelector(`#toolbar [data-view="${v}"]`);
const settle = () => sleep(70);

test('toolbar offers FADERS / GROUPS / MAINS / OUTPUTS / AUX SENDS, FADERS selected by default', async () => {
  const g = await boot();
  try {
    const tabs = [...g.doc.querySelectorAll('#toolbar .views button')];
    assert.deepEqual(tabs.map((b) => b.textContent), ['FADERS', 'GROUPS', 'MAINS', 'OUTPUTS', 'AUX SENDS']);
    assert.deepEqual(tabs.map((b) => b.classList.contains('on')), [true, false, false, false, false]);
  } finally { await g.done(); }
});

test('FADERS: a block of 12 strips with labels, colour families, badges and readouts', async () => {
  const g = await boot();
  try {
    const list = strips(g.doc);
    assert.equal(list.length, 12);
    assert.equal(list[0].querySelector('.lcd').textContent, 'MIC 1');
    assert.equal(list[0].querySelector('.badge').textContent, 'CH');
    assert.equal(list[0].dataset.f, 'ch');
    assert.equal(list[10].dataset.f, 'grp');
    assert.equal(list[11].querySelector('.badge').textContent, 'VCA');
    assert.equal(list[11].dataset.f, 'vca');
    assert.equal(list[0].querySelector('.readout').textContent.replace(/\s/g, ''), '-6.0dB');
    assert.ok(list[3].querySelector('.btn[data-kind="cut"]').classList.contains('on'), 'MIC 4 is cut');
    assert.match(g.doc.querySelector('#deskinfo').textContent, /BRIO-MOCK/);
    assert.match(g.doc.querySelector('#deskinfo').textContent, /CSCP v22/);
    assert.equal(g.doc.querySelector('#pill').dataset.status, 'online');
    assert.match(g.doc.querySelector('.range').textContent, /#0.#11/);
    // strips are numbered by surface position (what you see on the desk), 1..12
    assert.deepEqual(list.map((s) => s.querySelector('.num').textContent), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    assert.match(list[0].querySelector('.num').title, /protocol fader #0/);
  } finally { await g.done(); }
});

test('Brio 36 layout: three divisions of 12 (1-12, 13-24, 25-36) per A/B sub-layer, no layer buttons', async () => {
  const g = await boot();
  try {
    assert.equal(g.app.ui.surfaceFaders, 36);
    assert.equal(g.app.ui.layers, 1);
    assert.equal(g.doc.querySelector('#toolbar .tlabel[text="LAYER"]'), null);
    assert.ok(![...g.doc.querySelectorAll('#toolbar .tlabel')].some((e) => e.textContent === 'LAYER'), 'no LAYER selector with one layer');
    const divs = [...g.doc.querySelectorAll('#toolbar .seg.divs button')];
    assert.deepEqual(divs.map((b) => b.textContent), ['1\u201312', '13\u201324', '25\u201336']);
    assert.deepEqual([...g.doc.querySelectorAll('#toolbar .seg.ab button')].map((b) => b.textContent), ['A', 'B']);

    const firstLast = () => { const l = strips(g.doc).map((x) => Number(x.dataset.i)); return [l[0], l[l.length - 1], l.length]; };
    // layer A, in order: protocol 0-11, 12-23, 24-35
    assert.deepEqual(firstLast(), [0, 11, 12]);
    click(divs[1]); await settle();
    assert.deepEqual(firstLast(), [12, 23, 12]);
    assert.deepEqual(strips(g.doc).map((x) => x.querySelector('.num').textContent), ['13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24']);
    click(g.doc.querySelectorAll('#toolbar .seg.divs button')[2]); await settle();
    assert.deepEqual(firstLast(), [24, 35, 12]);
    // layer B, the same three divisions: protocol 36-47, 48-59, 60-71
    click(g.doc.querySelector('.seg.ab button:last-child')); await settle();
    assert.deepEqual(firstLast(), [60, 71, 12]); // division 3 stays selected
    click(g.doc.querySelectorAll('#toolbar .seg.divs button')[0]); await settle();
    assert.deepEqual(firstLast(), [36, 47, 12]);
    assert.equal(byLabel(g.doc, 'B MIC 1').dataset.i, '36');
    assert.equal(strips(g.doc)[0].querySelector('.num').textContent, '1'); // surface fader 1, layer B
    click(g.doc.querySelectorAll('#toolbar .seg.divs button')[1]); await settle();
    assert.deepEqual(firstLast(), [48, 59, 12]);
  } finally { await g.done(); }
});

test('more layers can be enabled in Settings; the layer selector then appears', async () => {
  const g = await boot();
  try {
    const l = g.doc.querySelector('#set-layers');
    l.value = '2';
    l.dispatchEvent(new g.w.Event('change'));
    await settle();
    const labels = [...g.doc.querySelectorAll('#toolbar .tlabel')].map((e) => e.textContent);
    assert.ok(labels.includes('LAYER'));
    const layerSeg = [...g.doc.querySelectorAll('#toolbar .seg')].find((sg) => !sg.classList.contains('views') && !sg.classList.contains('ab') && !sg.classList.contains('divs'));
    assert.equal(layerSeg.querySelectorAll('button').length, 2);
    click(layerSeg.querySelectorAll('button')[1]); await settle();
    assert.equal(strips(g.doc)[0].dataset.i, '72'); // layer 2 A starts after 36 A + 36 B
  } finally { await g.done(); }
});

test('GROUPS view: every group and VCA master fader, from any layer or division', async () => {
  const g = await boot();
  try {
    click(viewBtn(g.doc, 'groups'));
    await settle();
    assert.deepEqual(strips(g.doc).map((s) => s.querySelector('.lcd').textContent), ['FX GRP', 'VCA ATM', 'GRP B']);
    assert.deepEqual(strips(g.doc).map((s) => s.dataset.f), ['grp', 'vca', 'grp']);
    assert.deepEqual(strips(g.doc).map((s) => s.querySelector('.num').textContent), ['11A', '12A', '3B']); // surface position + sub-layer
    assert.equal(g.doc.querySelectorAll('#toolbar .seg.ab').length, 0); // no A/B or division selector here
    assert.match(g.doc.querySelector('.range').textContent, /3 group \/ VCA master faders/);
    // they behave like any fader strip
    click(strips(g.doc)[2].querySelector('.btn[data-kind="cut"]'));
    assert.deepEqual(g.sent.at(-1), { t: 'cut', i: 38, cut: true });
    // a newly assigned group appears without reloading
    g.deliver({ t: 'batch', patches: [{ t: 'f', i: 40, p: { type: 2, width: 2, id: 9999, label: 'NEW GRP' } }] });
    await settle();
    assert.equal(strips(g.doc).length, 4);
  } finally { await g.done(); }
});

test('FADERS: route buttons exist only for available mains and reflect state; L>B/R>B only on stereo', async () => {
  const g = await boot();
  try {
    const mic1 = byLabel(g.doc, 'MIC 1');
    assert.deepEqual([...mic1.querySelectorAll('.btn[data-kind="route"]')].map((b) => b.textContent), ['M1', 'M2', 'M3']);
    assert.ok(mic1.querySelector('.btn[data-kind="route"]').classList.contains('on')); // routed to main 1
    assert.ok(!byLabel(g.doc, 'ATMOS').querySelector('.lrrow').classList.contains('vis-hide'));
    assert.ok(byLabel(g.doc, 'MIC 1').querySelector('.lrrow').classList.contains('vis-hide'));
  } finally { await g.done(); }
});

test('FADERS: buttons send the right commands', async () => {
  const g = await boot();
  try {
    const mic2 = byLabel(g.doc, 'MIC 2');
    click(mic2.querySelector('.btn[data-kind="cut"]'));
    click(mic2.querySelector('.btn[data-kind="pfl"]'));
    click(mic2.querySelectorAll('.btn[data-kind="route"]')[1]);
    click(byLabel(g.doc, 'ATMOS').querySelectorAll('.btn[data-kind="lr"]')[0]);
    assert.deepEqual(g.sent.filter((m) => m.t !== 'log'), [
      { t: 'cut', i: 1, cut: true },
      { t: 'pfl', i: 1, on: true },
      { t: 'route', main: 1, fader: 1, on: true },
      { t: 'lr', i: 4, lb: true, rb: false },
    ]);
  } finally { await g.done(); }
});

test('MAINS view: one strip per available main, no cut button (CSCP has no main cut)', async () => {
  const g = await boot();
  try {
    click(viewBtn(g.doc, 'mains'));
    await settle();
    assert.deepEqual(strips(g.doc).map((s) => s.querySelector('.lcd').textContent), ['PGM', 'CLEAN', 'IFB']);
    assert.ok(strips(g.doc).every((s) => s.classList.contains('master') && !s.querySelector('.btn[data-kind="cut"]')));
    assert.equal(g.doc.querySelector('.range'), null); // no layer/A-B for mains
    click(strips(g.doc)[1].querySelector('.btn[data-kind="pfl"]'));
    const knob = strips(g.doc)[0].querySelector('.knob');
    knob.dispatchEvent(new g.w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await sleep(50);
    assert.deepEqual(g.sent.filter((m) => m.t === 'mpfl'), [{ t: 'mpfl', i: 1, on: true }]);
    assert.deepEqual(g.sent.filter((m) => m.t === 'mlevel').at(-1), { t: 'mlevel', i: 0, v: g.desk.state.mains[0].level + 5 });
  } finally { await g.done(); }
});

test('OUTPUTS view: aux output masters; SENDS shortcut jumps to sends-on-fader for that aux', async () => {
  const g = await boot();
  try {
    click(viewBtn(g.doc, 'outputs'));
    await settle();
    assert.equal(strips(g.doc).length, 6);
    assert.ok(strips(g.doc).every((s) => s.classList.contains('auxm')));
    strips(g.doc)[0].querySelector('.knob').dispatchEvent(new g.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await sleep(50);
    assert.deepEqual(g.sent.filter((m) => m.t === 'alevel').at(-1), { t: 'alevel', i: 0, v: g.desk.state.aux[0].level - 5 });
    click(strips(g.doc)[2].querySelector('.btn[data-kind="route"]')); // SENDS on AUX 3
    await settle();
    assert.equal(g.app.ui.view, 'sends');
    assert.equal(g.app.ui.aux, 2);
    assert.match(g.doc.querySelector('.sendsbanner').textContent, /AUX 3/);
  } finally { await g.done(); }
});

test('AUX SENDS (sends on fader): banner, aux selector, send pads instead of faders, aux master fader', async () => {
  const g = await boot();
  try {
    click(viewBtn(g.doc, 'sends'));
    await settle();
    assert.ok(viewBtn(g.doc, 'sends').classList.contains('sends') && viewBtn(g.doc, 'sends').classList.contains('on'));
    assert.match(g.doc.querySelector('.sendsbanner').textContent, /SENDS ON FADER/);
    assert.match(g.doc.querySelector('.sendsbanner').textContent, /AUX 1/); // first available aux preselected
    const auxBtns = [...g.doc.querySelectorAll('.auxsel button')];
    assert.deepEqual(auxBtns.map((b) => b.textContent), ['1', '2', '3', '4', '5', '6']);

    // pick aux 2: COMM 1 (#8) has its send on in the mock
    click(auxBtns[1]);
    await settle();
    assert.match(g.doc.querySelector('.sendsbanner').textContent, /AUX 2/);
    const faderStrips = strips(g.doc).filter((s) => s.classList.contains('sends'));
    assert.equal(faderStrips.length, 12);
    assert.ok(faderStrips.every((s) => !s.querySelector('.knob')), 'no faders on the send strips');
    assert.equal(g.doc.querySelectorAll('#bay .knob').length, 1, 'only the aux output master has a fader');
    const comm1 = byLabel(g.doc, 'COMM 1');
    assert.ok(comm1.querySelector('.sendpad').classList.contains('on'));
    assert.match(comm1.querySelector('.sendpad').textContent, /AUX 2.*SEND ON/);
    assert.match(byLabel(g.doc, 'MIC 1').querySelector('.sendpad').textContent, /SEND OFF/);

    click(comm1.querySelector('.sendpad'));
    click(byLabel(g.doc, 'MIC 1').querySelector('.sendpad'));
    assert.deepEqual(g.sent.filter((m) => m.t === 'auxon'), [
      { t: 'auxon', aux: 1, fader: 8, on: false },
      { t: 'auxon', aux: 1, fader: 0, on: true },
    ]);

    // the aux output master's fader drives 7.13
    g.doc.querySelector('#bay .strip.auxm .knob').dispatchEvent(new g.w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await sleep(50);
    assert.equal(g.sent.filter((m) => m.t === 'alevel').at(-1).i, 1);

    // cut and PFL remain on the strip in this mode
    click(byLabel(g.doc, 'MIC 2').querySelector('.btn[data-kind="cut"]'));
    assert.deepEqual(g.sent.at(-1), { t: 'cut', i: 1, cut: true });
  } finally { await g.done(); }
});

test('AUX SENDS: live auxOn patches update the pads; unassigned faders cannot be switched', async () => {
  const g = await boot();
  try {
    click(viewBtn(g.doc, 'sends'));
    await settle();
    g.deliver({ t: 'batch', patches: [{ t: 'auxOn', i: 0, bytes: Model.setBit(new Array(24).fill(0), 5, true) }] });
    await settle();
    assert.ok(byLabel(g.doc, 'AMB FX').querySelector('.sendpad').classList.contains('on')); // fader #5
    assert.ok(!byLabel(g.doc, 'MIC 1').querySelector('.sendpad').classList.contains('on'));
    // division 13-24 contains fader 22 (no audio assigned)
    click(g.doc.querySelectorAll('#toolbar .seg.divs button')[1]);
    await settle();
    const empty = strips(g.doc).find((s) => s.dataset.i === '22');
    assert.ok(empty.querySelector('.sendpad').disabled);
    assert.match(empty.querySelector('.sendpad').textContent, /NO AUDIO/);
    const n = g.sent.filter((m) => m.t === 'auxon').length;
    click(empty.querySelector('.sendpad'));
    assert.equal(g.sent.filter((m) => m.t === 'auxon').length, n);
  } finally { await g.done(); }
});

test('live patches from the bridge update the strips (cut, level, label, route)', async () => {
  const g = await boot();
  try {
    g.deliver({ t: 'batch', patches: [
      { t: 'f', i: 0, p: { level: 760, cut: true, label: 'HOST' } },
      { t: 'route', i: 1, bytes: Model.setBit(new Array(24).fill(0), 0, true) },
    ] });
    await settle();
    const s = strips(g.doc)[0];
    assert.equal(s.querySelector('.lcd').textContent, 'HOST');
    assert.equal(s.querySelector('.readout').textContent.replace(/\s/g, ''), '0.0dB');
    assert.ok(s.querySelector('.btn[data-kind="cut"]').classList.contains('on'));
    assert.ok(s.querySelectorAll('.btn[data-kind="route"]')[1].classList.contains('on'));
  } finally { await g.done(); }
});

test('fader: keyboard and drag send level commands; lock blocks them; unity on double-click', async () => {
  const g = await boot();
  try {
    const W = g.w;
    const knob = strips(g.doc)[0].querySelector('.knob');
    knob.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await sleep(50);
    const lv = g.sent.filter((m) => m.t === 'level');
    assert.equal(lv.at(-1).i, 0);
    assert.equal(lv.at(-1).v, g.desk.state.faders[0].level + 5);

    // drag: pointer events (jsdom height is 0 -> trackH falls back to 1, any move saturates)
    knob.dispatchEvent(new W.MouseEvent('pointerdown', { bubbles: true, clientY: 100 }));
    knob.dispatchEvent(new W.MouseEvent('pointermove', { bubbles: true, clientY: 100 - 0.01 }));
    knob.dispatchEvent(new W.MouseEvent('pointerup', { bubbles: true }));
    await sleep(50);
    assert.ok(g.sent.filter((m) => m.t === 'level').length >= 2);

    knob.dispatchEvent(new W.MouseEvent('dblclick', { bubbles: true }));
    await sleep(50);
    assert.equal(g.sent.filter((m) => m.t === 'level').at(-1).v, 760);

    // lock blocks every control, including send pads
    click(g.doc.querySelector('#btn-lock'));
    const n = g.sent.length;
    knob.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    click(strips(g.doc)[1].querySelector('.btn[data-kind="cut"]'));
    click(viewBtn(g.doc, 'sends'));
    await settle();
    click(strips(g.doc)[0].querySelector('.sendpad'));
    await sleep(50);
    assert.equal(g.sent.length, n);
    assert.ok(g.doc.body.classList.contains('locked'));
  } finally { await g.done(); }
});

test('settings: connect sends host/port, layout options re-page, cut style switches to ON', async () => {
  const g = await boot();
  try {
    assert.equal(g.doc.querySelector('#set-host').value, '10.1.1.5'); // prefilled from last-used
    assert.equal(g.doc.querySelector('#set-port').value, '49201');
    g.doc.querySelector('#set-host').value = '10.9.9.9';
    g.doc.querySelector('#set-port').value = '49200';
    click(g.doc.querySelector('#set-connect'));
    assert.deepEqual(g.sent.at(-1), { t: 'connect', host: '10.9.9.9', port: 49200 });

    const n = g.doc.querySelector('#set-n');
    n.value = '8';
    n.dispatchEvent(new g.w.Event('change'));
    await settle();
    assert.equal(strips(g.doc).length, 8);
    assert.equal(g.app.ui.surfaceFaders, 8);

    const cs = g.doc.querySelector('#set-cut');
    cs.value = 'on';
    cs.dispatchEvent(new g.w.Event('change'));
    await settle();
    const b = byLabel(g.doc, 'MIC 4').querySelector('.btn.big:last-child'); // cut on desk -> ON button not lit
    assert.equal(b.textContent, 'ON');
    assert.ok(!b.classList.contains('on'));
  } finally { await g.done(); }
});

test('overlay appears when offline, bridge banner when the socket drops', async () => {
  const g = await boot();
  try {
    assert.ok(g.doc.querySelector('#overlay').hidden);
    g.deliver({ t: 'batch', patches: [{ t: 'conn', conn: { status: 'offline', host: '', port: 0 } }] });
    await settle();
    assert.ok(!g.doc.querySelector('#overlay').hidden);
    assert.match(g.doc.querySelector('#overlay').textContent, /Not connected/);
    g.ws.onclose();
    await settle();
    assert.ok(!g.doc.querySelector('#bridge-banner').hidden);
    assert.equal(g.doc.querySelector('#pill').lastChild.textContent, 'NO BRIDGE');
  } finally { await g.done(); }
});

test('log panel shows traffic lines, hex toggle', async () => {
  const g = await boot();
  try {
    g.deliver({ t: 'batch', patches: [
      { t: 'log', ts: 1000, dir: 'tx', hex: 'f1 02 00 00 08 f8', text: 'console info' },
      { t: 'log', ts: 1001, dir: 'rx', text: 'fader 1 level 700' },
    ] });
    await sleep(40);
    const lines = [...g.doc.querySelectorAll('#logbody > div')];
    assert.equal(lines.length, 2);
    assert.match(lines[0].textContent, /TX console info/);
    assert.equal(lines[0].querySelector('.hex').style.display, 'none');
    const cb = g.doc.querySelector('#log-hex');
    cb.checked = true;
    cb.dispatchEvent(new g.w.Event('change'));
    assert.equal(lines[0].querySelector('.hex').style.display, '');
  } finally { await g.done(); }
});

test('cloned faders (same type + Calrec ID) are flagged; unique IDs and constant IDs are not', async () => {
  const g = await boot();
  try {
    assert.equal(g.doc.querySelectorAll('#bay .strip.clone').length, 0); // mock IDs are unique
    g.deliver({ t: 'batch', patches: [{ t: 'f', i: 1, p: { type: 1, id: g.app.state.faders[0].id } }] });
    await settle();
    assert.deepEqual([...g.doc.querySelectorAll('#bay .strip.clone')].map((s) => s.dataset.i), ['0', '1']);
    assert.match(strips(g.doc)[1].title, /Possible clone: same path as protocol fader 0/);
    g.deliver({ t: 'batch', patches: [{ t: 'f', i: 1, p: { id: 4242 } }] });
    await settle();
    assert.equal(g.doc.querySelectorAll('#bay .strip.clone').length, 0);
    // desk that reports one constant ID everywhere must NOT light up every strip
    g.deliver({ t: 'batch', patches: g.app.state.faders.map((f, i) => ({ t: 'f', i, p: { id: f.type ? 7 : 0 } })) });
    await sleep(80);
    assert.equal(g.doc.querySelectorAll('#bay .strip.clone').length, 0);
  } finally { await g.done(); }
});
