(function () {
  'use strict';
  const L = window.CSCPLevels;
  const M = window.CSCPModel;
  const $ = (s) => document.querySelector(s);
  const raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : (f) => setTimeout(f, 16);

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }

  // ------------------------------------------------------------ settings
  const LS_KEY = 'cscpbrio.ui.v2';
  const VIEWS = [['faders', 'FADERS'], ['groups', 'GROUPS'], ['mains', 'MAINS'], ['outputs', 'OUTPUTS'], ['sends', 'AUX SENDS']];
  // Brio 36: 36 controlled surface faders, shown as 3 divisions of 12, with an A/B sub-layer and one layer.
  const DEFAULTS = { surfaceFaders: 36, block: 12, layers: 1, bLayerOff: false, view: 'faders', layer: 1, sub: 'A', div: 0, gpage: 0, aux: -1, cutStyle: 'cut', showHex: false };
  function loadUi() {
    let u;
    try { u = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch { u = Object.assign({}, DEFAULTS); }
    if (!VIEWS.some(([v]) => v === u.view)) u.view = 'faders'; // older saved layouts used other names
    if (!Number.isInteger(u.aux)) u.aux = -1;
    return u;
  }
  function saveUi() { try { localStorage.setItem(LS_KEY, JSON.stringify(ui)); } catch { /* private mode */ } }
  const ui = loadUi();

  let state = M.createState();
  let serverInfo = { mode: 'idle', last: {} };
  let bridgeUp = false;
  let locked = false;
  let ws = null;

  // -------------------------------------------------------------- network
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function cmd(o) { if (!locked) send(o); }

  function openSocket() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      bridgeUp = true;
      if ($('#btn-log').getAttribute('aria-pressed') === 'true') send({ t: 'log', on: true });
      dirty.header = true;
      schedule();
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'full') {
        M.applyPatch(state, { t: 'full', state: m.state });
        cloneCache = null;
        serverInfo = m.server || serverInfo;
        prefillSettings();
        dirty.structure = true;
        dirty.header = true;
      } else if (m.t === 'batch') {
        for (const p of m.patches) onPatch(p);
      }
      schedule();
    };
    ws.onclose = () => {
      bridgeUp = false;
      dirty.header = true;
      schedule();
      setTimeout(openSocket, 1000);
    };
  }

  // ---------------------------------------------------------------- dirty
  const dirty = { structure: true, header: true, all: false, master: false, faders: new Set() };
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    raf(flush);
  }

  function onPatch(p) {
    if (p.t === 'log') return addLog(p);
    M.applyPatch(state, p);
    switch (p.t) {
      case 'f':
        dirty.faders.add(p.i);
        if ('type' in p.p || 'id' in p.p) {
          cloneCache = null;
          clones().forEach((_, k) => dirty.faders.add(k));
          for (const [k, s] of strips) if (s.el.classList.contains('clone')) dirty.faders.add(k);
        }
        if (ui.view === 'groups' && 'type' in p.p) dirty.structure = true;
        break;
      case 'm': case 'a':
        dirty.master = true;
        if ('avail' in p.p) dirty.structure = true;
        break;
      case 'auxOn': case 'route': dirty.all = true; break;
      case 'info': case 'reset': cloneCache = null; dirty.structure = true; dirty.header = true; break;
      case 'conn': case 'name': dirty.header = true; break;
      default: break;
    }
  }

  function flush() {
    scheduled = false;
    if (dirty.structure) {
      rebuildToolbar();
      rebuildBay();
    } else {
      if (dirty.all) { strips.forEach((s) => s.update()); others.forEach((s) => s.update()); }
      else {
        dirty.faders.forEach((i) => strips.get(i) && strips.get(i).update());
        if (dirty.master) others.forEach((s) => s.update());
      }
    }
    if (dirty.header || dirty.structure) renderHeader();
    dirty.structure = dirty.header = dirty.all = dirty.master = false;
    dirty.faders.clear();
  }

  function setView(v) {
    ui.view = v;
    saveUi();
    dirty.structure = true;
    schedule();
  }

  // ---------------------------------------------------------------- fader
  function makeFader(curve, onInput, onRelease) {
    const marks = curve === 'main' ? [0, -5, -10, -20, -30, -40, -50] : [10, 5, 0, -5, -10, -20, -30, -40];
    const scale = h('div', { class: 'scale' });
    for (const db of marks) {
      const lv = L.dbToLevel(db, curve);
      scale.append(h('div', { class: 'tick' + (db === 0 ? ' zero' : ''), style: `bottom:${(lv / 1023) * 100}%` },
        h('span', { text: (db > 0 ? '+' : '') + db })));
    }
    scale.append(h('div', { class: 'tick off', style: `bottom:${(L.offLevel(curve) / 1023) * 100}%` }, h('span', { text: '∞' })));

    const knob = h('div', { class: 'knob', tabindex: '0', role: 'slider', 'aria-valuemin': '0', 'aria-valuemax': '1023' }, h('i'));
    const track = h('div', { class: 'track' }, h('div', { class: 'slot' }), knob);
    const el = h('div', { class: 'fader' }, scale, track);

    let value = 0, dragging = false, heldUntil = 0, startY = 0, startV = 0, trackH = 1, lastShift = false, pendingSend = null;

    function setValue(v) {
      value = v;
      knob.style.bottom = `calc(${((v / 1023) * 100).toFixed(2)}% - 22px)`;
      knob.setAttribute('aria-valuenow', String(v));
      knob.setAttribute('aria-valuetext', L.formatDb(v, curve) + ' dB');
    }
    function user(v) {
      v = L.clampLevel(v);
      if (v === value) return;
      setValue(v);
      if (pendingSend === null) {
        pendingSend = raf(() => { pendingSend = null; onInput(value); });
      }
    }
    knob.addEventListener('pointerdown', (e) => {
      if (locked) return;
      e.preventDefault();
      if (knob.setPointerCapture) { try { knob.setPointerCapture(e.pointerId); } catch { /* synthetic */ } }
      dragging = true;
      startY = e.clientY; startV = value; lastShift = e.shiftKey;
      trackH = track.getBoundingClientRect().height || 1;
    });
    knob.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      if (e.shiftKey !== lastShift) { lastShift = e.shiftKey; startY = e.clientY; startV = value; } // fine mode re-base
      const k = e.shiftKey ? 0.25 : 1;
      user(startV + ((startY - e.clientY) / trackH) * 1023 * k);
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      heldUntil = Date.now() + 400;
      setTimeout(onRelease, 450); // re-align with what the desk finally said
    };
    knob.addEventListener('pointerup', end);
    knob.addEventListener('pointercancel', end);
    knob.addEventListener('dblclick', () => { if (!locked) user(L.UNITY[curve]); });
    knob.addEventListener('keydown', (e) => {
      if (locked) return;
      const step = e.shiftKey ? 1 : e.ctrlKey || e.metaKey ? 25 : 5;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') user(value + step);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') user(value - step);
      else if (e.key === 'PageUp') user(value + 50);
      else if (e.key === 'PageDown') user(value - 50);
      else if (e.key === 'Home') user(L.UNITY[curve]);
      else return;
      e.preventDefault();
    });

    return {
      el,
      get value() { return value; },
      external(v) { if (dragging || Date.now() < heldUntil) return; setValue(v); },
      set: setValue,
    };
  }

  function readout(curve) {
    const el = h('div', { class: 'readout' });
    return {
      el,
      set(level) {
        const off = L.isOff(level, curve);
        el.className = 'readout' + (off ? ' off' : '');
        el.replaceChildren(document.createTextNode(L.formatDb(level, curve)), h('small', { text: off ? '' : 'dB' }));
      },
    };
  }

  function btn(text, kind, onclick, extra) {
    return h('button', { class: 'btn' + (extra ? ' ' + extra : ''), type: 'button', 'data-kind': kind, onclick, text });
  }
  const setOn = (b, on) => b.classList.toggle('on', !!on);

  /** Wire a fader + readout pair so the readout follows the user's drag immediately. */
  function linkReadout(fader, ro) {
    for (const ev of ['pointermove', 'keydown', 'dblclick']) fader.el.addEventListener(ev, () => ro.set(fader.value));
  }

  const availMains = () => state.mains.map((m, i) => (m.avail ? i : -1)).filter((i) => i >= 0);
  const availAux = () => state.aux.map((a, i) => (a.avail ? i : -1)).filter((i) => i >= 0);

  /** Colour family of a fader's displays, by CSCP audio type (7.11). */
  function family(f) {
    switch (f.type) {
      case 1: return 'ch';
      case 2: return 'grp';
      case 3: case 4: case 5: case 7: case 9: case 11: return 'vca';
      case 6: return 'main';
      case 8: return 'trk';
      case 10: return 'aux';
      default: return 'none';
    }
  }

  // Cloned faders (CSCP doc 2.2.2): the same path on two protocol faders. Bitmap writes
  // (aux send, route, L>B/R>B) are applied fader-by-fader and the LAST one wins, so a clone
  // can silently undo a switch. Detected via 7.11 audio type + Calrec ID. The doc also calls
  // the ID "not fully specified", so this is a heuristic: IDs of 0 are ignored, and detection
  // is switched off entirely if every assigned fader reports the same ID.
  let cloneCache = null;
  function clones() {
    if (cloneCache) return cloneCache;
    const groups = new Map();
    const ids = new Set();
    state.faders.forEach((f, i) => {
      if (f.type === 0 || f.id === 0) return;
      ids.add(f.id);
      const k = `${f.type}:${f.id}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    });
    const out = new Map();
    if (ids.size > 1) for (const g of groups.values()) if (g.length > 1) for (const i of g) out.set(i, g.filter((x) => x !== i));
    return (cloneCache = out);
  }

  // ---------------------------------------------------------------- strips
  const strips = new Map(); // protocol fader -> strip (FADERS and AUX SENDS views)
  const others = new Map(); // 'm0' / 'a3' -> main / aux-output strips

  /** One strip of the FADERS view (sends=false) or of the sends-on-fader view (sends=true). */
  function makeStrip(i, sends) {
    const r = {};
    const el = h('div', { class: 'strip' + (sends ? ' sends' : ''), 'data-i': String(i) });
    const surf = M.surfaceOf(i, ui.surfaceFaders, ui.bLayerOff);

    const where = `${ui.layers > 1 ? surf.layer + '.' : ''}${surf.pos + 1}${ui.bLayerOff ? '' : surf.sub}`;
    r.num = h('span', { class: 'num', text: ui.view === 'groups' ? where : String(surf.pos + 1),
      title: `Surface fader ${surf.pos + 1}, layer ${surf.layer}${ui.bLayerOff ? '' : surf.sub} \u2013 protocol fader #${i}` });
    r.badge = h('span', { class: 'badge' });
    r.lcd = h('div', { class: 'lcd' });
    r.pfl = btn('PFL', 'pfl', () => cmd({ t: 'pfl', i, on: !state.faders[i].pfl }), 'big');
    r.cut = btn('CUT', 'cut', () => cmd({ t: 'cut', i, cut: !state.faders[i].cut }), 'big');
    const head = h('div', { class: 'head' }, r.num, r.badge);

    if (!sends) {
      r.lb = btn('L>B', 'lr', () => { const f = state.faders[i]; cmd({ t: 'lr', i, lb: !f.lb, rb: f.rb }); });
      r.rb = btn('R>B', 'lr', () => { const f = state.faders[i]; cmd({ t: 'lr', i, lb: f.lb, rb: !f.rb }); });
      r.lr = h('div', { class: 'lrrow' }, r.lb, r.rb);
      r.routes = h('div', { class: 'routes' });
      r.routeBtns = new Map();
      r.routeKey = null;
      r.fader = makeFader('ch', (v) => cmd({ t: 'level', i, v }), () => r.update());
      r.readout = readout('ch');
      linkReadout(r.fader, r.readout);
      el.append(head, r.lcd, r.routes, r.lr, r.pfl, r.fader.el, r.readout.el, r.cut);
    } else {
      // CSCP only exposes the send ON/OFF switch (7.12), not a per-channel send level, so
      // the fader area becomes one big send switch instead of a fader that could not move anything.
      r.pad = h('button', {
        class: 'sendpad', type: 'button',
        onclick: () => {
          if (ui.aux < 0 || state.faders[i].type === 0) return;
          cmd({ t: 'auxon', aux: ui.aux, fader: i, on: !M.bit(state.auxOn[ui.aux], i) });
        },
      }, h('b', { class: 'sp-aux' }), h('span', { class: 'sp-state' }));
      el.append(head, r.lcd, r.pfl, r.pad, r.cut);
    }

    function rebuildRoutes(mains) {
      r.routeKey = mains.join(',');
      r.routeBtns.clear();
      r.routes.replaceChildren();
      r.routes.style.gridTemplateRows = `repeat(${Math.max(1, Math.ceil(mains.length / 3))}, 22px)`;
      for (const m of mains) {
        const b = btn(`M${m + 1}`, 'route', () => cmd({ t: 'route', main: m, fader: i, on: !M.bit(state.route[m], i) }));
        b.title = `Route to main ${m + 1}${state.mains[m].label ? ' (' + state.mains[m].label + ')' : ''}`;
        r.routeBtns.set(m, b);
        r.routes.append(b);
      }
    }

    function update() {
      const f = state.faders[i];
      const assigned = f.type !== 0;
      el.classList.toggle('empty', !assigned);
      const twins = clones().get(i);
      el.classList.toggle('clone', !!twins);
      el.title = twins
        ? `Possible clone: same path as protocol fader ${twins.join(', ')}. Aux/route/L>B switches on cloned faders can undo each other (CSCP doc 2.2.2).`
        : assigned ? '' : 'No audio assigned (a True Control remote path also reports this, but is still controllable)';
      r.lcd.textContent = f.label;
      r.lcd.dataset.f = family(f);
      el.dataset.f = family(f);
      const tb = M.typeBadge(f);
      r.badge.textContent = tb ? (f.width === 2 && f.type === 1 ? tb + '·ST' : tb) : '';
      setOn(r.pfl, f.pfl);
      if (ui.cutStyle === 'on') { r.cut.textContent = 'ON'; r.cut.dataset.kind = 'on'; setOn(r.cut, !f.cut); }
      else { r.cut.textContent = 'CUT'; r.cut.dataset.kind = 'cut'; setOn(r.cut, f.cut); }

      if (!sends) {
        r.lr.classList.toggle('vis-hide', !(assigned && f.width === 2 && (f.type === 1 || f.type === 2)));
        setOn(r.lb, f.lb); setOn(r.rb, f.rb);
        const mains = availMains();
        if (r.routeKey !== mains.join(',')) rebuildRoutes(mains);
        for (const [m, b] of r.routeBtns) setOn(b, M.bit(state.route[m], i));
        r.routes.classList.toggle('vis-hide', !assigned || !mains.length);
        r.fader.external(f.level);
        r.readout.set(r.fader.value);
      } else {
        const on = ui.aux >= 0 && M.bit(state.auxOn[ui.aux], i);
        r.pad.classList.toggle('on', on);
        r.pad.classList.toggle('na', !assigned);
        r.pad.disabled = !assigned;
        r.pad.querySelector('.sp-aux').textContent = `AUX ${ui.aux + 1}`;
        r.pad.querySelector('.sp-state').textContent = !assigned ? 'NO AUDIO' : on ? 'SEND ON' : 'SEND OFF';
        r.pad.title = assigned ? `Send ${on ? 'on' : 'off'} – CSCP exposes the on/off switch only, not the send level` : 'No audio assigned to this fader';
      }
    }
    r.update = update;
    r.el = el;
    update();
    return r;
  }

  function makeMainStrip(m) {
    const r = {};
    r.lcd = h('div', { class: 'lcd', 'data-f': 'main' });
    r.pfl = btn('PFL', 'pfl', () => cmd({ t: 'mpfl', i: m, on: !state.mains[m].pfl }), 'big');
    r.fader = makeFader('main', (v) => cmd({ t: 'mlevel', i: m, v }), () => r.update());
    r.readout = readout('main');
    linkReadout(r.fader, r.readout);
    r.el = h('div', { class: 'strip master', 'data-f': 'main' },
      h('div', { class: 'head' }, h('span', { class: 'num', text: `MAIN ${m + 1}` }), h('span', { class: 'badge', text: 'MAIN' })),
      r.lcd, r.pfl, r.fader.el, r.readout.el);
    r.update = () => {
      const x = state.mains[m];
      r.lcd.textContent = x.label || `MAIN ${m + 1}`;
      setOn(r.pfl, x.pfl);
      r.fader.external(x.level);
      r.readout.set(r.fader.value);
    };
    r.update();
    return r;
  }

  /** Aux OUTPUT master (7.13). jump=true adds a SENDS shortcut (OUTPUTS view). */
  function makeAuxStrip(a, jump) {
    const r = {};
    r.lcd = h('div', { class: 'lcd', 'data-f': 'aux', text: `AUX ${a + 1}` });
    r.fader = makeFader('ch', (v) => cmd({ t: 'alevel', i: a, v }), () => r.update());
    r.readout = readout('ch');
    linkReadout(r.fader, r.readout);
    const top = jump
      ? btn('SENDS', 'route', () => { ui.view = 'sends'; ui.aux = a; saveUi(); dirty.structure = true; schedule(); }, 'big')
      : h('div', { class: 'auxnote', text: 'OUTPUT LEVEL' });
    if (jump) top.title = 'Show the send switches for this aux on the fader strips';
    r.el = h('div', { class: 'strip auxm', 'data-f': 'aux' },
      h('div', { class: 'head' }, h('span', { class: 'num', text: 'AUX OUT' }), h('span', { class: 'badge', text: 'AUX' })),
      r.lcd, top, r.fader.el, r.readout.el);
    r.update = () => {
      r.fader.external(state.aux[a].level);
      r.readout.set(r.fader.value);
    };
    r.update();
    return r;
  }

  // ------------------------------------------------------------- bay/page
  const isGroupish = (f) => [2, 3, 5].includes(f.type); // group, VCA master, group that is a VCA slave (7.11 audio types)
  const groupIndices = () => state.faders.map((f, i) => (isGroupish(f) && i < state.protocolFaders ? i : -1)).filter((i) => i >= 0);
  const blocksOf = () => Math.max(1, Math.ceil(ui.surfaceFaders / ui.block));

  /** Protocol fader numbers on screen: the selected division of the selected layer / A-B. */
  function visibleIndices() {
    if (ui.view === 'groups') {
      const all = groupIndices();
      return all.slice(ui.gpage * ui.block, ui.gpage * ui.block + ui.block);
    }
    const pf = state.protocolFaders;
    const N = ui.surfaceFaders;
    const first = ui.div * ui.block;
    const count = Math.max(0, Math.min(ui.block, N - first));
    const out = [];
    for (let p = 0; p < count; p++) {
      const idx = M.protocolIndex(ui.layer, ui.sub, first + p, N, ui.bLayerOff);
      if (idx < pf) out.push(idx);
    }
    return out;
  }

  function rebuildBay() {
    const bay = $('#bay');
    strips.clear();
    others.clear();
    bay.replaceChildren();
    bay.dataset.view = ui.view;
    document.body.dataset.view = ui.view;
    const msg = (t) => bay.append(h('p', { class: 'empty-msg', text: t }));

    if (ui.view === 'groups') {
      const idx = visibleIndices();
      if (!idx.length) msg('No group or VCA master faders are assigned on this desk.');
      for (const i of idx) { const s = makeStrip(i, false); strips.set(i, s); bay.append(s.el); }
    } else if (ui.view === 'faders' || ui.view === 'sends') {
      const sends = ui.view === 'sends';
      if (sends && ui.aux < 0) msg('No aux outputs are available on this desk (an aux only appears once it has a width defined).');
      else {
        for (const i of visibleIndices()) { const s = makeStrip(i, sends); strips.set(i, s); bay.append(s.el); }
        if (sends) {
          const s = makeAuxStrip(ui.aux, false);
          others.set('a' + ui.aux, s);
          bay.append(h('div', { class: 'divider' }), s.el);
        }
      }
    } else if (ui.view === 'mains') {
      const ms = availMains();
      if (!ms.length) msg('No main outputs are available on this desk.');
      for (const m of ms) { const s = makeMainStrip(m); others.set('m' + m, s); bay.append(s.el); }
    } else {
      const as = availAux();
      if (!as.length) msg('No aux outputs are available on this desk.');
      for (const a of as) { const s = makeAuxStrip(a, true); others.set('a' + a, s); bay.append(s.el); }
    }
    renderOverlay();
  }

  function rebuildToolbar() {
    const tb = $('#toolbar');
    const as = availAux();
    if (ui.view === 'sends' && !as.includes(ui.aux)) ui.aux = as.length ? as[0] : -1;
    const maxLayers = M.layerCount(state.protocolFaders, ui.surfaceFaders, ui.bLayerOff);
    const layers = Math.max(1, Math.min(ui.layers, maxLayers));
    if (ui.layer > layers) ui.layer = layers;
    if (ui.bLayerOff) ui.sub = 'A';
    if (ui.div >= blocksOf()) ui.div = 0;
    const gcount = groupIndices().length;
    if (ui.gpage * ui.block >= Math.max(gcount, 1)) ui.gpage = 0;

    tb.replaceChildren();
    tb.append(h('div', { class: 'seg views', role: 'tablist' },
      ...VIEWS.map(([v, t]) => h('button', {
        class: (ui.view === v ? 'on ' : '') + (v === 'sends' ? 'sends' : ''), type: 'button', role: 'tab',
        'aria-selected': String(ui.view === v), 'data-view': v, text: t, onclick: () => setView(v),
      }))));

    const pick = (k, v) => { ui[k] = v; saveUi(); dirty.structure = true; schedule(); };
    const rangeLabel = (a, b) => `${a}\u2013${b}`;
    if (ui.view === 'faders' || ui.view === 'sends') {
      if (layers > 1) {
        tb.append(h('span', { class: 'tlabel', text: 'LAYER' }),
          h('div', { class: 'seg' }, ...Array.from({ length: layers }, (_, k) =>
            h('button', { class: ui.layer === k + 1 ? 'on' : '', type: 'button', text: String(k + 1), onclick: () => pick('layer', k + 1) }))));
      }
      if (!ui.bLayerOff) {
        tb.append(h('div', { class: 'seg ab', title: 'A / B sub-layer' }, ...['A', 'B'].map((x) =>
          h('button', { class: ui.sub === x ? 'on' : '', type: 'button', text: x, onclick: () => pick('sub', x) }))));
      }
      const nb = blocksOf();
      tb.append(h('div', { class: 'seg divs', title: 'Fader division' }, ...Array.from({ length: nb }, (_, k) => {
        const a = k * ui.block + 1, b = Math.min(ui.surfaceFaders, (k + 1) * ui.block);
        return h('button', { class: ui.div === k ? 'on' : '', type: 'button', text: rangeLabel(a, b), onclick: () => pick('div', k) });
      })));
      const idx = visibleIndices();
      if (idx.length) tb.append(h('span', { class: 'range', text: `protocol #${idx[0]}\u2013#${idx[idx.length - 1]}` }));
    }
    if (ui.view === 'groups') {
      const pages = Math.ceil(gcount / ui.block);
      if (pages > 1) {
        tb.append(h('div', { class: 'seg divs' }, ...Array.from({ length: pages }, (_, k) =>
          h('button', { class: ui.gpage === k ? 'on' : '', type: 'button', text: rangeLabel(k * ui.block + 1, Math.min(gcount, (k + 1) * ui.block)), onclick: () => pick('gpage', k) }))));
      }
      tb.append(h('span', { class: 'range', text: `${gcount} group / VCA master fader${gcount === 1 ? '' : 's'}, from every layer` }));
    }

    if (ui.view === 'sends') {
      if (as.length) {
        tb.append(h('span', { class: 'tlabel', text: 'AUX' }),
          h('div', { class: 'seg auxsel' }, ...as.map((a) =>
            h('button', { class: ui.aux === a ? 'on' : '', type: 'button', text: String(a + 1), title: `Aux ${a + 1}`,
              onclick: () => { ui.aux = a; saveUi(); dirty.structure = true; schedule(); } }))));
        tb.append(h('div', { class: 'sendsbanner', role: 'status' },
          h('i'), h('b', { text: `SENDS ON FADER · AUX ${ui.aux + 1}` }),
          h('small', { text: 'ON/OFF only – the desk does not expose send levels over CSCP' })));
      }
    }
  }

  // --------------------------------------------------------------- header
  const STATUS_TEXT = { offline: 'OFFLINE', connecting: 'CONNECTING', syncing: 'SYNCING', online: 'ONLINE', reconnecting: 'RECONNECTING' };

  function renderHeader() {
    const st = bridgeUp ? state.conn.status : 'offline';
    const pill = $('#pill');
    pill.dataset.status = st;
    pill.lastChild.textContent = bridgeUp ? STATUS_TEXT[st] || st.toUpperCase() : 'NO BRIDGE';
    const parts = [];
    if (state.name) parts.push(h('em', { text: state.name }));
    if (state.info) parts.push(`CSCP v${state.info.version}`, `${state.protocolFaders} faders`);
    if (state.conn.host && st !== 'offline') parts.push(`${state.conn.host}:${state.conn.port}`);
    if (serverInfo.mode === 'mock') parts.push('SIMULATED DESK');
    $('#deskinfo').replaceChildren(...(parts.length ? parts.flatMap((p, k) => (k ? [' · ', p] : [p])) : ['no desk']));
    $('#bridge-banner').hidden = bridgeUp;
    renderOverlay();
  }

  function renderOverlay() {
    const o = $('#overlay');
    const st = state.conn.status;
    const show = bridgeUp && (st === 'offline' || st === 'connecting');
    o.hidden = !show;
    if (!show) return;
    o.replaceChildren(h('div', { class: 'card' },
      h('h2', { text: st === 'connecting' ? 'Connecting…' : 'Not connected to a desk' }),
      h('p', { text: st === 'connecting'
        ? 'Waiting for the Calrec to answer on the CSCP port.'
        : 'Enter the Brio’s IP address and CSCP port in Settings, or try the interface against the built-in simulated desk.' }),
      h('div', { class: 'row' },
        h('button', { class: 'tbtn primary', type: 'button', text: 'Settings', onclick: () => openSettings(true) }),
        h('button', { class: 'tbtn', type: 'button', text: 'Run demo', onclick: () => send({ t: 'mock', on: true }) }))));
  }

  // ------------------------------------------------------------------ log
  let logCount = 0;
  const pad2 = (n) => String(n).padStart(2, '0');
  function addLog(e) {
    const body = $('#logbody');
    const d = new Date(e.ts || Date.now());
    const ts = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    const dir = e.dir === 'tx' ? 'TX' : e.dir === 'rx' ? 'RX' : '--';
    const stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
    const line = h('div', { class: e.dir }, `${ts} ${dir} ${e.text || ''}`);
    if (e.hex) line.append(h('span', { class: 'hex', style: ui.showHex ? '' : 'display:none', text: `   [${e.hex}]` }));
    body.append(line);
    if (++logCount > 500) { body.firstChild.remove(); logCount--; }
    if (stick) body.scrollTop = body.scrollHeight;
  }

  // ------------------------------------------------------------- settings
  function openSettings(on) { $('#settings').hidden = !on; }
  function prefillSettings() {
    const last = (serverInfo && serverInfo.last) || {};
    // only ever prefill with the last REAL desk address (never the simulator's loopback)
    if (!$('#set-host').value) $('#set-host').value = last.host || '';
    if (last.port && $('#set-port').dataset.touched !== '1') $('#set-port').value = last.port;
  }

  function wireUi() {
    $('#btn-settings').onclick = () => openSettings($('#settings').hidden);
    $('#set-close').onclick = () => openSettings(false);
    $('#btn-demo').onclick = () => send({ t: 'mock', on: true });
    $('#btn-lock').onclick = (e) => {
      locked = !locked;
      e.currentTarget.setAttribute('aria-pressed', String(locked));
      document.body.classList.toggle('locked', locked);
    };
    $('#btn-log').onclick = (e) => {
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(on));
      $('#logpanel').hidden = !on;
      send({ t: 'log', on });
    };
    $('#log-clear').onclick = () => { $('#logbody').replaceChildren(); logCount = 0; };
    $('#log-hex').checked = ui.showHex;
    $('#log-hex').onchange = (e) => {
      ui.showHex = e.target.checked; saveUi();
      document.querySelectorAll('#logbody .hex').forEach((n) => (n.style.display = ui.showHex ? '' : 'none'));
    };
    $('#set-port').oninput = (e) => (e.target.dataset.touched = '1');
    $('#set-connect').onclick = () => {
      const host = $('#set-host').value.trim();
      const port = Number($('#set-port').value);
      if (host && port > 0 && port < 65536) send({ t: 'connect', host, port });
    };
    $('#set-disconnect').onclick = () => send({ t: 'disconnect' });
    $('#set-resync').onclick = () => send({ t: 'resync' });

    $('#set-n').value = ui.surfaceFaders;
    $('#set-n').onchange = (e) => {
      ui.surfaceFaders = Math.max(1, Math.min(96, Number(e.target.value) || 36)); e.target.value = ui.surfaceFaders;
      ui.div = 0; saveUi(); dirty.structure = true; schedule();
    };
    $('#set-layers').value = ui.layers;
    $('#set-layers').onchange = (e) => {
      ui.layers = Math.max(1, Math.min(12, Number(e.target.value) || 1)); e.target.value = ui.layers;
      saveUi(); dirty.structure = true; schedule();
    };
    $('#set-boff').checked = ui.bLayerOff;
    $('#set-boff').onchange = (e) => { ui.bLayerOff = e.target.checked; saveUi(); dirty.structure = true; schedule(); };
    $('#set-cut').value = ui.cutStyle;
    $('#set-cut').onchange = (e) => { ui.cutStyle = e.target.value; saveUi(); dirty.all = true; schedule(); };

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openSettings(false); });
  }

  // ----------------------------------------------------------------- boot
  wireUi();
  dirty.structure = true;
  schedule();
  openSocket();

  // test hook
  window.__cscp = { state, ui, strips, others, flush, onPatch, get locked() { return locked; } };
})();
