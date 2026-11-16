import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DB, Users, Posts, resetDb, fakeReq,
} from './helpers.js';
import knex from 'knex';
import FilterSearch, {
  baseTableRef, errorResult, isDataError, likeClause,
} from '../FilterSearch.js';

beforeEach(async () => {
  await resetDb();
  await DB('users').insert([
    { name: 'alice', email: 'alice@x.io', password: 'p1' },
    { name: 'bob', email: 'bob@x.io', password: 'p2' },
    { name: 'carol', email: 'carol@x.io', password: 'p3', deleted_at: new Date() },
  ]);
  await DB('posts').insert([
    { user_id: 1, title: 'first' },
    { user_id: 1, title: 'second' },
    { user_id: 2, title: 'gone', deleted_at: new Date() },
  ]);
});

const search = (query) => Users.filterSearch(fakeReq({ query }));

test('default listing excludes soft-deleted rows and keeps metadata shape', async () => {
  const r = await search({});
  assert.equal(r.status, true);
  assert.deepEqual(r.data.map((u) => u.name), ['alice', 'bob']);
  assert.deepEqual(r.metadata, {
    item_total: 2, per_page: 2, page_total: 1, current_page: 1, has_next_page: false, has_prev_page: false,
  });
});

test(':like with SQL injection payload is bound, not interpolated', async () => {
  const r = await search({ 'name:like': "x' OR '1'='1" });
  assert.equal(r.status, true);
  assert.equal(r.data.length, 0);

  const sql = Users.query().whereRaw('?? like binary ?', ['users.name', "x' OR '1'='1"]).toKnexQuery().toSQL();
  assert.deepEqual(sql.bindings, ["x' OR '1'='1"]);

  const ok = await search({ 'name:like': 'al%' });
  assert.deepEqual(ok.data.map((u) => u.name), ['alice']);
});

test(':like / :ilike SQL per dialect is parameterized', () => {
  const build = (client, op) => {
    const fs = new FilterSearch();
    fs.dialect = client;
    const qb = knex({ client: client === 'mysql' ? 'mysql2' : client });
    const builder = qb('users');
    fs.operator(op, `name:${op}`, "x' OR '1'='1")(builder, 'users.name', false);
    return builder.toSQL();
  };
  // MySQL: case-sensitive via cast(? as binary) (`like binary ?` is deprecated since 8.0.27)
  const mysql = build('mysql', 'like');
  assert.equal(mysql.sql, 'select * from `users` where `users`.`name` like cast(? as binary)');
  assert.deepEqual(mysql.bindings, ["x' OR '1'='1"]);
  assert.equal(build('mysql', 'ilike').sql, 'select * from `users` where `users`.`name` like ?');
  // PostgreSQL: cast to text, so numeric / date columns don't fail with "operator does not exist"
  const pg = build('pg', 'ilike');
  assert.equal(pg.sql, 'select * from "users" where cast("users"."name" as text) ilike ?');
  const pgLike = build('pg', 'like');
  assert.equal(pgLike.sql, 'select * from "users" where cast("users"."name" as text) like ?');
  assert.deepEqual(pgLike.bindings, ["x' OR '1'='1"]);
  const pgSearch = build('pg', 'search');
  const castIlike = 'cast("users"."name" as text) ilike ?';
  assert.equal(pgSearch.sql, `select * from "users" where (${[castIlike, castIlike, castIlike].join(' or ')})`); // 3 words
  assert.equal(build('better-sqlite3', 'like').sql, 'select * from `users` where `users`.`name` like ?');
});

test('likeClause is parameterized for every dialect', () => {
  const payload = "%' or 1=1 --";
  for (const [client, dialect] of [['mysql2', 'mysql'], ['pg', 'pg'], ['better-sqlite3', 'sqlite']]) {
    for (const insensitive of [false, true]) {
      const q = likeClause(knex({ client })('t'), dialect, 't.c', payload, { insensitive }).toSQL();
      assert.deepEqual(q.bindings, [payload], `${dialect} ${insensitive}`);
      assert.doesNotMatch(q.sql, /or 1=1/);
    }
  }
});

test('groupBy pagination counts a NULL group like any other group', async () => {
  await DB('users').insert({ name: null, email: 'nameless@x.io', password: 'p' });
  const r = await search({ groupBy: 'name', orderBy: 'name', limit: 2 });
  assert.equal(r.status, true, r.message);
  // groups: null, alice, bob (COUNT(DISTINCT name) would say 2 and hide the last page)
  assert.equal(r.metadata.item_total, 3);
  assert.equal(r.metadata.page_total, 2);
  assert.equal(r.metadata.has_next_page, true);
  const page2 = await search({ groupBy: 'name', orderBy: 'name', limit: 2, page: 2 });
  assert.deepEqual(page2.data.map((u) => u.toJSON()), [{ name: 'bob' }]);
});

test('groupBy returns only the grouped column; $select / orderBy / $relations must fit it', async () => {
  await DB('users').insert({ name: 'bob', email: 'bob2@x.io', password: 'p' });
  const r = await search({ groupBy: 'name', orderByDesc: 'name' });
  assert.equal(r.status, true, r.message);
  assert.deepEqual(r.data.map((u) => u.toJSON()), [{ name: 'bob' }, { name: 'alice' }]);
  assert.equal(r.metadata.item_total, 2);
  assert.equal((await search({ groupBy: 'name', $select: 'name' })).status, true);

  for (const [query, message] of [
    [{ groupBy: 'name', $select: 'id,name' }, 'with groupBy, $select may only contain the groupBy column'],
    [{ groupBy: 'name', orderBy: 'id' }, 'with groupBy, orderBy / orderByDesc may only use the groupBy column'],
    [{ groupBy: 'name', $relations: 'posts' }, '$relations cannot be combined with groupBy'],
  ]) {
    assert.deepEqual(await search(query), { status: false, message, statusCode: 400 });
  }
});

test('isDataError / errorResult: a value the database rejects is a 400, other DB errors a 500', () => {
  const pgInvalid = Object.assign(new Error('invalid input syntax for type integer: "abc"'), { code: '22P02', severity: 'ERROR' });
  const mysqlTruncated = Object.assign(new Error('Truncated incorrect DOUBLE value'), {
    code: 'ER_TRUNCATED_WRONG_VALUE', errno: 1292, sqlState: '22007', sqlMessage: 'x',
  });
  const mysqlWrongValue = Object.assign(new Error('Incorrect TIMESTAMP value'), {
    code: 'ER_WRONG_VALUE', errno: 1525, sqlState: 'HY000', sqlMessage: 'x',
  });
  const wrapped = Object.assign(new Error('select ... - invalid input'), { name: 'DataError', nativeError: pgInvalid });
  for (const e of [pgInvalid, mysqlTruncated, mysqlWrongValue, wrapped]) {
    assert.equal(isDataError(e), true, e.message);
    assert.deepEqual(errorResult(e), { status: false, message: 'Invalid value', statusCode: 400 });
  }
  const missingTable = Object.assign(new Error('relation "x" does not exist'), { code: '42P01', severity: 'ERROR' });
  const sqlite = Object.assign(new Error('SQLITE_ERROR: no such table'), { code: 'SQLITE_ERROR' });
  for (const e of [missingTable, sqlite, new Error('boom'), null, 'x']) {
    assert.equal(isDataError(e), false, String(e?.message ?? e));
  }
  assert.deepEqual(errorResult(missingTable), { status: false, message: 'Database error', statusCode: 500 });
});

test('operators eq/in/btwn/search/multi-column', async () => {
  assert.deepEqual((await search({ 'name:eq': 'bob' })).data.map((u) => u.name), ['bob']);
  assert.deepEqual((await search({ 'name:in': 'alice,bob' })).data.length, 2);
  assert.deepEqual((await search({ 'id:btwn': '2,3' })).data.map((u) => u.name), ['bob']);
  assert.deepEqual((await search({ 'name|email:search': 'bo' })).data.map((u) => u.name), ['bob']);
  assert.deepEqual((await search({ name: 'alice' })).data.map((u) => u.name), ['alice']);
  assert.deepEqual((await search({ orderByDesc: 'name' })).data.map((u) => u.name), ['bob', 'alice']);
});

test('$select rejects hidden and unknown columns', async () => {
  const hidden = await search({ $select: 'id,password' });
  assert.equal(hidden.status, false);
  assert.match(hidden.message, /password is not selectable/);

  const unknown = await search({ $select: 'nope' });
  assert.equal(unknown.status, false);

  const ok = await search({ $select: 'id,name' });
  assert.equal(ok.status, true);
  assert.deepEqual(Object.keys(ok.data[0]).sort(), ['id', 'name']);
});

test('hidden columns cannot be filtered or ordered on', async () => {
  assert.equal((await search({ 'password:like': 'p%' })).status, false);
  // a bare hidden column is ignored, never applied as a filter (U9)
  const bareHidden = await search({ password: 'p1' });
  assert.equal(bareHidden.status, true);
  assert.equal(bareHidden.data.length, 2);
  assert.equal((await search({ orderBy: 'password' })).status, false);
});

test('hidden columns are not serialized', async () => {
  const r = await search({});
  const json = JSON.parse(JSON.stringify(r.data));
  assert.equal('password' in json[0], false);
  assert.equal('name' in json[0], true);
});

test('$relations limited to allowGraph; related soft-deleted rows hidden', async () => {
  const bad = await search({ $relations: 'secrets' });
  assert.equal(bad.status, false);
  assert.match(bad.message, /not allowed/);

  const deep = await search({ $relations: 'posts.author' });
  assert.equal(deep.status, false);

  const syntax = await search({ $relations: '[posts' });
  assert.equal(syntax.status, false);

  const ok = await search({ $relations: 'posts', orderBy: 'id' });
  assert.equal(ok.status, true);
  assert.deepEqual(ok.data[0].posts.map((p) => p.title), ['first', 'second']);
  assert.deepEqual(ok.data[1].posts, []); // bob's only post is soft-deleted

  const join = await search({ $relations: 'posts', '$relations-type': 'join', 'posts.title': 'second' });
  assert.equal(join.status, true, join.message);
  assert.equal(join.metadata.item_total, 1);
  assert.equal(join.data[0].name, 'alice');
  assert.deepEqual(join.data[0].posts.map((p) => p.title), ['first', 'second']);

  const joinOrdered = await search({ $relations: 'posts', '$relations-type': 'join', orderByDesc: 'name' });
  assert.equal(joinOrdered.status, true, joinOrdered.message);
  assert.deepEqual(joinOrdered.data.map((u) => u.name), ['bob', 'alice']);
  assert.equal(joinOrdered.metadata.item_total, 2);
});

test('models without relations reject $relations', async () => {
  const r = await Posts.filterSearch(fakeReq({ query: { $relations: 'posts' } }));
  assert.equal(r.status, false);
  assert.match(r.message, /relations are not allowed/);
});

test('$withTrashed only when allowWithTrashed', async () => {
  assert.equal((await search({ $withTrashed: '1' })).status, false);
  class Trashy extends Users { static allowWithTrashed = true; }
  const r = await Trashy.filterSearch(fakeReq({ query: { $withTrashed: '1' } }));
  assert.equal(r.status, true);
  assert.equal(r.data.length, 3);
});

test('operator on unknown column and unknown operator return an error result (no crash)', async () => {
  const r = await search({ 'nope:eq': '1' });
  assert.deepEqual(r, { status: false, message: "column nope doesn't exist", statusCode: 400 });
  assert.equal((await search({ 'name:drop': 'x' })).status, false);
  assert.equal((await search({ 'name:eq': { $gt: '' } })).status, false);
});

test('limit/page validation and maxLimit', async () => {
  assert.equal((await search({ limit: '-1' })).status, false);
  assert.equal((await search({ limit: 'abc' })).status, false);
  assert.equal((await search({ page: '0' })).status, false);

  const all = await search({ limit: '0' });
  assert.equal(all.data.length, 2);

  const paged = await search({ limit: '1', page: '2', orderBy: 'id' });
  assert.deepEqual(paged.data.map((u) => u.name), ['bob']);
  assert.equal(paged.metadata.has_prev_page, true);
  assert.equal(paged.metadata.has_next_page, false);

  const capped = await FilterSearch.model(Users, fakeReq({ query: { limit: '50' } }), { maxLimit: 1 });
  assert.equal(capped.data.length, 1);
  assert.equal(capped.metadata.page_total, 2);
});

test('knex mode: column whitelist, hidden, soft delete', async () => {
  const req = (query) => fakeReq({ query });
  const cfg = { column: ['id', 'name', 'email', 'password'], hidden: ['password'], timestamp: true };

  assert.equal((await FilterSearch.knex(DB('users'), req({}), {})).status, false);

  const r = await FilterSearch.knex(DB('users'), req({ 'name:like': "x' OR '1'='1" }), cfg);
  assert.equal(r.status, true);
  assert.equal(r.data.length, 0);

  const list = await FilterSearch.knex(DB('users'), req({}), cfg);
  assert.equal(list.data.length, 2);
  assert.equal('password' in list.data[0], false);

  assert.equal((await FilterSearch.knex(DB('users'), req({ $select: 'password' }), cfg)).status, false);
  assert.equal((await FilterSearch.knex(DB('users'), req({ $relations: 'posts' }), cfg)).status, false);
});

test('req.query is not mutated', async () => {
  const query = { 'name:eq': 'bob' };
  const r = await search(query);
  assert.equal(r.status, true);
  assert.deepEqual(query, { 'name:eq': 'bob' });
});

test('U3: knex/driver errors return a generic message without SQL or values', async () => {
  const r = await FilterSearch.knex(DB('no_such_table'), fakeReq({ query: { 'name:eq': 'S3cretHash' } }), { column: ['name'] });
  assert.deepEqual(r, { status: false, message: 'Database error', statusCode: 500 });
  const m = await FilterSearch.model(Users, fakeReq({ query: { 'name:eq': 'x' } }), {});
  assert.equal(m.status, true);
});

test('U4: $relations-type=join left-joins and ignores soft-deleted related rows', async () => {
  const join = { $relations: 'posts', '$relations-type': 'join' };
  // bob's only post is soft-deleted: filtering on it must not match
  const deleted = await search({ ...join, 'posts.title:eq': 'gone' });
  assert.equal(deleted.status, true, deleted.message);
  assert.equal(deleted.metadata.item_total, 0);
  assert.deepEqual(deleted.data, []);

  // parents without (live) children are kept, like a left join in 1.x
  await DB('users').insert({ name: 'dave', email: 'dave@x.io' });
  const all = await search({ ...join, orderBy: 'id' });
  assert.equal(all.status, true, all.message);
  assert.deepEqual(all.data.map((u) => u.name), ['alice', 'bob', 'dave']);
  assert.equal(all.metadata.item_total, 3);
  assert.deepEqual(all.data.map((u) => u.posts.length), [2, 0, 0]);

  // keys that look like Object.prototype members are not relations
  const proto = await search({ ...join, 'constructor.name:eq': 'x' });
  assert.deepEqual(proto, { status: false, message: "column constructor.name doesn't exist", statusCode: 400 });
});

test('U7: knex mode counts on a copy without the builder\'s select/orderBy', async () => {
  const seen = [];
  const listen = (q) => seen.push(q.sql);
  DB.on('query', listen);
  try {
    const r = await FilterSearch.knex(
      DB('users').select('id', 'name').orderBy('name'),
      fakeReq({ query: { 'name:eq': 'bob' } }),
      { column: ['id', 'name'] },
    );
    assert.equal(r.status, true, r.message);
    assert.equal(r.metadata.item_total, 1);
    assert.deepEqual(r.data, [{ id: 2, name: 'bob' }]);
  } finally {
    DB.removeListener('query', listen);
  }
  const count = seen.find((sql) => sql.includes('count('));
  assert.ok(count, seen.join('\n'));
  assert.doesNotMatch(count, /order by/i);
  assert.match(count, /^select count\(\*\) as `\$count` from `users`/);
});

test('U8: knex mode accepts qualified whitelist columns', async () => {
  const builder = () => DB('users as u').join('posts as p', 'p.user_id', 'u.id').select('u.id', 'u.name', 'p.title');
  const cfg = { column: ['u.id', 'u.name', 'p.title'] };
  const r = await FilterSearch.knex(builder(), fakeReq({ query: { 'u.id:eq': '1', orderByDesc: 'p.title' } }), cfg);
  assert.equal(r.status, true, r.message);
  assert.deepEqual(r.data.map((x) => x.title), ['second', 'first']);

  const bare = await FilterSearch.knex(builder(), fakeReq({ query: { 'p.title': 'first' } }), cfg);
  assert.equal(bare.status, true, bare.message);
  assert.equal(bare.data.length, 1);

  const notListed = await FilterSearch.knex(builder(), fakeReq({ query: { 'u.password:eq': 'p1' } }), cfg);
  assert.equal(notListed.status, false);
});

test('U9: unknown non-operator query keys are ignored, operator keys stay strict', async () => {
  const r = await search({
    _: '1700000000000', utm_source: 'mail', draw: '2', columns: [{ data: 'name' }], 'utm:x': 'y', nope: '1',
  });
  assert.equal(r.status, true, r.message);
  assert.equal(r.data.length, 2);

  // known columns still filter alongside ignored keys
  const named = await search({ name: 'bob', utm_campaign: 'x', _: '1' });
  assert.deepEqual(named.data.map((u) => u.name), ['bob']);

  // hidden columns are never applied: neither bare nor with an operator
  assert.equal((await search({ password: 'nomatch' })).data.length, 2);
  assert.equal((await search({ 'password:eq': 'p1' })).status, false);
  assert.equal((await search({ 'nope:like': 'x' })).status, false);
  // a known column with a non-scalar value is still rejected
  assert.equal((await search({ name: { $gt: '' } })).status, false);
});

test('U9: knex mode ignores unknown keys and `_` too', async () => {
  const r = await FilterSearch.knex(DB('users'), fakeReq({ query: { _: '1', utm_source: 'x', name: 'bob' } }), { column: ['id', 'name'] });
  assert.equal(r.status, true, r.message);
  assert.deepEqual(r.data.map((u) => u.name), ['bob']);
});

test('U-c: :in / :btwn reject object values and arrays of non-strings', async () => {
  for (const [key, value] of [
    ['id:in', { a: '1' }],
    ['id:in', ['1', { a: '2' }]],
    ['id:btwn', { from: '1', to: '2' }],
    ['id:btwn', [['1'], '2']],
  ]) {
    assert.deepEqual(await search({ [key]: value }), { status: false, message: `invalid value for ${key}`, statusCode: 400 }, key);
  }
  // repeated keys (arrays of strings) still work
  assert.deepEqual((await search({ 'id:in': ['1', '2'] })).data.map((u) => u.name), ['alice', 'bob']);
  assert.deepEqual((await search({ 'id:btwn': ['2', '3'] })).data.map((u) => u.name), ['bob']);
  assert.equal((await search({ $select: { a: 'id' } })).message, 'invalid $select');
});

test('U-e: knex mode qualifies deleted_at with the base table (alias, name or config.table)', async () => {
  assert.equal(baseTableRef(DB('users')), 'users');
  assert.equal(baseTableRef(DB('users as u')), 'u');
  assert.equal(baseTableRef(DB({ u: 'users' })), 'u');
  assert.equal(baseTableRef(DB.from(DB.raw('users u'))), null);
  assert.equal(baseTableRef(DB.from((q) => q.from('users').as('x'))), null);
  assert.equal(baseTableRef(DB.select(1)), null);

  // both tables have deleted_at: an unqualified filter would be ambiguous
  const joined = () => DB('users as u').join('posts as p', 'p.user_id', 'u.id').select('u.id', 'u.name', 'p.title');
  const cfg = { column: ['u.id', 'u.name', 'p.title'], timestamp: true };
  const seen = [];
  const listen = (q) => seen.push(q.sql);
  DB.on('query', listen);
  let r;
  try {
    r = await FilterSearch.knex(joined(), fakeReq({ query: { orderBy: 'p.title' } }), cfg);
  } finally {
    DB.removeListener('query', listen);
  }
  assert.equal(r.status, true, r.message);
  assert.deepEqual(r.data.map((x) => x.title), ['first', 'gone', 'second']);
  assert.ok(seen.every((sql) => sql.includes('`u`.`deleted_at` is null')), seen.join('\n'));

  // config.table wins over the derived name
  await DB('users').where('id', 2).update({ deleted_at: new Date() });
  const explicit = await FilterSearch.knex(joined(), fakeReq({ query: {} }), { ...cfg, table: 'u' });
  assert.deepEqual(explicit.data.map((x) => x.title).sort(), ['first', 'second']);

  // not derivable → unqualified, as before
  const raw = await FilterSearch.knex(DB.from(DB.raw('users')), fakeReq({ query: {} }), { column: ['id', 'name'], timestamp: true });
  assert.equal(raw.status, true, raw.message);
  assert.equal(raw.data.length, 1);
});

test('Model.search() groups its ORs: other conditions (soft deletes) still apply', async () => {
  // carol is soft-deleted; without the parentheses `deleted_at is null or name like '%carol%'` matched her
  const deleted = await Users.search(Users.query().whereNull('deleted_at'), 'carol');
  assert.deepEqual(deleted, []);
  const found = await Users.search(Users.query().whereNull('deleted_at'), 'ali');
  assert.deepEqual(found.map((u) => u.name), ['alice']);
  const sql = Users.search(Users.query().where('id', '>', 0), 'x').toKnexQuery().toSQL().sql;
  assert.match(sql, /where `?"?id`?"? > \? and \(/i);
});
