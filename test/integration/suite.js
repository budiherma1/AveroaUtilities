// Shared integration suite, run once per dialect by mysql.test.js / pg.test.js
// (see env.js). It covers the behaviour that differs between SQL engines and
// that the in-memory SQLite unit tests cannot see.
import {
  describe, test, before, beforeEach, after,
} from 'node:test';
import assert from 'node:assert/strict';
import { Model as Objection } from 'objection';
import {
  DB, Crud, FilterSearch, getDB,
} from '../../index.js';
import { databaseConfig } from '../../DB.js';
import { dialectOfKnex } from '../../config.js';
import { Users, Posts, Tags } from '../fixtures/integration-app/app/Models/index.js';
import { fakeReq, fakeRes } from './http.js';

const MODELS = [Posts, Users, Tags];
const NEAR_NOW_MS = 5 * 60 * 1000;

const assertNearNow = (value, label) => {
  const at = new Date(value).getTime();
  assert.ok(Number.isFinite(at), `${label} is not a date: ${value}`);
  assert.ok(Math.abs(at - Date.now()) < NEAR_NOW_MS, `${label} ${new Date(at).toISOString()} is not close to now (${new Date().toISOString()})`);
};

async function resetTables() {
  for (const M of MODELS) await DB.schema.dropTableIfExists(M.tableName);
  for (const M of [...MODELS].reverse()) await M.migrationUp(DB);
}

async function seedRows() {
  await DB('it_users').insert([
    { name: 'Alice', email: 'alice@x.io', age: 31, password: 'p1', created_by: 7 },
    { name: 'alice', email: 'alice2@x.io', age: 25, password: 'p2' },
    { name: 'bob', email: 'bob@x.io', age: 40, password: 'p3' },
    { name: 'carol', email: 'carol@x.io', age: 35, password: 'p4', deleted_at: new Date() },
  ]);
  await DB('it_posts').insert([
    { user_id: 1, title: 'Node tips' },
    { user_id: 1, title: 'knex notes' },
    { user_id: 3, title: 'node again' },
    { user_id: 3, title: 'gone', deleted_at: new Date() },
  ]);
  await DB('it_tags').insert([{ label: 'a' }, { label: 'b' }]);
}

const search = (query, config) => Users.filterSearch(fakeReq({ query }), config);
const names = (r) => r.data.map((u) => u.name);

export default function suite(dialect) {
  before(async () => {
    await getDB();
    Objection.knex(DB);
    await resetTables();
  });

  after(async () => {
    for (const M of MODELS) await DB.schema.dropTableIfExists(M.tableName);
    await DB.destroy();
  });

  describe(`${dialect}: connection and migrations`, () => {
    beforeEach(resetTables);

    test('DB is built from the DB_* environment variables', () => {
      assert.equal(dialectOfKnex(DB), dialect);
      assert.equal(typeof databaseConfig.connection.port, 'number');
    });

    test('migrationUp creates the audit columns with working defaults', async () => {
      for (const column of ['created_at', 'created_by', 'updated_at', 'updated_by', 'deleted_at', 'deleted_by']) {
        assert.equal(await DB.schema.hasColumn('it_users', column), true, column);
      }
      assert.equal(await DB.schema.hasColumn('it_tags', 'created_at'), false);

      await DB('it_users').insert({ name: 'n', email: 'n@x.io' });
      const row = await DB('it_users').first();
      assertNearNow(row.created_at, 'created_at default');
      assertNearNow(row.updated_at, 'updated_at default');
      assert.equal(row.deleted_at, null);
    });

    test('updated_at ON UPDATE CURRENT_TIMESTAMP (MySQL only)', async () => {
      await DB('it_users').insert({ name: 'n', email: 'n@x.io', updated_at: new Date('2001-02-03T04:05:06Z') });
      await DB('it_users').update({ name: 'renamed' });
      const row = await DB('it_users').first();
      if (dialect === 'mysql') {
        assertNearNow(row.updated_at, 'updated_at after a raw UPDATE');
        const [[info]] = await DB.raw(
          'select extra from information_schema.columns where table_schema = database() and table_name = ? and column_name = ?',
          ['it_users', 'updated_at'],
        );
        assert.match(String(info.extra ?? info.EXTRA), /on update CURRENT_TIMESTAMP/i);
      } else {
        // no trigger on PostgreSQL: a raw UPDATE keeps the old value (Crud.update sets it explicitly)
        assert.equal(new Date(row.updated_at).toISOString(), '2001-02-03T04:05:06.000Z');
      }
    });

    test('migrationDown drops the table', async () => {
      await Tags.migrationDown(DB);
      assert.equal(await DB.schema.hasTable('it_tags'), false);
    });

    test('seeder and seederCustom insert through the given knex', async () => {
      await Users.seeder(3, DB);
      assert.equal(Number((await DB('it_users').count({ c: '*' }))[0].c), 3);
      await Users.seederCustom(2, async () => ({ name: 'fixed' }), DB);
      const rows = await DB('it_users').select('name');
      assert.deepEqual(rows.map((r) => r.name), ['fixed', 'fixed']);
    });
  });

  describe(`${dialect}: Crud`, () => {
    beforeEach(async () => {
      await resetTables();
      await seedRows();
    });

    test('create returns the generated id and fills the audit columns', async () => {
      const r = await Crud.create('Users', fakeReq({
        body: {
          id: 500, name: 'eve', email: 'eve@x.io', password: 'pw', deleted_at: '2020-01-01', created_by: 1,
        },
        user: { id: 3 },
      }));
      assert.equal(r.status, true, r.message);
      assert.ok(Number(r.data.id) > 4 && Number(r.data.id) !== 500, `id ${r.data.id}`);
      assert.equal('password' in JSON.parse(JSON.stringify(r.data)), false);

      const row = await DB('it_users').where('email', 'eve@x.io').first();
      assert.equal(Number(row.id), Number(r.data.id));
      assert.equal(row.password, null);
      assert.equal(row.deleted_at, null);
      assert.equal(Number(row.created_by), 3);
      assert.equal(Number(row.updated_by), 3);
      assertNearNow(row.created_at, 'created_at');
    });

    test('update sets updated_at / updated_by and keeps created_by', async () => {
      await DB('it_users').where('id', 1).update({ updated_at: new Date('2001-02-03T04:05:06Z') });
      const r = await Crud.update(Users, fakeReq({
        params: { id: '1' }, body: { name: 'Alicia', created_by: 99 }, user: { id: 5 },
      }));
      assert.deepEqual(r, { status: true });
      const row = await DB('it_users').where('id', 1).first();
      assert.equal(row.name, 'Alicia');
      assert.equal(Number(row.created_by), 7);
      assert.equal(Number(row.updated_by), 5);
      assertNearNow(row.updated_at, 'updated_at');
    });

    test('delete is a soft delete with the current time; soft-deleted rows are 404', async () => {
      const r = await Crud.delete(Users, fakeReq({ params: { id: '2' }, user: { id: 9 } }));
      assert.deepEqual(r, { status: true });
      const row = await DB('it_users').where('id', 2).first();
      assertNearNow(row.deleted_at, 'deleted_at');
      assert.equal(Number(row.deleted_by), 9);

      const gone = { status: false, message: "ID 2 doesn't exist", statusCode: 404 };
      assert.deepEqual(await Crud.findOne(Users, fakeReq({ params: { id: '2' } })), gone);
      assert.deepEqual(await Crud.update(Users, fakeReq({ params: { id: '2' }, body: { name: 'x' } })), gone);
      assert.deepEqual(await Crud.delete(Users, fakeReq({ params: { id: '2' } })), gone);
    });

    test('delete on a model without timestamps is a hard delete', async () => {
      assert.deepEqual(await Crud.delete(Tags, fakeReq({ params: { id: '1' } })), { status: true });
      assert.equal(await DB('it_tags').where('id', 1).first(), undefined);
    });

    test('findOne with $select and $relations excludes soft-deleted children', async () => {
      const r = await Crud.findOne(Users, fakeReq({ params: { id: '3' }, query: { $select: 'id,name', $relations: 'posts' } }));
      assert.equal(r.status, true, r.message);
      assert.deepEqual(Object.keys(r.data.toJSON()).sort(), ['id', 'name', 'posts']);
      assert.deepEqual(r.data.posts.map((p) => p.title), ['node again']);
    });

    test('a non-numeric id is a 404 (findOne / delete) or 400 (update), not a database error', async () => {
      const gone = { status: false, message: "ID abc doesn't exist", statusCode: 404 };
      assert.deepEqual(await Crud.findOne(Users, fakeReq({ params: { id: 'abc' } })), gone);
      assert.deepEqual(await Crud.delete(Users, fakeReq({ params: { id: 'abc' } })), gone);
      const update = await Crud.update(Users, fakeReq({ params: { id: 'abc' }, body: { name: 'x' } }));
      assert.equal(update.status, false);
      assert.ok([400, 404].includes(update.statusCode), JSON.stringify(update));
    });

    test('a value the column rejects is a 400 Invalid value', async () => {
      const r = await Crud.create(Users, fakeReq({ dataReq: { name: 'x'.repeat(80), email: 'long@x.io' } }));
      assert.deepEqual(r, { status: false, message: 'Invalid value', statusCode: 400 });
    });

    test('findAll with DataTables mode reports numeric totals', async () => {
      const r = await Crud.findAll(Users, fakeReq({ query: { $datatable: '1', $draw: '3', orderBy: 'id' } }));
      assert.equal(r.draw, '3');
      assert.equal(r.recordsTotal, 3);
      assert.equal(r.recordsFiltered, 3);
      assert.deepEqual(r.data.map((u) => u.name), ['Alice', 'alice', 'bob']);
    });

    test('a rolled back transaction leaves no row behind', async () => {
      await assert.rejects(DB.transaction(async (trx) => {
        const r = await Crud.create(Users, fakeReq({ dataReq: { name: 'tx', email: 'tx@x.io' } }), {}, trx);
        assert.equal(r.status, true, r.message);
        assert.ok(await trx('it_users').where('email', 'tx@x.io').first());
        throw new Error('rollback');
      }), /rollback/);
      assert.equal(await DB('it_users').where('email', 'tx@x.io').first(), undefined);
    });

    test('database errors are reported without SQL', async () => {
      class Broken extends Users {
        static tableName = 'it_missing_table';
      }
      const r = await Crud.findAll(Broken, fakeReq({ query: {} }));
      assert.deepEqual(r, { status: false, message: 'Database error', statusCode: 500 });
    });
  });

  describe(`${dialect}: FilterSearch`, () => {
    beforeEach(async () => {
      await resetTables();
      await seedRows();
    });

    test('default listing excludes soft-deleted rows; counts are numbers', async () => {
      const r = await search({ orderBy: 'id' });
      assert.equal(r.status, true, r.message);
      assert.deepEqual(names(r), ['Alice', 'alice', 'bob']);
      assert.deepEqual(r.metadata, {
        item_total: 3, per_page: 3, page_total: 1, current_page: 1, has_next_page: false, has_prev_page: false,
      });
      assert.equal(r.data.some((u) => 'password' in u.toJSON()), false);
    });

    test(':like is case-sensitive, :ilike and :search are not', async () => {
      assert.deepEqual(names(await search({ 'name:like': 'al%', orderBy: 'id' })), ['alice']);
      assert.deepEqual(names(await search({ 'name:like': 'Al%', orderBy: 'id' })), ['Alice']);
      assert.deepEqual(names(await search({ 'name:ilike': 'AL%', orderBy: 'id' })), ['Alice', 'alice']);
      assert.deepEqual(names(await search({ 'name|email:search': 'ALI', orderBy: 'id' })), ['Alice', 'alice']);
      assert.deepEqual(names(await search({ 'name:like': "x' OR '1'='1" })), []);
    });

    test(':like / :ilike / :search on a numeric column', async () => {
      const like = await search({ 'age:like': '3%', orderBy: 'id' });
      assert.equal(like.status, true, like.message);
      assert.deepEqual(names(like), ['Alice']);
      const ilike = await search({ 'age:ilike': '%5', orderBy: 'id' });
      assert.equal(ilike.status, true, ilike.message);
      assert.deepEqual(names(ilike), ['alice']);
      const words = await search({ 'name|age:search': '40', orderBy: 'id' });
      assert.equal(words.status, true, words.message);
      assert.deepEqual(names(words), ['bob']);
    });

    test('comparison, in, between and null operators', async () => {
      assert.deepEqual(names(await search({ 'age:gte': '31', orderBy: 'age' })), ['Alice', 'bob']);
      assert.deepEqual(names(await search({ 'age:lt': '31' })), ['alice']);
      assert.deepEqual(names(await search({ 'age:neq': '31', orderBy: 'id' })), ['alice', 'bob']);
      assert.deepEqual(names(await search({ 'id:in': '1,3', orderBy: 'id' })), ['Alice', 'bob']);
      assert.deepEqual(names(await search({ 'age:btwn': '20,35', orderByDesc: 'age' })), ['Alice', 'alice']);
      assert.deepEqual(names(await search({ 'created_by:notNull': '' })), ['Alice']);
      assert.deepEqual(names(await search({ 'created_by:isNull': '', orderBy: 'id' })), ['alice', 'bob']);
      assert.deepEqual(names(await search({ email: 'bob@x.io' })), ['bob']);
      const today = new Date().toISOString().slice(0, 10);
      const r = await search({ 'created_at:btwn': `2000-01-01,${today} 23:59:59`, orderBy: 'id' });
      assert.equal(r.status, true, r.message);
      assert.equal(r.data.length, 3);
    });

    test('a value of the wrong type is a 400, not a database error', async () => {
      // PostgreSQL rejects these (400); MySQL compares them after a cast (200)
      for (const query of [{ id: 'abc' }, { 'id:in': '1,abc' }, { 'age:gt': 'x' }, { 'created_at:lt': 'not-a-date' }]) {
        const r = await search(query);
        if (!r.status) assert.deepEqual(r, { status: false, message: 'Invalid value', statusCode: 400 }, JSON.stringify(query));
      }
      const builder = DB('it_users');
      const knexMode = await FilterSearch.knex(builder, fakeReq({ query: { id: 'abc' } }), { column: ['id', 'name'] });
      if (!knexMode.status) assert.deepEqual(knexMode, { status: false, message: 'Invalid value', statusCode: 400 });
    });

    test('orderBy / orderByDesc and pagination', async () => {
      assert.deepEqual(names(await search({ orderByDesc: 'age' })), ['bob', 'Alice', 'alice']);
      const page2 = await search({ orderBy: 'id', limit: '2', page: '2' });
      assert.deepEqual(names(page2), ['bob']);
      assert.deepEqual(page2.metadata, {
        item_total: 3, per_page: 2, page_total: 2, current_page: 2, has_next_page: false, has_prev_page: true,
      });
    });

    test('groupBy returns one row per value and a distinct count', async () => {
      await DB('it_users').insert({ name: 'bob', email: 'bob2@x.io', age: 41 });
      // MySQL's default collation is case-insensitive: Alice and alice are one group there
      const groups = dialect === 'mysql' ? 2 : 3;
      const r = await search({ groupBy: 'name', orderBy: 'name' });
      assert.equal(r.status, true, r.message);
      assert.equal(r.metadata.item_total, groups);
      assert.equal(r.data.length, groups);
      assert.equal(new Set(r.data.map((u) => u.name.toLowerCase())).size, 2);
      assert.deepEqual(Object.keys(r.data[0].toJSON()), ['name']);
      const selected = await search({ groupBy: 'name', $select: 'name', 'age:gte': '30' });
      assert.equal(selected.status, true, selected.message);
      assert.deepEqual(selected.data.map((u) => u.name).sort(), ['Alice', 'bob']);
      assert.equal(selected.metadata.item_total, 2);

      const knexMode = await FilterSearch.knex(DB('it_users'), fakeReq({ query: { groupBy: 'name', orderByDesc: 'name' } }), {
        column: ['id', 'name'], timestamp: true,
      });
      assert.equal(knexMode.status, true, knexMode.message);
      assert.equal(knexMode.data.length, groups);
      assert.deepEqual(Object.keys(knexMode.data[0]), ['name']);

      for (const query of [{ groupBy: 'name', $select: 'id,name' }, { groupBy: 'name', orderBy: 'id' }, { groupBy: 'name', $relations: 'posts' }]) {
        const bad = await search(query);
        assert.equal(bad.statusCode, 400, JSON.stringify(query));
      }
    });

    test('$relations fetch and join, filtering on a related column', async () => {
      const fetched = await search({ $relations: 'posts', orderBy: 'id' });
      assert.equal(fetched.status, true, fetched.message);
      assert.deepEqual(fetched.data.map((u) => u.posts.length), [2, 0, 1]);

      const joined = await search({
        $relations: 'posts', '$relations-type': 'join', 'posts.title:ilike': '%node%', orderBy: 'id',
      });
      assert.equal(joined.status, true, joined.message);
      assert.deepEqual(names(joined), ['Alice', 'bob']);
      assert.equal(joined.metadata.item_total, 2);
      assert.deepEqual(joined.data[0].posts.map((p) => p.title).sort(), ['Node tips', 'knex notes']);

      const gone = await search({ $relations: 'posts', '$relations-type': 'join', 'posts.title:eq': 'gone' });
      assert.equal(gone.status, true, gone.message);
      assert.equal(gone.metadata.item_total, 0);

      const paged = await search({
        $relations: 'posts', '$relations-type': 'join', orderByDesc: 'name', limit: '1', page: '2',
      });
      assert.equal(paged.status, true, paged.message);
      assert.equal(paged.metadata.item_total, 3);
      assert.equal(paged.data.length, 1);
    });

    test('$withTrashed includes soft-deleted rows', async () => {
      const r = await search({ $withTrashed: '1', orderBy: 'id' });
      assert.deepEqual(names(r), ['Alice', 'alice', 'bob', 'carol']);
    });

    test('FilterSearch.knex with an aliased table and soft delete', async () => {
      const builder = DB('it_users as u').leftJoin('it_posts as p', 'p.user_id', 'u.id').select('u.id', 'u.name').groupBy('u.id', 'u.name');
      const r = await FilterSearch.knex(builder, fakeReq({ query: { 'u.name:ilike': '%a%', orderBy: 'u.id' } }), {
        column: ['u.id', 'u.name'], timestamp: true,
      });
      assert.equal(r.status, true, r.message);
      assert.deepEqual(r.data.map((u) => u.name), ['Alice', 'alice']);
      assert.equal(r.metadata.item_total, 2);
    });
  });

  describe(`${dialect}: Model hooks`, () => {
    beforeEach(async () => {
      await resetTables();
      await seedRows();
    });

    const run = async (mw, req) => {
      const res = fakeRes();
      let nextCalled = false;
      await mw(req, res, () => { nextCalled = true; });
      return { res, nextCalled };
    };
    const validate = (body, additional, params = {}) => run(
      (req, res, next) => Users.validationRouter(req, res, next, additional),
      fakeReq({ body, params }),
    );

    test('validationRouter: unique check against live rows only', async () => {
      let r = await validate({ name: 'a', email: 'bob@x.io' }, { type: 'json', create: true });
      assert.equal(r.res.statusCode, 422);
      assert.deepEqual(r.res.body.data, { column: 'email', message: ['duplicate value bob@x.io'] });

      // carol is soft-deleted: her email may be reused
      r = await validate({ name: 'a', email: 'carol@x.io' }, { type: 'json', create: true });
      assert.equal(r.nextCalled, true, JSON.stringify(r.res.body));

      // updating bob with his own email is not a duplicate
      r = await validate({ email: 'bob@x.io' }, { type: 'json' }, { id: '3' });
      assert.equal(r.nextCalled, true, JSON.stringify(r.res.body));

      r = await validate({ email: 'bob@x.io' }, { type: 'json' }, { id: '1' });
      assert.equal(r.res.statusCode, 422);
    });

    test('validationRouter: a non-numeric route id does not break the unique check', async () => {
      const r = await validate({ email: 'new@x.io' }, { type: 'json' }, { id: 'abc' });
      assert.equal(r.nextCalled, true, JSON.stringify(r.res.body));
    });

    test('checkParamId: 404 for missing, soft-deleted and non-numeric ids', async () => {
      const check = (id) => run((req, res, next) => Users.checkParamId(req, res, next), fakeReq({ params: { id } }));
      assert.equal((await check('1')).nextCalled, true);
      for (const id of ['4', '999', 'abc']) {
        const r = await check(id);
        assert.equal(r.nextCalled, false, id);
        assert.equal(r.res.statusCode, 404, id);
      }
    });

    test('Model.search matches text and numeric columns', async () => {
      const rows = await Users.query().where((b) => Users.search(b, '40')).whereNull('deleted_at');
      assert.deepEqual(rows.map((u) => u.name), ['bob']);
      // without manual wrapping: search() groups its ORs itself, so the soft-delete filter still applies
      const grouped = await Users.search(Users.query().whereNull('deleted_at'), '40');
      assert.deepEqual(grouped.map((u) => u.name), ['bob']);
    });
  });
}
