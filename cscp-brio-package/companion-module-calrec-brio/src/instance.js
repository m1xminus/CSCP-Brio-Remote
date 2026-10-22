'use strict';
const { InstanceBase, InstanceStatus, Regex } = require('@companion-module/base');
const { Controller } = require('./controller');
const { allChoices, signature } = require('./choices');
const { buildActions } = require('./actions');
const { buildFeedbacks } = require('./feedbacks');
const { buildPresets } = require('./presets');
const Variables = require('./variables');
const { handleHttp } = require('./http');

const DEFAULT_PORT = 49200;

class BrioInstance extends InstanceBase {
  async init(config) {
    this.config = config || {};
    this.ctl = new Controller();
    this._dirty = null;
    this._sig = '';
    this.ctl.on('patches', () => this._schedule());
    this.ctl.on('layout', () => this._rebuild(true));
    this.ctl.on('log', (l) => this._onLog(l));
    this.ctl.configure(this.config); // builds definitions via the 'layout' event
    this._connect();
  }

  async destroy() {
    clearTimeout(this._flushTimer);
    clearTimeout(this._rebuildTimer);
    if (this.ctl) this.ctl.close();
  }

  async configUpdated(config) {
    const old = this.config || {};
    this.config = config || {};
    this.ctl.configure(this.config);
    if (old.host !== this.config.host || old.port !== this.config.port) this._connect();
  }

  getConfigFields() {
    return [
      { type: 'static-text', id: 'info', width: 12, label: 'Calrec Brio (CSCP)',
        value: 'Enable remote control on the desk (External Controls) and make sure it has a CSCP port. The computer needs an address in the same network as the desk.' },
      { type: 'textinput', id: 'host', label: 'Desk IP address', width: 8, default: '192.168.0.10', regex: Regex.IP },
      { type: 'number', id: 'port', label: 'CSCP TCP port', width: 4, default: DEFAULT_PORT, min: 1, max: 65535, asInteger: true },
      { type: 'number', id: 'surfaceFaders', label: 'Surface faders controlled over CSCP', width: 6, default: 36, min: 1, max: 96, asInteger: true,
        tooltip: 'Brio = 36 (three blocks of 12). Fader names A1..A36 / B1..B36 follow this.' },
      { type: 'number', id: 'layers', label: 'Layers', width: 3, default: 1, min: 1, max: 12, asInteger: true,
        tooltip: 'Brio = 1 layer with A and B.' },
      { type: 'checkbox', id: 'bLayerOff', label: 'B layer off', width: 3, default: false },
      { type: 'checkbox', id: 'verbose', label: 'Log every message to the Companion log (debug)', width: 12, default: false },
    ];
  }

  handleHttpRequest(request) {
    return handleHttp(this.ctl, request);
  }

  // --------------------------------------------------------------- internals
  _connect() {
    const host = String(this.config.host || '').trim();
    const port = Number(this.config.port) || DEFAULT_PORT;
    this.ctl.desk.disconnect();
    if (!host) {
      this.updateStatus(InstanceStatus.BadConfig, 'Set the desk IP address');
      return;
    }
    this.updateStatus(InstanceStatus.Connecting);
    this.ctl.connect(host, port);
  }

  _onLog(l) {
    if (l.dir === 'sys') this.log('info', l.text);
    else if (this.config.verbose) this.log('debug', `${l.dir} ${l.text || ''}`);
    else if (l.dir === 'rx' && /^NAK/.test(l.text || '')) this.log('warn', l.text);
  }

  _schedule() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flush();
    }, 60);
  }

  _flush() {
    const ch = allChoices(this.ctl);
    this.setVariableValues(Variables.values(this.ctl, ch));
    this.checkAllFeedbacks();
    this._status();
    if (signature(ch) !== this._sig) this._rebuild(false); // labels / available mains or auxes changed
  }

  _status() {
    const s = this.ctl.state.conn.status;
    if (s === 'online') this.updateStatus(InstanceStatus.Ok);
    else if (s === 'syncing') this.updateStatus(InstanceStatus.Connecting, 'Reading desk state');
    else if (s === 'offline') this.updateStatus(InstanceStatus.Disconnected);
    else this.updateStatus(InstanceStatus.Connecting);
  }

  /** (Re)publish dropdowns, feedbacks, variables and presets. Debounced unless `now`. */
  _rebuild(now) {
    clearTimeout(this._rebuildTimer);
    const go = () => {
      const ch = allChoices(this.ctl);
      this._sig = signature(ch);
      const fail = (e) => this.log('error', e.message || String(e));
      this.setActionDefinitions(buildActions(this.ctl, ch, fail));
      this.setFeedbackDefinitions(buildFeedbacks(this.ctl, ch));
      this.setVariableDefinitions(Variables.definitions(this.ctl, ch));
      const { structure, presets } = buildPresets(this.ctl, ch, this.label);
      this.setPresetDefinitions(structure, presets);
      this.setVariableValues(Variables.values(this.ctl, ch));
      this.checkAllFeedbacks();
    };
    if (now) go();
    else this._rebuildTimer = setTimeout(go, 1000);
  }
}

module.exports = { BrioInstance };
