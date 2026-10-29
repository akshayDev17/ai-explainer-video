// Config facts come only from git-tracked files and honour --exclude; a value is kept only for a key a dispatch guard
// reads, and a secret-looking key or credential-shaped value is shown only as set, in codemap.json and codemap.md.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { FIXTURES, mine, gitRepo, git, cleanup, scratch } from './helpers.mjs';

const repo = gitRepo(join(FIXTURES, 'config'));
after(() => cleanup(dirname(repo)));
mkdirSync(join(repo, 'deploy'));
writeFileSync(join(repo, 'deploy', 'prod.env'),
  'API_TOKEN=tok-not-a-real-one\nDATABASE_URL=postgres://app:hunter2@db:5432/app\nOPENAI_API_KEY=sk-test-000000000000000000\nWORKERS=4\n');
git(repo, 'add', '-A');
writeFileSync(join(repo, '.env'), 'BACKEND_MODE=local-only\nOPENAI_API_KEY=sk-real-secret\n');   // untracked, as a real .env is
const r = mine(repo);
const m = r.codemap;
const kv = (file, key) => m.config.kv.find(x => x.file === file && x.key === key);
const site = fn => m.config.sites.find(s => s.factory === fn);

test('mining the config fixture succeeds', () => assert.equal(r.status, 0, r.stderr));

test('a tracked .env.example is read and the value of a key a guard reads appears', () => {
  assert.equal(kv('.env.example', 'BACKEND_MODE').value, 'remote');
  assert.equal(site('svc.factories:create_backend').decidedByProfile['.env.example'], 'svc.factories:RemoteBackend');
  assert.match(r.md, /reads settings\.backend_mode \(env BACKEND_MODE, default local\) set in: \.env\.example:1=remote/);
});

test('an untracked .env is never read', () => {
  assert.deepEqual(m.config.files.map(f => f.path).sort(), ['.env.example', 'deploy/prod.env']);
  assert.equal(m.config.untracked, 1);
  assert.equal(m.config.profiles.some(p => p.name === '.env'), false);
});

test('a key no guard reads is recorded with its file but no value', () => {
  assert.deepEqual(kv('.env.example', 'LOG_LEVEL'), { key: 'LOG_LEVEL', line: 2, file: '.env.example', group: 'prod' });
  assert.equal('value' in kv('deploy/prod.env', 'WORKERS'), false);
  assert.equal('value' in kv('deploy/prod.env', 'OPENAI_API_KEY'), false);
});

test('a secret key and a credential-shaped value read by a guard are shown only as set, and still decide dispatch', () => {
  assert.equal(kv('deploy/prod.env', 'API_TOKEN').value, 'set (redacted)');
  assert.equal(kv('deploy/prod.env', 'DATABASE_URL').value, 'set (redacted)');
  assert.equal(site('svc.factories:create_client').decidedByProfile['deploy/prod.env'], 'svc.factories:SignedClient');
  assert.equal(site('svc.factories:create_store').decidedByProfile['deploy/prod.env'], 'svc.factories:PostgresStore');
  assert.match(r.md, /deploy\/prod\.env:1=set \(redacted\)/);
  for (const secret of ['tok-not-a-real-one', 'hunter2', 'sk-test-', 'sk-real-secret', 'local-only']) {
    assert.equal(JSON.stringify(m).includes(secret), false, `codemap.json leaks ${secret}`);
    assert.equal(r.md.includes(secret), false, `codemap.md leaks ${secret}`);
  }
});

test('--exclude keeps an excluded path\'s config out of the code map', () => {
  const x = mine(repo, '--exclude', 'deploy');
  assert.equal(x.status, 0, x.stderr);
  assert.deepEqual(x.codemap.config.files.map(f => f.path), ['.env.example']);
  assert.equal(x.codemap.config.kv.some(k => k.file.startsWith('deploy/')), false);
});

test('a directory outside a git work tree has no config read, and the code map and stdout say why', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'svc'));
  writeFileSync(join(dir, 'svc', 'app.py'), 'def run():\n    return 1\n');
  writeFileSync(join(dir, '.env'), 'OPENAI_API_KEY=sk-real-secret\n');
  const x = mine(dir);
  cleanup(dir);
  assert.equal(x.status, 0, x.stderr);
  assert.deepEqual([x.codemap.config.files, x.codemap.config.kv, x.codemap.config.notGitWorkTree], [[], [], [dir]]);
  assert.match(x.stdout, /config not read from .*: not a git work tree, so no config file can be proven tracked/);
  assert.match(x.md, /\*\*Config not read from `[^`]+`: not a git work tree, so no config file can be proven tracked\.\*\*/);
});
