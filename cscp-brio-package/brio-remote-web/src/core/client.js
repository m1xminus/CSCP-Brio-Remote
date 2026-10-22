'use strict';
/**
 * Raw CSCP TCP client: connect/reconnect, framing, heartbeat, and a
 * rate-limited, coalescing send queue.
 *
 * Send limits (from the Calrec doc): the desk processes <= 3 messages per 20 ms
 * (burst or sustained). We enforce that as a sliding window. The window is 25 ms
 * (20 ms + 25% margin) because timer jitter and network/OS batching on the way to
 * the desk can squeeze two spaced bursts together; measured with the 20 ms
 * window the sender still put up to 6 messages inside 20 ms, with 25 ms it never
 * exceeds 3. Cost: ~120 msg/s sustained instead of 150.
 */
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { StreamParser, parseOne, decodeNak } = require('./frame');
const { decode, R } = require('./messages');

// Sub-millisecond monotonic clock: Date.now() (1 ms steps, can jump) is not good enough
// to police a 3-messages-per-20-ms limit.
const now = () => Number(process.hrtime.bigint()) / 1e6;

class CscpClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = Object.assign(
      {
        windowMs: 25,
        perWindow: 3,
        tickMs: 5,
        heartbeatMs: 5000,
        deadAfterMs: 15000,
        connectTimeoutMs: 5000,
        staleFrameMs: 1500,
        backoffMs: [500, 1000, 2000, 5000, 10000],
      },
      opts
    );
    this.host = null;
    this.port = null;
    this.socket = null;
    this.parser = null;
    this.status = 'disconnected'; // disconnected | connecting | connected | reconnecting
    this.wantOnline = false;
    this.attempt = 0;
    this.queue = [];
    this.seq = 0;
    this.lastSent = new Map();
    this.sentTimes = [];
    this.lastRx = 0;
    this.timers = { tick: null, hb: null, reconnect: null, stale: null };
  }

  get connected() {
    return this.status === 'connected';
  }

  connect(host, port) {
    this._teardownSocket();
    clearTimeout(this.timers.reconnect);
    this.host = host;
    this.port = port;
    this.wantOnline = true;
    this.attempt = 0;
    this._open();
  }

  disconnect() {
    this.wantOnline = false;
    clearTimeout(this.timers.reconnect);
    this._teardownSocket();
    this._clearTimers();
    this.queue = [];
    this._setStatus('disconnected');
  }

  /**
   * Queue a frame. `build` is called at send time so a re-queued key always
   * sends the newest value. Entries with the same key replace each other.
   *   prio 0 = writes/interactive, 1 = bulk reads
   *   gap    = minimum ms between sends of this key (per-fader rate cap)
   */
  enqueue({ key, build, prio = 0, gap = 0 }) {
    if (!this.connected) return false;
    const existing = this.queue.find((e) => e.key === key);
    if (existing) {
      existing.build = build;
      existing.gap = gap;
      existing.prio = Math.min(existing.prio, prio);
    } else {
      this.queue.push({ key, build, prio, gap, seq: ++this.seq });
    }
    this._startTick();
    return true;
  }

  /** Send immediately, bypassing queue and rate limit (only for the wake-up read). */
  sendRaw(buf) {
    if (!this.socket || !this.connected) return false;
    this._write(buf);
    this.sentTimes.push(now()); // still counts against the 3-per-20ms window
    return true;
  }

  // ---------------------------------------------------------------- internals
  _setStatus(s, extra) {
    this.status = s;
    this.emit('status', s, extra);
  }

  _open() {
    this._setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting', { host: this.host, port: this.port });
    const s = net.createConnection({ host: this.host, port: this.port });
    this.socket = s;
    s.setNoDelay(true);
    s.setKeepAlive(true, 10000);
    const connectTimer = setTimeout(() => s.destroy(new Error('connect timeout')), this.opts.connectTimeoutMs);

    s.once('connect', () => {
      clearTimeout(connectTimer);
      if (this.socket !== s) return;
      this.attempt = 0;
      this.lastRx = Date.now();
      this.parser = new StreamParser();
      this.parser.on('frame', (f) => this._onFrame(f));
      this.parser.on('ack', () => this.emit('ack'));
      this.parser.on('nak', (code) => this.emit('nak', code, decodeNak(code)));
      this._setStatus('connected', { host: this.host, port: this.port });
      this.timers.hb = setInterval(() => this._heartbeat(), this.opts.heartbeatMs);
      // "Unsolicited" updates only start after the desk has seen a valid message.
      this.sendRaw(R.info());
    });
    s.on('data', (chunk) => {
      if (this.socket !== s || !this.parser) return;
      this.lastRx = Date.now();
      this.parser.push(chunk);
      clearTimeout(this.timers.stale);
      if (this.parser.pending) {
        this.timers.stale = setTimeout(() => this.parser && this.parser.dropStale(), this.opts.staleFrameMs);
      }
    });
    s.on('error', (e) => this.emit('neterror', e));
    s.on('close', () => {
      clearTimeout(connectTimer);
      if (this.socket !== s) return;
      this.socket = null;
      this._clearTimers();
      this.queue = [];
      this.lastSent.clear();
      this.sentTimes = [];
      if (this.wantOnline) {
        const b = this.opts.backoffMs;
        const delay = b[Math.min(this.attempt, b.length - 1)];
        this.attempt++;
        this._setStatus('reconnecting', { host: this.host, port: this.port, retryInMs: delay });
        this.timers.reconnect = setTimeout(() => this._open(), delay);
      } else {
        this._setStatus('disconnected');
      }
    });
  }

  _teardownSocket() {
    const s = this.socket;
    this.socket = null;
    this.parser = null;
    if (s) s.destroy();
  }

  _clearTimers() {
    clearInterval(this.timers.tick);
    clearInterval(this.timers.hb);
    clearTimeout(this.timers.stale);
    this.timers.tick = this.timers.hb = this.timers.stale = null;
  }

  _heartbeat() {
    if (Date.now() - this.lastRx > this.opts.deadAfterMs) {
      this.emit('neterror', new Error('desk silent - dropping connection'));
      if (this.socket) this.socket.destroy();
      return;
    }
    this.enqueue({ key: 'hb', build: R.info, prio: 0 });
  }

  _onFrame(frame) {
    const msg = decode(frame);
    this.emit('rx', frame, msg);
    this.emit('message', msg);
  }

  _write(buf) {
    this.socket.write(buf);
    this.emit('tx', buf, parseOne(buf));
  }

  _startTick() {
    if (this.timers.tick) return;
    this.timers.tick = setInterval(() => this._tick(), this.opts.tickMs);
  }

  _tick() {
    if (!this.connected || !this.socket) return;
    const t = now();
    const { windowMs, perWindow } = this.opts;
    this.sentTimes = this.sentTimes.filter((x) => t - x < windowMs);
    let budget = perWindow - this.sentTimes.length;
    if (budget > 0 && this.queue.length) {
      const order = [...this.queue].sort((a, b) => a.prio - b.prio || a.seq - b.seq);
      const sent = new Set();
      for (const e of order) {
        if (budget <= 0) break;
        if (e.gap && t - (this.lastSent.get(e.key) ?? -Infinity) < e.gap) continue;
        this._write(e.build());
        this.lastSent.set(e.key, t);
        this.sentTimes.push(t);
        sent.add(e);
        budget--;
      }
      if (sent.size) this.queue = this.queue.filter((e) => !sent.has(e));
    }
    if (!this.queue.length) {
      clearInterval(this.timers.tick);
      this.timers.tick = null;
    }
  }
}

module.exports = { CscpClient };
