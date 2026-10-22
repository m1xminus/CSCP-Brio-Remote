'use strict';
const { runEntrypoint } = require('@companion-module/base');
const { BrioInstance } = require('./instance');
const upgrades = require('./upgrades');

runEntrypoint(BrioInstance, upgrades);
