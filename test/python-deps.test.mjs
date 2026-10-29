// pyproject.toml and Pipfile are read with a TOML parser, so string content (an extras `]`, a `#`) never ends an array
// or starts a comment, and every declared name is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaredDependencies } from '../skills/explainer-video-from-codebase/tools/lang/python-deps.mjs';
import { parseToml } from '../skills/explainer-video-from-codebase/tools/lib/toml.mjs';

const declared = (rel, text) => [...declaredDependencies([{ rel, text }])].sort();
const plain = v => JSON.parse(JSON.stringify(v));

test('an extras specifier ahead of other entries does not end a multi-line dependencies array', () => {
  assert.deepEqual(declared('pyproject.toml', '[project]\nname = "x"\ndependencies = [\n "uvicorn[standard]>=0.2",\n "httpx>=0.27",\n "stripe",\n]\n'),
    ['httpx', 'stripe', 'uvicorn']);
  assert.deepEqual(declared('pyproject.toml', '[project]\ndependencies = ["fastapi[all]", "celery[redis]>=5"]\n'), ['celery', 'fastapi']);
});

test('comments, literal and multi-line strings, and optional-dependencies groups', () => {
  const text = `[project]
name = "x"
description = """a [bracketed]
description"""
dependencies = [  # runtime ] here is a comment
  'httpx[http2]>=0.27', # trailing
  "Stripe",
]

[project.optional-dependencies]
dev = ["pytest", "ruff"]
"web-extra" = ["uvicorn[standard]"]

[tool.ruff]
select = ["E"]
`;
  assert.deepEqual(declared('pyproject.toml', text), ['httpx', 'pytest', 'ruff', 'stripe', 'uvicorn']);
});

test('Poetry tables, including groups and inline tables', () => {
  const text = `[tool.poetry.dependencies]
python = "^3.11"
requests = { version = "^2", extras = ["socks"] }

[tool.poetry.group.dev.dependencies]
pytest = "*"

[tool.poetry.dev-dependencies]
black = "*"
`;
  assert.deepEqual(declared('pyproject.toml', text), ['black', 'pytest', 'requests']);
});

test('Pipfile packages and dev-packages', () => {
  assert.deepEqual(declared('Pipfile', '[[source]]\nurl = "https://pypi.org/simple"\n\n[packages]\nflask = "*"\n"Flask-Login" = { version = "*" }\n\n[dev-packages]\npytest = "*"\n'),
    ['flask', 'flask_login', 'pytest']);
});

test('a malformed TOML document declares nothing and does not throw', () => {
  assert.deepEqual(declared('pyproject.toml', '[project]\ndependencies = [\n "httpx",\n'), []);
});

test('the TOML reader: dotted keys, arrays of tables, escapes, and errors', () => {
  assert.deepEqual(plain(parseToml('a.b = 1\n[[t]]\nx = "\\u00e9\\t"\n[[t]]\nx = \'raw\\n\'\n[s."q.k"]\nv = [1, [2], {k = true}]\n')),
    { a: { b: '1' }, t: [{ x: 'é\t' }, { x: 'raw\\n' }], s: { 'q.k': { v: ['1', ['2'], { k: 'true' }] } } });
  assert.throws(() => parseToml('a = 1\na = 2\n'), /duplicate key/);
  assert.throws(() => parseToml('a = "x\n"\n'), /newline/);
});

test('keys named after Object.prototype members are ordinary data and pollute nothing', () => {
  const doc = parseToml('[__proto__]\npolluted = "yes"\n[x]\n__proto__.shell = "/bin/sh"\n[tool.x]\nconstructor = 1\n[tool.x.toString]\nv = 2\n[[hasOwnProperty]]\nn = 3\n');
  assert.equal(({}).polluted, undefined);
  assert.equal(({}).shell, undefined);
  assert.deepEqual(Object.keys(doc), ['__proto__', 'x', 'tool', 'hasOwnProperty']);
  assert.equal(doc['__proto__'].polluted, 'yes');
  assert.equal(doc.x['__proto__'].shell, '/bin/sh');
  assert.equal(doc.tool.x.constructor, '1');
  assert.equal(doc.tool.x.toString.v, '2');
  assert.equal(doc.hasOwnProperty[0].n, '3');
  assert.deepEqual(declared('pyproject.toml', '[__proto__]\npolluted = "yes"\n[project]\ndependencies = ["httpx"]\n[tool.x]\nconstructor = 1\n'), ['httpx']);
  assert.equal(({}).polluted, undefined);
});
