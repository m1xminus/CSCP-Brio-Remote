'use strict';
/**
 * CSCP framing: F1 | BC | DEV | CMD_MSB | CMD_LSB | DATA... | CS
 *   BC = byte count of CMD+DATA (max 50)
 *   CS = two's complement of the byte sum of CMD+DATA
 * Single-byte ACK (0x04) and NAK (0x05 + error byte) travel outside frames.
 */
const { EventEmitter } = require('node:events');

const SOH = 0xf1;
const ACK = 0x04;
const NAK = 0x05;
const DEV_DESK = 0x00; // frames sent TO the Calrec
const DEV_CONTROLLER = 0xff; // the controller's own device number
const MAX_BC = 50;

// NAK error byte. The doc's bit-position figure is not in the text export. A real Brio (probe, 2026-10-22)
// answered an unknown command with 0x40 and a known command with the wrong data length with 0x05. That fits
// the doc's list read MSB-first: bit 6 = command not supported ... bit 2 = byte count, bit 0 = protocol
// (0x05 = byte count + protocol). Strongly suggested by the capture, still not confirmed by the doc's figure.
const NAK_BITS = {
  commandNotSupported: 0x40,
  timeout: 0x20,
  undefined: 0x10,
  interface: 0x08,
  byteCount: 0x04,
  checksum: 0x02,
  protocol: 0x01,
};

function decodeNak(byte) {
  return Object.entries(NAK_BITS)
    .filter(([, mask]) => byte & mask)
    .map(([name]) => name);
}

function checksum(bytes) {
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  return -sum & 0xff;
}

function encode(cmd, data = [], dev = DEV_DESK) {
  const body = Buffer.concat([Buffer.from([(cmd >> 8) & 0xff, cmd & 0xff]), Buffer.from(data)]);
  if (body.length > MAX_BC) throw new RangeError(`CSCP body ${body.length} > ${MAX_BC} bytes`);
  return Buffer.concat([Buffer.from([SOH, body.length, dev]), body, Buffer.from([checksum(body)])]);
}

/**
 * Incremental stream parser. Emits:
 *   'frame' {dev, cmd, data:Buffer}   (cmd keeps the write bit 0x8000)
 *   'ack'
 *   'nak'   (errorByte)
 * A 0xF1 inside a message is data when BC and CS validate; after corruption
 * the parser advances one byte at a time until it finds a valid frame.
 */
class StreamParser extends EventEmitter {
  constructor() {
    super();
    this.buf = Buffer.alloc(0);
    this.stats = { frames: 0, badChecksum: 0, skipped: 0 };
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    this._scan();
  }

  /** Called when a partial frame has been sitting too long: drop one byte and rescan. */
  dropStale() {
    if (!this.buf.length) return;
    this.stats.skipped++;
    this.buf = this.buf.subarray(1);
    this._scan();
  }

  get pending() {
    return this.buf.length;
  }

  _scan() {
    const b = this.buf;
    let i = 0;
    while (i < b.length) {
      const c = b[i];
      if (c === ACK) {
        this.emit('ack');
        i++;
        continue;
      }
      if (c === NAK) {
        if (i + 1 >= b.length) break;
        this.emit('nak', b[i + 1]);
        i += 2;
        continue;
      }
      if (c !== SOH) {
        this.stats.skipped++;
        i++;
        continue;
      }
      if (i + 1 >= b.length) break;
      const bc = b[i + 1];
      if (bc < 2 || bc > MAX_BC) {
        this.stats.skipped++;
        i++;
        continue;
      }
      const total = 3 + bc + 1;
      if (i + total > b.length) break; // wait for the rest
      const body = b.subarray(i + 3, i + 3 + bc);
      if (checksum(body) !== b[i + 3 + bc]) {
        this.stats.badChecksum++;
        i++;
        continue;
      }
      this.stats.frames++;
      this.emit('frame', {
        dev: b[i + 2],
        cmd: (body[0] << 8) | body[1],
        data: Buffer.from(body.subarray(2)),
      });
      i += total;
    }
    this.buf = b.subarray(i);
  }
}

/** Parse exactly one frame out of a buffer (used for logging what we sent). */
function parseOne(buf) {
  const p = new StreamParser();
  let out = null;
  p.on('frame', (f) => (out = f));
  p.push(buf);
  return out;
}

module.exports = {
  SOH, ACK, NAK, DEV_DESK, DEV_CONTROLLER, MAX_BC, NAK_BITS,
  checksum, encode, decodeNak, StreamParser, parseOne,
};
