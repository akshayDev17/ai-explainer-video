/* Every file lands in exactly one group: prod, test, eval or dev. Ordered rules, first match
   wins; a user override (`--group 'glob=group'`) always wins over them. Path rules decide;
   content signals only reclassify a file that fell through to prod (design rev3 §3.15). */

export const GROUPS = ['prod', 'test', 'eval', 'dev'];

export const PATH_RULES = [
  { group: 'test', rule: 'test: a tests/, test/ or __tests__/ dir; test_*.py, *_test.py, conftest.py; *.test|spec.[cm][jt]s(x), setupTests / jest.setup / vitest.setup; *_test.go',
    re: /(^|\/)(tests?|__tests__)\/|(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(setupTests|setup-tests|jest\.setup|vitest\.setup|test-setup)\.[cm]?[jt]sx?$|_test\.go$/ },
  { group: 'dev', rule: 'dev (file name): debug_*.py, diagnose_*.py, *migration_controller*.py, dev.py; debug*.[jt]s, *.dev.[jt]s, build and test tool configs (jest/vitest/vite/webpack/… .config.[jt]s)',
    re: /(^|\/)(debug|diagnose)_[^/]*\.py$|(^|\/)[^/]*migration_controller[^/]*\.py$|(^|\/)dev\.py$|(^|\/)debug[^/]*\.[cm]?[jt]sx?$|\.dev\.[cm]?[jt]sx?$|(^|\/)(jest|vitest|vite|webpack|rollup|babel|eslint|prettier|tailwind|postcss|playwright|cypress)\.config\.[cm]?[jt]s$/ },
  { group: 'eval', rule: 'eval: an evals/, eval/, *_evals/, evals_*/, evaluation(s)/, benchmark(s)/ or bench/ dir',
    re: /(^|\/)(evals?|[\w-]+_evals?|evals?_[\w-]+|evaluations?|benchmarks?|bench)\// },
  { group: 'dev', rule: 'dev (dir): migrations/, alembic/, dev_setup/, dev/, scripts/, verification/, debug/',
    re: /(^|\/)(migrations|alembic|dev_setup|dev|scripts|verification|debug)\// },
];
export const DEFAULT_RULE = 'prod: everything else';

const TEST_IMPORT = /^\s*(import|from)\s+(pytest|unittest)\b/m;
const TEST_DEF = /^\s*(async\s+)?def\s+test_\w*\s*\(|^\s*class\s+Test\w*\s*[(:]/m;
const EVAL_IMPORT = /^\s*(import|from)\s+(ragas|deepeval|promptfoo|lm_eval|inspect_ai|mteb|beir|trulens\w*)\b|^\s*from\s+langsmith(\.\w+)*\s+import\s+[^\n]*\bevaluate\b/m;
const TRAINING = /\bTrainer\(|\.backward\(\)|^\s*(import|from)\s+accelerate\b/m;
const JS_TEST_IMPORT = /\bfrom\s+["'](vitest|@jest\/globals|node:test|mocha)["']|\brequire\(\s*["'](node:test|mocha|@jest\/globals)["']\s*\)/;
const JS_TEST_DEF = /^\s*(describe|it|test)(\.\w+)*\s*\(/m;
const JS_EVAL_IMPORT = /\bfrom\s+["'](promptfoo|evalite|autoevals|braintrust|langsmith\/evaluation)["']|\brequire\(\s*["'](promptfoo|autoevals|braintrust)["']\s*\)/;

export function contentRule(text, lang = 'python') {
  if (lang !== 'python') {
    if (JS_TEST_IMPORT.test(text) && JS_TEST_DEF.test(text)) return { group: 'test', rule: 'content: imports vitest/jest/node:test/mocha and defines tests' };
    if (JS_EVAL_IMPORT.test(text)) return { group: 'eval', rule: 'content: imports an eval framework' };
    return null;
  }
  if (TEST_IMPORT.test(text) && TEST_DEF.test(text)) return { group: 'test', rule: 'content: imports pytest/unittest and defines tests' };
  if (EVAL_IMPORT.test(text)) return { group: 'eval', rule: 'content: imports an eval framework' };
  if (TRAINING.test(text)) return { group: 'eval', rule: 'content: training-loop markers' };
  return null;
}

// `**` crosses directories, `*` and `?` do not; a pattern with no slash matches anywhere
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp((glob.includes('/') ? '^' : '(^|/)') + re + '$');
}

export function parseOverrides(specs) {
  return specs.map(spec => {
    const i = spec.lastIndexOf('=');
    const glob = spec.slice(0, i), group = spec.slice(i + 1);
    if (i < 1 || !GROUPS.includes(group)) throw new Error(`--group '${spec}': expected 'glob=${GROUPS.join('|')}'`);
    return { glob, group, re: globToRegExp(glob) };
  });
}

export function classifyFile(rel, overrides, readText, lang = 'python') {
  const o = overrides.find(x => x.re.test(rel));
  if (o) return { group: o.group, rule: `override: ${o.glob}=${o.group}` };
  const r = PATH_RULES.find(x => x.re.test(rel));
  if (r) return { group: r.group, rule: r.rule };
  const c = readText && contentRule(readText(), lang);
  return c || { group: 'prod', rule: DEFAULT_RULE };
}
