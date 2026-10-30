// fmtrace-srcmap.cjs — loaded with `node --require` into every Node process and worker thread of a traced JavaScript /
// TypeScript test run. jest and vitest compile each file they transform through node:vm (jest: new vm.Script, vitest:
// vm.runInThisContext) with an inline source map, and Node's coverage dump records no source map for those scripts.
// So each one's map is recorded here, in the shape of Node's own source-map-cache entry (the compiled code's line
// lengths and the map's `mappings`), keyed by the script's file. It changes nothing the code sees: every call goes on
// to the real function with the same arguments. Written as it happens to FM_TRACE_OUT, tagged with the test file this
// process ran (FM_TRACE_FILE).
'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { threadId } = require('node:worker_threads');

const out = process.env.FM_TRACE_OUT;
const INLINE = /\/\/# sourceMappingURL=data:application\/json[^,\n]*;base64,([A-Za-z0-9+/=]+)/y;
let n = 0;
const note = (code, options) => {
  try {
    const file = typeof options === 'string' ? options : options?.filename;
    if (!out || typeof code !== 'string' || typeof file !== 'string' || file.includes('/node_modules/')) return;
    // the last inline map: the runner's own wrapper may close after it
    const at = code.lastIndexOf('//# sourceMappingURL=data:application/json');
    if (at < 0) return;
    INLINE.lastIndex = at;
    const b64 = INLINE.exec(code)?.[1];
    if (!b64) return;
    const { mappings } = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (typeof mappings !== 'string') return;
    const key = file.startsWith('file://') ? fileURLToPath(file) : file;
    fs.writeFileSync(path.join(out, `srcmap-${process.pid}-${threadId}-${n++}.json`),
      JSON.stringify({ file: process.env.FM_TRACE_FILE || null, url: key, lineLengths: code.split('\n').map(l => l.length), data: { mappings } }));
  } catch {}
};

const RealScript = vm.Script;
vm.Script = class Script extends RealScript { constructor(code, options) { note(code, options); super(code, options); } };
for (const name of ['runInThisContext', 'runInContext', 'runInNewContext']) {
  const real = vm[name], optionsAt = name === 'runInThisContext' ? 0 : 1;
  vm[name] = function (code, ...rest) { note(code, rest[optionsAt]); return real.call(this, code, ...rest); };
}
