import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ping } from '../src/net.mjs';

// the sandbox denies every connect, localhost included: this test fails and is listed as denied
test('ping reaches the cache', async () => {
  assert.ok(await ping('127.0.0.1', 6379));
});
