'use strict';
// Standalone simulated desk:  node src/mock/run.js [port] [--wiggle]
const { MockDesk } = require('./mockDesk');
const args = process.argv.slice(2);
const port = Number(args.find((a) => /^\d+$/.test(a))) || 49200;
const mock = new MockDesk({ port, host: '0.0.0.0', wiggle: args.includes('--wiggle') });
mock.listen().then((p) => console.log(`Mock Calrec Brio listening on tcp/${p}`));
