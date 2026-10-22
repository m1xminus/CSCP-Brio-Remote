'use strict';
// Public surface of the protocol core (reusable from a Bitfocus Companion module).
module.exports = {
  ...require('./frame'),
  ...require('./messages'),
  ...require('./mirror'),
  CscpClient: require('./client').CscpClient,
  Desk: require('./desk').Desk,
  Levels: require('../shared/levels'),
  Model: require('../shared/model'),
};
