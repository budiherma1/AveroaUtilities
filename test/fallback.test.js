import './setup-empty.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import * as utilities from '../index.js';
import * as paths from '@averoa/utilities/paths';

after(() => utilities.DB.destroy());

test('index exports the v2 API', () => {
  for (const name of ['Log', 'DB', 'Mail', 'Queue', 'Fetch', 'Validator', 'FilterSearch', 'Model', 'Crud', 'View',
    'MailWorker', 'startMailWorker', 'closeQueue', 'appRoot', 'appPath', 'appHas', 'importApp', 'importAppDefault']) {
    assert.ok(utilities[name], `missing export ${name}`);
  }
  assert.equal(utilities.MailWorker, utilities.startMailWorker);
  assert.equal(paths.appRoot, utilities.appRoot);
});

test('missing config files fall back to env defaults instead of crashing', async () => {
  assert.equal(utilities.appRoot(), process.env.AVEROA_ROOT);
  assert.equal(utilities.Fetch.defaults.baseURL, 'https://api.example.test');
  assert.equal(typeof utilities.DB, 'function');
  assert.equal(typeof utilities.DB('users').where('id', 1).toString(), 'string');
});

test('Log writes into <app>/storages/logs (created when missing)', () => {
  assert.ok(fs.existsSync(path.join(process.env.AVEROA_ROOT, 'storages', 'logs')));
  assert.equal(utilities.Log.level, 'error');
});

test('AuthSandbox is a per-request factory', async () => {
  const { default: Auth } = await import('../AuthSandbox.js');
  const a = Auth({ user: { id: 1 }, isAuthenticated: () => true });
  const b = Auth({ user: { id: 2 }, isAuthenticated: () => false });
  assert.deepEqual([a.user().id, a.check(), b.user().id, b.check()], [1, true, 2, false]);
});
