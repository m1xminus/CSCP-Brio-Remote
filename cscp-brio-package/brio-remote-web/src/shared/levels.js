/* Protocol level (0-1023) <-> dB. Runs in Node and in the browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CSCPLevels = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Piecewise-linear fit of the appendix table in the Calrec CSCP document.
  // Max error vs the table is ~0.1 dB. [level, dB] breakpoints.
  const CURVES = {
    // Channel / group / VCA / aux output (command 7.3, 7.13)
    ch: { pts: [[40, -100], [80, -60], [162, -40], [519, -10], [760, 0], [1004, 10]], off: 49 },
    // Main fader (command 7.7)
    main: { pts: [[40, -100], [80, -70], [162, -50], [519, -20], [760, -10], [1004, 0]], off: 42 },
  };
  const LEVEL_MAX = 1023;
  // Level that gives 0 dB on the fader scale (table: ch 760 = 0.0 dB; main 1004 = 0.0 dB)
  const UNITY = { ch: 760, main: 1004 };

  const curveOf = (c) => CURVES[c] || CURVES.ch;

  function clampLevel(v) {
    v = Math.round(Number(v));
    if (!(v >= 0)) return 0;
    return Math.min(LEVEL_MAX, v);
  }

  function levelToDb(level, c) {
    const { pts } = curveOf(c);
    if (level <= pts[0][0]) return -100;
    const last = pts[pts.length - 1];
    if (level >= last[0]) return last[1];
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, da] = pts[i];
      const [b, db] = pts[i + 1];
      if (level >= a && level <= b) return da + ((db - da) * (level - a)) / (b - a);
    }
    return -100;
  }

  function dbToLevel(db, c) {
    const { pts } = curveOf(c);
    if (db <= pts[0][1]) return 0;
    const last = pts[pts.length - 1];
    if (db >= last[1]) return last[0];
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, da] = pts[i];
      const [b, dbb] = pts[i + 1];
      if (db >= da && db <= dbb) return Math.round(a + ((b - a) * (db - da)) / (dbb - da));
    }
    return 0;
  }

  /** Levels at or below this value are "audio off" on the desk. */
  const offLevel = (c) => curveOf(c).off;
  const isOff = (level, c) => level <= curveOf(c).off;

  function formatDb(level, c) {
    if (isOff(level, c)) return '-∞';
    const d = levelToDb(level, c);
    return (d > 0 ? '+' : '') + d.toFixed(1);
  }

  return { CURVES, LEVEL_MAX, UNITY, clampLevel, levelToDb, dbToLevel, offLevel, isOff, formatDb };
});
