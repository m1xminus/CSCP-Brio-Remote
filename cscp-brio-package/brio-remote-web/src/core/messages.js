'use strict';
/**
 * Typed CSCP commands (section numbers refer to the Calrec document).
 * R.*  build READ request frames,   W.*  build WRITE frames,
 * decode(frame) turns any received frame (write form) into a plain message.
 */
const { encode } = require('./frame');

const CMD = {
  FADER_LEVEL: 0x0000, // 7.3
  FADER_CUT: 0x0001, // 7.4
  MAIN_LEVEL: 0x0002, // 7.7
  FADER_PFL: 0x0005, // 7.5
  NAME: 0x0007, // 7.1
  INFO: 0x0008, // 7.2
  FADER_LABEL: 0x000b, // 7.6
  MAIN_PFL: 0x000c, // 7.8
  MAIN_LABEL: 0x000d, // 7.9
  AVAIL_AUX: 0x0010, // 7.10
  ASSIGN: 0x0011, // 7.11
  AUX_ON: 0x0012, // 7.12
  AUX_LEVEL: 0x0013, // 7.13
  AVAIL_MAINS: 0x0014, // 7.15
  ROUTE: 0x0015, // 7.16
  LR: 0x0016, // 7.17
};
const WRITE = 0x8000;

const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];

const R = {
  name: () => encode(CMD.NAME),
  info: () => encode(CMD.INFO),
  faderLevel: (f) => encode(CMD.FADER_LEVEL, u16(f)),
  faderCut: (f) => encode(CMD.FADER_CUT, u16(f)),
  faderPfl: (f) => encode(CMD.FADER_PFL, u16(f)),
  faderLabel: (f) => encode(CMD.FADER_LABEL, u16(f)),
  mainLevel: (m) => encode(CMD.MAIN_LEVEL, u16(m)),
  mainPfl: (m) => encode(CMD.MAIN_PFL, u16(m)),
  mainLabel: (m) => encode(CMD.MAIN_LABEL, u16(m)),
  availAux: () => encode(CMD.AVAIL_AUX),
  availMains: () => encode(CMD.AVAIL_MAINS),
  assign: (f) => encode(CMD.ASSIGN, u16(f)),
  auxOn: (a) => encode(CMD.AUX_ON, [a]),
  auxLevel: (a) => encode(CMD.AUX_LEVEL, u16(a)),
  route: (m) => encode(CMD.ROUTE, [m]),
  lr: () => encode(CMD.LR),
};

const W = {
  faderLevel: (f, level) => encode(WRITE | CMD.FADER_LEVEL, [...u16(f), ...u16(level)]),
  /** cut=true silences the fader (protocol value 0); false = audio (1) */
  faderCut: (f, cut) => encode(WRITE | CMD.FADER_CUT, [...u16(f), cut ? 0 : 1]),
  faderPfl: (f, on) => encode(WRITE | CMD.FADER_PFL, [...u16(f), on ? 1 : 0]),
  mainLevel: (m, level) => encode(WRITE | CMD.MAIN_LEVEL, [...u16(m), ...u16(level)]),
  mainPfl: (m, on) => encode(WRITE | CMD.MAIN_PFL, [...u16(m), on ? 1 : 0]),
  auxOn: (a, bytes24) => encode(WRITE | CMD.AUX_ON, [a, 0, ...bytes24]),
  auxLevel: (a, level) => encode(WRITE | CMD.AUX_LEVEL, [...u16(a), ...u16(level)]),
  route: (m, bytes24) => encode(WRITE | CMD.ROUTE, [m, 0, ...bytes24]),
  lr: (bytes48) => encode(WRITE | CMD.LR, bytes48),
};

function ascii(buf) {
  let s = '';
  for (const b of buf) {
    if (b === 0) break; // may or may not be zero terminated
    s += b >= 32 && b < 127 ? String.fromCharCode(b) : ' ';
  }
  return s.replace(/\s+$/, '');
}

function decode(frame) {
  const write = (frame.cmd & WRITE) !== 0;
  const cmd = frame.cmd & 0x7fff;
  const d = frame.data;
  const be = (o) => (d[o] << 8) | d[o + 1];
  const has = (n) => d.length >= n;

  switch (cmd) {
    case CMD.NAME:
      return { type: 'name', name: ascii(d) };
    case CMD.INFO:
      if (!has(12)) break;
      return {
        type: 'info', version: be(0), maxFaders: be(2), maxMains: be(4),
        label: has(20) ? ascii(d.subarray(12, 20)) : ascii(d.subarray(12)),
      };
    case CMD.FADER_LEVEL:
      if (!has(4)) break;
      return { type: 'faderLevel', fader: be(0), level: be(2) };
    case CMD.FADER_CUT:
      if (!has(3)) break;
      return { type: 'faderCut', fader: be(0), cut: d[2] === 0 };
    case CMD.FADER_PFL:
      if (!has(3)) break;
      return { type: 'faderPfl', fader: be(0), pfl: d[2] !== 0 };
    case CMD.FADER_LABEL:
      if (!has(2)) break;
      return { type: 'faderLabel', fader: be(0), label: ascii(d.subarray(2)) };
    case CMD.MAIN_LEVEL:
      if (!has(4)) break;
      return { type: 'mainLevel', main: be(0), level: be(2) };
    case CMD.MAIN_PFL:
      if (!has(3)) break;
      return { type: 'mainPfl', main: be(0), pfl: d[2] !== 0 };
    case CMD.MAIN_LABEL:
      if (!has(2)) break;
      return { type: 'mainLabel', main: be(0), label: ascii(d.subarray(2)) };
    case CMD.AVAIL_AUX: {
      if (!has(3)) break;
      const avail = [];
      for (let n = 0; n < 20; n++) avail.push(((d[n >> 3] >> (n & 7)) & 1) === 1);
      return { type: 'availAux', avail };
    }
    case CMD.AVAIL_MAINS: {
      if (!has(1)) break;
      const avail = [];
      for (let n = 0; n < 16; n++) avail.push(n >> 3 < d.length && ((d[n >> 3] >> (n & 7)) & 1) === 1);
      return { type: 'availMains', avail };
    }
    case CMD.ASSIGN:
      if (!has(6)) break;
      return { type: 'assign', fader: be(0), audioType: d[2], width: d[3], id: be(4) };
    case CMD.AUX_ON:
      if (!has(26)) break;
      return { type: 'auxOn', aux: d[0], flags: d[1], bytes: Array.from(d.subarray(2, 26)) };
    case CMD.AUX_LEVEL:
      if (!has(4)) break;
      return { type: 'auxLevel', aux: be(0), level: be(2) };
    case CMD.ROUTE:
      if (!has(26)) break;
      return { type: 'route', main: d[0], flags: d[1], bytes: Array.from(d.subarray(2, 26)) };
    case CMD.LR:
      if (!has(48)) break;
      return { type: 'lr', bytes: Array.from(d.subarray(0, 48)) };
    default:
      break;
  }
  return { type: 'unknown', cmd, write, data: Array.from(d) };
}

/** One-line human description for the traffic log. */
function describe(m) {
  switch (m.type) {
    case 'name': return `console name "${m.name}"`;
    case 'info': return `console info v${m.version} maxFaders=${m.maxFaders} maxMains=${m.maxMains} label="${m.label}"`;
    case 'faderLevel': return `fader ${m.fader} level ${m.level}`;
    case 'faderCut': return `fader ${m.fader} ${m.cut ? 'CUT' : 'audio on'}`;
    case 'faderPfl': return `fader ${m.fader} PFL ${m.pfl ? 'on' : 'off'}`;
    case 'faderLabel': return `fader ${m.fader} label "${m.label}"`;
    case 'mainLevel': return `main ${m.main} level ${m.level}`;
    case 'mainPfl': return `main ${m.main} PFL ${m.pfl ? 'on' : 'off'}`;
    case 'mainLabel': return `main ${m.main} label "${m.label}"`;
    case 'availAux': return `available aux: ${m.avail.map((v, i) => (v ? i : null)).filter((v) => v !== null).join(',') || 'none'}`;
    case 'availMains': return `available mains: ${m.avail.map((v, i) => (v ? i : null)).filter((v) => v !== null).join(',') || 'none'}`;
    case 'assign': return `fader ${m.fader} assign type=${m.audioType} width=${m.width} id=${m.id}`;
    case 'auxOn': return `aux ${m.aux} sends [${bitList(m.bytes)}]`;
    case 'auxLevel': return `aux ${m.aux} output level ${m.level}`;
    case 'route': return `main ${m.main} routed from [${bitList(m.bytes)}]`;
    case 'lr': return 'L>B / R>B block';
    default: return `unknown cmd 0x${m.cmd.toString(16)} ${m.write ? 'W' : 'R'} [${m.data.join(' ')}]`;
  }
}
function bitList(bytes) {
  const out = [];
  for (let n = 0; n < bytes.length * 8; n++) if ((bytes[n >> 3] >> (n & 7)) & 1) out.push(n);
  return out.length > 12 ? `${out.slice(0, 12).join(',')},…(${out.length})` : out.join(',');
}

/** Pending-write key shared by write requests and echoed responses. */
function keyOf(m) {
  switch (m.type) {
    case 'faderLevel': return `lvl:${m.fader}`;
    case 'faderCut': return `cut:${m.fader}`;
    case 'faderPfl': return `pfl:${m.fader}`;
    case 'mainLevel': return `mlvl:${m.main}`;
    case 'mainPfl': return `mpfl:${m.main}`;
    case 'auxLevel': return `alvl:${m.aux}`;
    case 'auxOn': return `auxon:${m.aux}`;
    case 'route': return `route:${m.main}`;
    case 'lr': return 'lr';
    default: return null;
  }
}

module.exports = { CMD, WRITE, u16, R, W, decode, describe, keyOf, ascii };
