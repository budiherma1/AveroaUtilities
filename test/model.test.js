import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import knex from 'knex';
import {
  DB, Users, Tags, resetDb, fakeReq, fakeRes,
} from './helpers.js';

beforeEach(resetDb);

test('Model.js has no top-level faker / app config import', () => {
  const src = fs.readFileSync(new URL('../Model.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^import .*@faker-js\/faker/m);
  assert.doesNotMatch(src, /\.\.\/\.\.\/\.\.\//);
  for (const file of fs.readdirSync(new URL('..', import.meta.url)).filter((f) => f.endsWith('.js'))) {
    const code = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /from ['"](\.\/)?\.\.\/\.\.\/\.\.\//, `${file} imports app code by relative path`);
  }
});

test('hidden columns are stripped from toJSON', async () => {
  await DB('users').insert({ name: 'a', email: 'a@x.io', password: 'secret' });
  const user = await Users.query().findById(1);
  assert.equal(user.password, 'secret'); // still readable in code
  assert.equal(JSON.stringify(user).includes('secret'), false);
  assert.equal('password' in user.toJSON(), false);
});

test('migrationUp: ON UPDATE CURRENT_TIMESTAMP only on mysql', () => {
  const sql = (client) => Users.migrationUp(knex({ client })).toSQL().map((s) => s.sql).join('\n');
  assert.match(sql('mysql2'), /ON UPDATE CURRENT_TIMESTAMP/);
  assert.doesNotMatch(sql('pg'), /ON UPDATE/);
  assert.doesNotMatch(sql('better-sqlite3'), /ON UPDATE/);
});

test('seeder loads faker lazily and uses the given knex', async () => {
  await Users.seeder(3, DB);
  assert.equal((await DB('users').count({ c: '*' }))[0].c, 3);
  await Users.seederCustom(2, async () => ({ name: 'fixed' }), DB);
  const rows = await DB('users').select('name');
  assert.deepEqual(rows.map((r) => r.name), ['fixed', 'fixed']);
});

const run = async (mw, req, ...extra) => {
  const res = fakeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; }, ...extra);
  return { res, nextCalled };
};

test('validationRouter: 422 on missing required / invalid / duplicate', async () => {
  const v = (body, additional, params = {}) => run(
    (req, res, next) => Users.validationRouter(req, res, next, additional), fakeReq({ body, params }),
  );

  let r = await v({ email: 'a@x.io' }, { type: 'json', create: true });
  assert.equal(r.res.statusCode, 422);
  assert.deepEqual(r.res.body, { status: false, data: { column: 'name', message: 'required' } });

  r = await v({ name: 'a', email: 'nope' }, { type: 'json', create: true });
  assert.equal(r.res.statusCode, 422);
  assert.deepEqual(r.res.body.data, { column: 'email', message: ['email format required'] });

  await DB('users').insert({ name: 'a', email: 'a@x.io' });
  r = await v({ name: 'b', email: 'a@x.io' }, { type: 'json', create: true });
  assert.equal(r.res.statusCode, 422);
  assert.match(r.res.body.data.message[0], /duplicate/);

  // updating the same row with its own email is fine
  r = await v({ email: 'a@x.io' }, { type: 'json', create: false }, { id: '1' });
  assert.equal(r.nextCalled, true);

  // soft-deleted rows don't count as duplicates
  await DB('users').update({ deleted_at: new Date() }).where('id', 1);
  r = await v({ name: 'b', email: 'a@x.io' }, { type: 'json', create: true });
  assert.equal(r.nextCalled, true);
});

test('validationRouter: sanitizes body (no id / audit columns / unknown keys), tolerates undefined body', async () => {
  const req = fakeReq({
    body: {
      id: 99, name: 'a', email: 'a@x.io', password: 'pw', deleted_at: '2020-01-01', created_by: 5, isAdmin: true,
    },
  });
  const { nextCalled } = await run((rq, rs, nx) => Users.validationRouter(rq, rs, nx, { type: 'json', create: true }), req);
  assert.equal(nextCalled, true);
  // `password` is hidden and not flagged writable: dropped (U18)
  assert.deepEqual(req.body, { name: 'a', email: 'a@x.io' });

  const empty = fakeReq({ body: undefined, params: { id: '1' } });
  const r = await run((rq, rs, nx) => Users.validationRouter(rq, rs, nx, { type: 'json', create: false }), empty);
  assert.equal(r.nextCalled, true);
  assert.deepEqual(empty.body, {});

  const mapped = fakeReq({ body: undefined });
  await run((rq, rs, nx) => Users.mapRequest(rq, rs, nx, { type: 'json', create: false, pref: '' }), mapped);
  assert.deepEqual(mapped.dataReq, {});
  assert.equal(mapped.isFormData, undefined);
});

test('validationRouter: upload columns required only on create', async () => {
  class Avatars extends Users {
    static column = { ...Users.column, avatar: { flag: { upload: true } } };
  }
  const create = await run((rq, rs, nx) => Avatars.validationRouter(rq, rs, nx, { type: 'multipart', create: true }),
    fakeReq({ body: { name: 'a', email: 'a@x.io' } }));
  assert.equal(create.res.statusCode, 422);
  assert.equal(create.res.body.data.column, 'avatar');

  const update = await run((rq, rs, nx) => Avatars.validationRouter(rq, rs, nx, { type: 'multipart', create: false }),
    fakeReq({ body: { name: 'b' }, params: { id: '1' } }));
  assert.equal(update.nextCalled, true);
});

test('checkParamId: 404 when missing or soft-deleted, next() otherwise', async () => {
  await DB('users').insert([{ name: 'a', email: 'a@x.io' }, { name: 'b', email: 'b@x.io', deleted_at: new Date() }]);
  const check = (id) => run((rq, rs, nx) => Users.checkParamId(rq, rs, nx), fakeReq({ params: { id } }));

  assert.equal((await check('1')).nextCalled, true);
  const gone = await check('2');
  assert.equal(gone.res.statusCode, 404);
  assert.deepEqual(gone.res.body, { status: false, message: "ID 2 doesn't exist" });
  assert.equal((await check('42')).res.statusCode, 404);
  assert.equal((await run((rq, rs, nx) => Users.checkParamId(rq, rs, nx), fakeReq())).nextCalled, true);

  await DB('tags').insert({ label: 't' });
  assert.equal((await run((rq, rs, nx) => Tags.checkParamId(rq, rs, nx), fakeReq({ params: { id: '1' } }))).nextCalled, true);
});

test('U17: validationRouter rejects objects/arrays unless the column is json: true', async () => {
  const v = (Model, body) => run((rq, rs, nx) => Model.validationRouter(rq, rs, nx, { type: 'json', create: true }), fakeReq({ body }));

  let r = await v(Users, { name: { x: 'y' }, email: 'a@x.io' });
  assert.equal(r.nextCalled, false);
  assert.equal(r.res.statusCode, 422);
  assert.deepEqual(r.res.body, { status: false, data: { column: 'name', message: 'must be a scalar value' } });

  r = await v(Users, { name: 'a', email: ['a@x.io'] });
  assert.equal(r.res.statusCode, 422);
  assert.equal(r.res.body.data.column, 'email');

  class WithMeta extends Users {
    static column = {
      ...Users.column,
      meta: {
        flag: { required: false, json: true },
        validation: [{ run: (x) => x.value.startsWith('{'), msg: 'object required' }],
      },
    };
  }
  const req = fakeReq({ body: { name: 'a', email: 'b@x.io', meta: { tags: ['x'] } } });
  r = await run((rq, rs, nx) => WithMeta.validationRouter(rq, rs, nx, { type: 'json', create: true }), req);
  assert.equal(r.nextCalled, true, JSON.stringify(r.res.body));
  assert.deepEqual(req.body.meta, { tags: ['x'] });

  assert.deepEqual(Users.validation({ name: ['a'], email: 'a@x.io' }), { status: false, data: { column: 'name', message: 'must be a scalar value' } });
  assert.equal(WithMeta.validation({ name: 'a', email: 'a@x.io', meta: { a: 1 } }, 'update').status, true);
});

test('U18: hidden columns are dropped by validationRouter unless flag.writable', async () => {
  const req = fakeReq({ body: { name: 'a', email: 'a@x.io', password: 'pw' } });
  let r = await run((rq, rs, nx) => Users.validationRouter(rq, rs, nx, { type: 'json', create: true }), req);
  assert.equal(r.nextCalled, true);
  assert.equal('password' in req.body, false);
  assert.equal(Users.writableColumns().includes('password'), false);

  class WritablePw extends Users {
    static column = {
      ...Users.column,
      password: {
        flag: { required: true, writable: true },
        validation: [{ run: (x) => x.value.length >= 8, msg: 'too short' }],
      },
    };
  }
  assert.equal(WritablePw.writableColumns().includes('password'), true);
  const ok = fakeReq({ body: { name: 'a', email: 'b@x.io', password: 'longenough' } });
  r = await run((rq, rs, nx) => WritablePw.validationRouter(rq, rs, nx, { type: 'json', create: true }), ok);
  assert.equal(r.nextCalled, true);
  assert.equal(ok.body.password, 'longenough');

  r = await run((rq, rs, nx) => WritablePw.validationRouter(rq, rs, nx, { type: 'json', create: true }),
    fakeReq({ body: { name: 'a', email: 'c@x.io', password: 'short' } }));
  assert.equal(r.res.statusCode, 422);
  assert.deepEqual(r.res.body.data, { column: 'password', message: ['too short'] });
  // still never serialized
  assert.equal('password' in WritablePw.fromJson({ password: 'x' }).toJSON(), false);
});

test('U-d: validation() create mode skips the pk (unless fillable) and non-writable hidden columns', () => {
  class Strict extends Users {
    static column = {
      ...Users.column,
      id: { flag: {} }, // required not false
      password: { flag: {} }, // hidden, not writable
    };
  }
  assert.deepEqual(Strict.validation({ name: 'a', email: 'a@x.io' }), { status: true });

  class FillableId extends Strict {
    static column = { ...Strict.column, id: { flag: { fillable: true } } };
  }
  assert.deepEqual(FillableId.validation({ name: 'a', email: 'a@x.io' }), { status: false, data: { column: 'id', message: 'required' } });

  class WritablePw extends Strict {
    static column = { ...Strict.column, password: { flag: { writable: true } } };
  }
  assert.deepEqual(WritablePw.validation({ name: 'a', email: 'a@x.io' }), { status: false, data: { column: 'password', message: 'required' } });

  assert.deepEqual(Strict.validation({ email: 'a@x.io' }), { status: false, data: { column: 'name', message: 'required' } });
});
