import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const main = path.join(here, 'fixtures', 'cycle-main.mjs');

function runApp(app, env = {}) {
  const r = spawnSync(process.execPath, [main], {
    env: {
      ...process.env, AVEROA_ROOT: path.join(here, 'fixtures', app), LOG_LEVEL: 'error', ...env,
    },
    encoding: 'utf8',
    timeout: 20000,
  });
  const line = r.stdout.trim().split('\n').at(-1);
  return { ...r, json: line ? JSON.parse(line) : null };
}

test('U5: config/*.js importing the root package does not deadlock (no exit 13)', () => {
  const r = runApp('cycle-app');
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
  assert.deepEqual(r.json, {
    ok: true, x: 1, isFn: true, baseURL: 'https://cycle.example.test', header: 'yes',
  });
  assert.match(r.stderr, /import helpers from '@averoa\/utilities\/paths'/);
});

test('U5: an indirect import cycle falls back to lazy init after a bounded wait', () => {
  const r = runApp('cycle-indirect-app', { AVEROA_CONFIG_WAIT_MS: '200' });
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.x, 1);
  assert.match(r.stderr, /did not load within 200ms/);
});

test('U5: a normal config is loaded before the import resolves (DB usable synchronously)', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { DB, isDBReady } = await import(${JSON.stringify(path.join(here, '..', 'index.js'))});
    console.log(JSON.stringify({ ready: isDBReady(), sql: DB('users').where('id', 1).toString() }));
    await DB.destroy();
  `], {
    env: { ...process.env, AVEROA_ROOT: path.join(here, 'fixtures', 'app'), LOG_LEVEL: 'error' },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(out.ready, true);
  assert.match(out.sql, /select \* from `users` where `id` = 1/);
  assert.equal(r.stderr.includes('[averoa]'), false, r.stderr);
});
