import './setup-empty.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { envDatabaseConfig } from '../DB.js';
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

test('U-f: env fallback builds a SQLite connection for DB_CLIENT=sqlite3 / better-sqlite3', () => {
  const saved = { DB_CLIENT: process.env.DB_CLIENT, DB_NAME: process.env.DB_NAME };
  try {
    for (const client of ['sqlite3', 'better-sqlite3']) {
      process.env.DB_CLIENT = client;
      delete process.env.DB_NAME;
      assert.deepEqual(envDatabaseConfig(), { client, connection: { filename: ':memory:' }, useNullAsDefault: true });
      process.env.DB_NAME = '/tmp/app.sqlite';
      assert.deepEqual(envDatabaseConfig().connection, { filename: '/tmp/app.sqlite' });
    }
    process.env.DB_CLIENT = 'pg';
    process.env.DB_NAME = 'app';
    assert.equal(envDatabaseConfig().connection.database, 'app');
    assert.equal('filename' in envDatabaseConfig().connection, false);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('U-f: an app without config/database.js runs queries on SQLite from env', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'averoa-sqlite-'));
  try {
    const code = `
      const { DB } = await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)});
      await DB.schema.createTable('t', (t) => { t.increments('id'); t.string('v'); });
      await DB('t').insert({ v: 'x' });
      console.log(JSON.stringify(await DB('t').select('v')));
      await DB.destroy();
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      env: {
        ...process.env,
        AVEROA_ROOT: path.join(here, 'fixtures', 'empty-app'),
        LOG_LEVEL: 'error',
        DB_CLIENT: 'better-sqlite3',
        DB_NAME: path.join(dir, 'app.sqlite'),
      },
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '[{"v":"x"}]');
    assert.ok(fs.existsSync(path.join(dir, 'app.sqlite')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('2.0.2: a relative SQLite DB_NAME resolves against the app root, not the cwd', async () => {
  const { sqliteFilename } = await import('../DB.js');
  const { appPath } = await import('../paths.js');
  assert.equal(sqliteFilename(undefined), ':memory:');
  assert.equal(sqliteFilename(':memory:'), ':memory:');
  assert.equal(sqliteFilename('/abs/db.sqlite'), '/abs/db.sqlite');
  assert.equal(sqliteFilename('file:db.sqlite?mode=ro'), 'file:db.sqlite?mode=ro');
  assert.equal(sqliteFilename('database/dev.sqlite'), appPath('database/dev.sqlite'));
});
