/* trace.mjs's JavaScript / TypeScript runners (design §3.14, §3.17): which test commands are recognised, which test
   files each one runs, and the command line that runs one file under V8 precise coverage with a machine-readable
   report. Only the repo's own installed runner is ever run (its node_modules/.bin); nothing is installed.
   - `node --test [--test-* flags] [paths]`: the TAP reporter on stdout;
   - `npx jest [args]`, `jest [args]`, `node_modules/.bin/jest [args]`: --json --outputFile, --runInBand, no watchman;
   - `npx vitest [run] [args]`, `vitest …`: --reporter=json --outputFile, run mode, the threads pool (a forked worker is
     killed before it can write its coverage; worker threads write theirs). */
import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';

const NODE_FLAG = /^--(test-name-pattern|test-skip-pattern|test-timeout|test-concurrency)=.+$|^--test-only$|^--experimental-(strip|transform)-types$|^--experimental-test-module-mocks$|^--no-experimental-strip-types$/;
// flags the trace sets itself, or that would never end or report elsewhere
const OWN_FLAGS = /^--(watch|watchAll|ui|coverage|shard|outputFile|json|reporter|pool|threads|runInBand|watchman|ci|browser|api|inspect)(\b|=|$)/;

/* -> { runner, args } or null. `words` is the command split like a shell would */
export function recogniseJs(words) {
  const head = basename(words[0]);
  if (/^node(\d+)?$/.test(head) && words[1] === '--test') {
    const args = words.slice(2);
    return args.every(a => !a.startsWith('-') || NODE_FLAG.test(a)) ? { runner: 'node-test', args } : null;
  }
  let tool = null, args = [];
  if (head === 'npx' && /^(jest|vitest)$/.test(words[1] || '')) { tool = words[1]; args = words.slice(2); }
  else if (/^(jest|vitest)$/.test(head) && (!words[0].includes('/') || /(^|\/)node_modules\/\.bin\/(jest|vitest)$/.test(words[0]))) { tool = head; args = words.slice(1); }
  if (!tool) return null;
  if (tool === 'vitest') { if (/^(watch|dev|bench|init|list|serve)$/.test(args[0] || '')) return null; if (args[0] === 'run') args = args.slice(1); }
  if (args.some(a => OWN_FLAGS.test(a))) return null;
  return { runner: tool, args };
}

// each runner's own default test-file pattern, applied to the code map's test files
const PATTERNS = {
  'node-test': f => /\.test\.[cm]?[jt]s$|[-_.]test\.[cm]?[jt]s$|(^|\/)test-[^/]*\.[cm]?[jt]s$|(^|\/)test\.[cm]?[jt]s$|(^|\/)test\/.*\.[cm]?[jt]s$/.test(f),
  jest: f => /(^|\/)__tests__\/.*\.[jt]sx?$|\.(test|spec)\.[jt]sx?$/.test(f),
  vitest: f => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f),
};
export function jsTestFiles(m, runner, args) {
  const paths = args.filter(a => !a.startsWith('-')).map(a => a.replace(/^\.\//, '').replace(/\/$/, ''));
  const files = [...new Set((m.tests || []).filter(t => /\.[cm]?[jt]sx?$/.test(t.file)).map(t => t.file))].sort();
  return files.filter(f => PATTERNS[runner](f) && (!paths.length || paths.some(p => f === p || f.startsWith(p + '/'))));
}
export const passThrough = args => args.filter(a => a.startsWith('-'));

// the runner's entry in the repo's node_modules: a node script (run with node) or a shell shim (run as is)
export function runnerBin(root, runner) {
  const bin = join(root, 'node_modules', '.bin', runner);
  if (!existsSync(bin)) return null;
  const real = realpathSync(bin);
  const head = readFileSync(real, 'utf8').slice(0, 200);
  return { rel: `node_modules/.bin/${runner}`, node: /\.[cm]?js$/.test(real) || /^#!.*\bnode\b/.test(head) };
}

// node_modules dirs under the repo (not inside another one), to link into the copy and expose read-only
export function nodeModulesDirs(root, max = 4) {
  const out = [];
  (function walk(rel, depth) {
    let names; try { names = readdirSync(join(root, rel)); } catch { return; }
    for (const name of names) {
      if (name === '.git') continue;
      const r = rel ? `${rel}/${name}` : name;
      let st; try { st = lstatSync(join(root, r)); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (name === 'node_modules') out.push(r);
      else if (depth < max && !name.startsWith('.')) walk(r, depth + 1);
    }
  })('', 0);
  return out.sort();
}

// one file's command line, and where its report lands (null: stdout)
export function fileArgv({ runner, node, bin, flags, file, report }) {
  const tool = bin ? (bin.node ? [node, bin.rel] : [bin.rel]) : null;
  if (runner === 'node-test') return [node, ...flags, '--test', '--test-reporter=tap', file];
  if (runner === 'jest') return [...tool, ...flags, '--ci', '--watchman=false', '--runInBand', '--json', `--outputFile=${report}`, '--runTestsByPath', file];
  return [...tool, 'run', ...flags, '--reporter=json', `--outputFile=${report}`, '--pool=threads', file];
}
