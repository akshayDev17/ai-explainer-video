/* Rule pack: process spawn. `subprocess.Popen/run/call/check_*([...])` or `asyncio.create_subprocess_exec(...)`
   with a literal argv (inline, or a local list) that names an in-repo app starts that app's entries: a `spawn`
   crossing from the spawning function to them.
     uvicorn mod:app            -> the entries defined in the app's module (its lifespan)
     taskiq worker mod:broker   -> every queue consumer          celery -A mod worker -> every queue consumer
     taskiq scheduler mod:x     -> every scheduled task          celery -A mod beat   -> every scheduled task
     python -m pkg              -> pkg's `__main__` entry
   The app module is looked up as the spawned process would find it from the spawning file: its directory, then each
   parent, then as an absolute import from that file (the repo root, then the package roots). */
import { dirname } from 'node:path';
import { addEdge } from '../lang/python.mjs';

const SUBPROCESS = /^(Popen|run|call|check_call|check_output)$/;
// `subprocess.run(…)`, `asyncio.create_subprocess_exec(…)`, or the bare name imported from either module
const isSpawn = c => c.attr ? (c.obj === 'subprocess' && SUBPROCESS.test(c.attr)) || (c.obj === 'asyncio' && c.attr === 'create_subprocess_exec')
  : (c.imports.get(c.expr)?.from === 'subprocess' && SUBPROCESS.test(c.expr)) || (c.imports.get(c.expr)?.from === 'asyncio' && c.expr === 'create_subprocess_exec');

function argvOf(py, c) {
  const items = /create_subprocess_exec$/.test(c.expr) ? c.args.filter(a => a.type !== 'keyword_argument')
    : c.args[0]?.items ?? (c.args[0]?.type === 'identifier' ? py.fnLists.get(c.from)?.[c.args[0].text] : null);
  return items ? items.map(a => (a.type === 'string' ? a.s : null)) : null;
}

export function linkSpawns(py, R, entries) {
  const spawns = [];
  const appModule = spec => spec && spec.includes(':') ? spec.split(':')[0] : spec;
  const near = (c, name) => { const dirs = dirname(c.file) === '.' ? [] : dirname(c.file).split('/');
    return [...dirs.map((_, i) => [...dirs.slice(0, dirs.length - i), name].join('.')), R.findModule(name, c.module)].filter(Boolean); };
  for (const c of py.rawCalls) {
    if (!isSpawn(c)) continue;
    const argv = argvOf(py, c);
    if (!argv) continue;
    const at = w => argv.indexOf(w);
    let targets = [], what = null;
    if (at('uvicorn') !== -1) { const spec = appModule(argv[at('uvicorn') + 1]); what = `uvicorn ${argv[at('uvicorn') + 1]}`;
      const mod = spec && near(c, spec).find(m => py.modules.has(m));
      targets = mod ? entries.filter(e => e.file && py.modules.get(mod).file === e.file) : []; }
    else if (at('taskiq') !== -1 && argv[at('taskiq') + 1] === 'worker') { what = `taskiq worker ${argv[at('taskiq') + 2]}`; targets = entries.filter(e => e.kind === 'queue-consumer'); }
    else if (at('taskiq') !== -1 && argv[at('taskiq') + 1] === 'scheduler') { what = `taskiq scheduler ${argv[at('taskiq') + 2]}`; targets = entries.filter(e => e.kind === 'scheduled'); }
    else if (at('celery') !== -1) { const beat = argv.includes('beat'); what = `celery ${beat ? 'beat' : 'worker'}`; targets = entries.filter(e => e.kind === (beat ? 'scheduled' : 'queue-consumer')); }
    else if (at('-m') !== -1 && argv[at('-m') + 1]) { what = `python -m ${argv[at('-m') + 1]}`;
      const mod = near(c, argv[at('-m') + 1]).find(m => py.modules.has(`${m}.__main__`) || py.modules.has(m));
      targets = mod ? entries.filter(e => e.kind === 'main' && (e.id === `${mod}.__main__:<main>` || e.id === `${mod}:<main>`)) : []; }
    if (!what) continue;
    spawns.push({ from: c.from, file: c.file, line: c.line, argv: what, targets: targets.map(e => e.id) });
    for (const e of targets) addEdge(py, c.from, e.id, 'spawn', c.line, { rule: 'process-spawn', evidence: `${c.file}:${c.line} spawns ${what}` });
  }
  return spawns;
}
