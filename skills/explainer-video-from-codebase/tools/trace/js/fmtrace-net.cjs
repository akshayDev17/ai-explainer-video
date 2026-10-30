// fmtrace-net.cjs — loaded with `node --require` into every Node process of a traced JavaScript / TypeScript test run.
// It records each outbound connect and DNS lookup the run attempts (the sandbox denies them all), so a test that failed
// for want of the network is listed as denied by the sandbox. It changes nothing the code sees: every call goes on to
// the real function. Written at exit to FM_TRACE_OUT, tagged with the test file this process ran (FM_TRACE_FILE).
'use strict';
const net = require('node:net');
const dns = require('node:dns');
const fs = require('node:fs');
const path = require('node:path');

const out = process.env.FM_TRACE_OUT;
const seen = new Set();
const note = s => { if (seen.size < 50) seen.add(s); };

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  try {
    const o = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (o && typeof o === 'object') note(o.path ? `connect ${o.path}` : `connect ${o.host || 'localhost'}:${o.port}`);
    else if (typeof o === 'string' && isNaN(Number(o))) note(`connect ${o}`);
    else note(`connect ${typeof args[1] === 'string' ? args[1] : 'localhost'}:${o}`);
  } catch {}
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) { note(`getaddrinfo ${host}`); return lookup.call(this, host, ...rest); };

process.on('exit', () => {
  if (!seen.size || !out) return;
  try { fs.writeFileSync(path.join(out, `net-${process.pid}-${Date.now()}.json`), JSON.stringify({ file: process.env.FM_TRACE_FILE || null, attempts: [...seen] })); } catch {}
});
