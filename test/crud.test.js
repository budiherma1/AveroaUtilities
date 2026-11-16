import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  DB, Users, resetDb, fakeReq,
} from './helpers.js';
import { Crud } from '../index.js';
import { UploadProvider } from './fixtures/app/app/Providers/index.js';

beforeEach(async () => {
  await resetDb();
  await DB('users').insert([
    { name: 'alice', email: 'alice@x.io', password: 'p1', created_by: 7 },
    { name: 'bob', email: 'bob@x.io', password: 'p2', deleted_at: new Date() },
  ]);
});

test('create strips mass-assigned keys from a raw body', async () => {
  const req = fakeReq({
    body: {
      id: 500, name: 'eve', email: 'eve@x.io', password: 'pw', deleted_at: '2020-01-01', created_by: 1, isAdmin: 1,
    },
    user: { id: 3 },
  });
  const r = await Crud.create('Users', req);
  assert.equal(r.status, true, r.message);
  const row = await DB('users').where('email', 'eve@x.io').first();
  assert.notEqual(row.id, 500);
  assert.equal(row.password, null); // hidden columns are not writable from a raw body
  assert.equal(row.deleted_at, null);
  assert.equal(row.created_by, 3);
  assert.equal(row.updated_by, 3);
  assert.equal('password' in JSON.parse(JSON.stringify(r.data)), false);
});

test('create trusts req.dataReq (set by crud middleware / app code)', async () => {
  const req = fakeReq({ dataReq: { name: 'x', email: 'x@x.io', password: 'hashed' } });
  const r = await Crud.create('Users', req, { insert: { name: 'forced' } });
  assert.equal(r.status, true, r.message);
  const row = await DB('users').where('email', 'x@x.io').first();
  assert.equal(row.password, 'hashed');
  assert.equal(row.name, 'forced');
});

test('create with uploads uses the app UploadProvider', async () => {
  const req = fakeReq({
    dataReq: { name: 'u', email: 'u@x.io' },
    dataFiles: { avatar: { originalname: 'a.png' } },
    routeData: 'users',
  });
  class WithAvatar extends Users {}
  await DB.schema.alterTable('users', (t) => t.string('avatar'));
  const r = await Crud.create(WithAvatar, req);
  assert.equal(r.status, true, r.message);
  assert.equal(UploadProvider.calls.at(-1).route, 'users');
  assert.equal((await DB('users').where('email', 'u@x.io').first()).avatar, 'users/a.png');
});

test('update keeps created_by and sets updated_by', async () => {
  const req = fakeReq({ params: { id: '1' }, body: { name: 'alice2', created_by: 99 }, user: { id: 5 } });
  const r = await Crud.update('Users', req);
  assert.deepEqual(r, { status: true });
  const row = await DB('users').where('id', 1).first();
  assert.equal(row.name, 'alice2');
  assert.equal(row.created_by, 7);
  assert.equal(row.updated_by, 5);

  const viaDataReq = fakeReq({ params: { id: '1' }, dataReq: { created_by: 1, name: 'z' } });
  await Crud.update('Users', viaDataReq);
  assert.equal((await DB('users').where('id', 1).first()).created_by, 7);
});

test('update/delete do not touch soft-deleted rows', async () => {
  assert.deepEqual(await Crud.update('Users', fakeReq({ params: { id: '2' }, body: { name: 'x' } })), { status: false });
  assert.deepEqual(await Crud.delete('Users', fakeReq({ params: { id: '2' } })), { status: false });
});

test('delete stores the real (24h) time for afternoon deletes and sets deleted_by', async () => {
  const afternoon = new Date(2024, 0, 15, 15, 30, 0); // 15:30 local
  mock.timers.enable({ apis: ['Date'], now: afternoon });
  try {
    const r = await Crud.delete('Users', fakeReq({ params: { id: '1' }, user: { id: 4 } }));
    assert.deepEqual(r, { status: true });
  } finally {
    mock.timers.reset();
  }
  const row = await DB('users').where('id', 1).first();
  const stored = new Date(typeof row.deleted_at === 'number' ? row.deleted_at : row.deleted_at);
  assert.equal(stored.getHours(), 15);
  assert.equal(stored.getTime(), afternoon.getTime());
  assert.equal(row.deleted_by, 4);
  assert.equal((await Crud.findOne('Users', fakeReq({ params: { id: '1' } }))).data, null);
});

test('delete is a hard delete for timestamp:false models', async () => {
  await DB('tags').insert({ label: 't' });
  assert.deepEqual(await Crud.delete('Tags', fakeReq({ params: { id: '1' } })), { status: true });
  assert.equal((await DB('tags').count({ c: '*' }))[0].c, 0);
});

test('findOne respects soft delete, hidden, $select and $relations rules', async () => {
  await DB('posts').insert({ user_id: 1, title: 'hello' });
  const one = await Crud.findOne('Users', fakeReq({ params: { id: '1' }, query: { $relations: 'posts' } }));
  assert.equal(one.status, true, one.message);
  const json = JSON.parse(JSON.stringify(one.data));
  assert.equal('password' in json, false);
  assert.deepEqual(json.posts.map((p) => p.title), ['hello']);

  assert.equal((await Crud.findOne('Users', fakeReq({ params: { id: '2' } }))).data, null);
  assert.equal((await Crud.findOne('Users', fakeReq({ params: { id: '1' }, query: { $select: 'password' } }))).status, false);
  assert.equal((await Crud.findOne('Users', fakeReq({ params: { id: '1' }, query: { $relations: 'secrets' } }))).status, false);
  const sel = await Crud.findOne('Users', fakeReq({ params: { id: '1' }, query: { $select: 'id,name' } }));
  assert.deepEqual(JSON.parse(JSON.stringify(sel.data)), { id: 1, name: 'alice' });
});

test('findAll (plain and datatable) without mutating req.query', async () => {
  const plain = await Crud.findAll('Users', fakeReq({ query: { 'name:eq': 'alice' } }));
  assert.equal(plain.status, true);
  assert.equal(plain.data.length, 1);

  const dt = await Crud.findAll('Users', fakeReq({ query: { $datatable: '1', $draw: '3', _: '123' } }));
  assert.deepEqual(Object.keys(dt), ['draw', 'recordsTotal', 'recordsFiltered', 'data']);
  assert.equal(dt.draw, '3');
  assert.equal(dt.recordsTotal, 1);
});

test('unknown model name gives an error result', async () => {
  const r = await Crud.create('Nope', fakeReq({ body: {} }));
  assert.equal(r.status, false);
  assert.match(r.message, /Model Nope not found/);
});

test('U3: database errors are not leaked to the client (generic message, logged)', async () => {
  const r = await Crud.create('Users', fakeReq({ body: { name: 'x', email: 'e@x.io' } }), {
    insert: { password: 'S3cretHash', nonexistent: 1 },
  });
  assert.deepEqual(r, { status: false, message: 'Database error' });

  const u = await Crud.update('Users', fakeReq({ params: { id: '1' }, dataReq: { nope: 'S3cretHash' } }));
  assert.deepEqual(u, { status: false, message: 'Database error' });

  // filter errors keep their message
  const f = await Crud.findOne('Users', fakeReq({ params: { id: '1' }, query: { $select: 'password' } }));
  assert.match(f.message, /password is not selectable/);
});

test('U9: findAll ignores `_` and other non-filter keys (with or without $datatable)', async () => {
  const plain = await Crud.findAll('Users', fakeReq({ query: { _: '123', utm_source: 'x', draw: '1' } }));
  assert.equal(plain.status, true, plain.message);
  assert.equal(plain.data.length, 1);

  const dt = await Crud.findAll('Users', fakeReq({ query: { $datatable: '1', $draw: '4', columns: [{ data: 'name' }], _: '9' } }));
  assert.equal(dt.draw, '4');
  assert.equal(dt.recordsTotal, 1);
});

test('U12: findAll passes option (maxLimit / limit) through Model.filterSearch', async () => {
  await DB('users').insert([{ name: 'c', email: 'c@x.io' }, { name: 'd', email: 'd@x.io' }]);
  const capped = await Crud.findAll('Users', fakeReq({ query: { limit: '50' } }), { maxLimit: 2 });
  assert.equal(capped.status, true, capped.message);
  assert.equal(capped.data.length, 2);
  assert.equal(capped.metadata.item_total, 3);
  assert.equal(capped.metadata.page_total, 2);

  const defaultLimit = await Crud.findAll('Users', fakeReq({ query: {} }), { limit: 1 });
  assert.equal(defaultLimit.data.length, 1);

  // a model overriding filterSearch still receives the option
  let received;
  class Custom extends Users {
    static filterSearch(req, config) { received = config; return super.filterSearch(req, config); }
  }
  await Crud.findAll(Custom, fakeReq({ query: {} }), { maxLimit: 5 });
  assert.deepEqual(received, { maxLimit: 5 });
});

test('U18: Crud raw body writes a hidden column only when flagged writable', async () => {
  class WritablePw extends Users {
    static column = { ...Users.column, password: { flag: { required: false, writable: true } } };
  }
  const r = await Crud.create(WritablePw, fakeReq({ body: { name: 'w', email: 'w@x.io', password: 'pw' } }));
  assert.equal(r.status, true, r.message);
  assert.equal((await DB('users').where('email', 'w@x.io').first()).password, 'pw');

  await Crud.create('Users', fakeReq({ body: { name: 'n', email: 'n@x.io', password: 'pw' } }));
  assert.equal((await DB('users').where('email', 'n@x.io').first()).password, null);
});
