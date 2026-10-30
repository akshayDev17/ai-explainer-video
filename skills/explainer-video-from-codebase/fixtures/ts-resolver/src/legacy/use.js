const legacy = require('./index');
const lib = require('./lib');

function go() {
  legacy('a');
  lib.helper();
}

if (require.main === module) {
  go();
}

module.exports = { go };
