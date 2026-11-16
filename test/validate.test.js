import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  validate, describeValidation, isStandardSchema, VALIDATE,
} from '../index.js';

/** Minimal Express-like response with json(). */
function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

/** Run a middleware; resolves { req, res, nextCalled }. */
async function run(mw, req) {
  const res = fakeRes();
  let nextCalled = false;
  let nextArg;
  await mw(req, res, (err) => { nextCalled = true; nextArg = err; });
  return {
    req, res, nextCalled, nextArg,
  };
}

const isEmail = { run: (v) => v.validator.isEmail(v.value), msg: 'email format required' };

test('built-in format: required fields fail with the Model.validationRouter shape', async () => {
  const mw = validate({ body: { email: { type: 'string', validation: [isEmail] }, password: { type: 'string' } } });
  const { res, nextCalled } = await run(mw, { body: { password: 'x' } });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, { status: false, data: { column: 'email', message: 'required', in: 'body' } });
});

test('built-in format: rule messages are collected per column', async () => {
  const mw = validate({
    body: {
      email: {
        validation: [isEmail, { run: (v) => v.validator.isLength(v.value, { max: 5 }), msg: 'too long' }],
      },
    },
  });
  const { res } = await run(mw, { body: { email: 'not-an-email' } });
  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body.data, { column: 'email', message: ['email format required', 'too long'], in: 'body' });
});

test('built-in format: success strips unknown keys, replaces req.body, keeps the raw body', async () => {
  const mw = validate({ body: { email: { validation: [isEmail] }, remember: { type: 'boolean', required: false } } });
  const body = { email: 'a@b.io', remember: 'true', isAdmin: true };
  const { req, nextCalled } = await run(mw, { body });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.body, { email: 'a@b.io', remember: true });
  assert.deepEqual(req.validated.body, { email: 'a@b.io', remember: true });
  assert.equal(req.bodyRaw, body);
});

test('built-in format: query values are coerced and exposed on req.validated.query', async () => {
  const mw = validate({
    query: {
      page: { type: 'integer', default: 1, validation: [{ run: (v) => v.raw >= 1, msg: 'must be >= 1' }] },
      q: { type: 'string', required: false },
      sort: { enum: ['asc', 'desc'], default: 'asc' },
    },
  });
  const query = Object.freeze({ page: '3', extra: 'x' });
  const req = { get query() { return query; } }; // Express 5: req.query is a getter
  const { nextCalled } = await run(mw, req);
  assert.equal(nextCalled, true);
  assert.deepEqual(req.validated.query, { page: 3, sort: 'asc' });
  assert.equal(req.query, query, 'req.query is not replaced');

  const bad = await run(mw, { query: { page: 'abc' } });
  assert.deepEqual(bad.res.body.data, { column: 'page', message: ['must be an integer'], in: 'query' });
  const zero = await run(mw, { query: { page: '0' } });
  assert.deepEqual(zero.res.body.data.message, ['must be >= 1']);
  const sort = await run(mw, { query: { sort: 'up' } });
  assert.deepEqual(sort.res.body.data.message, ['must be one of asc, desc']);
});

test('built-in format: headers are case-insensitive; params; flag.required like Model columns', async () => {
  const mw = validate({
    headers: { 'X-Api-Version': { type: 'integer' } },
    params: { id: { type: 'integer' }, slug: { flag: { required: false } } },
  });
  const ok = await run(mw, { headers: { 'x-api-version': '2' }, params: { id: '7' } });
  assert.equal(ok.nextCalled, true);
  assert.deepEqual(ok.req.validated, { params: { id: 7 }, headers: { 'X-Api-Version': 2 } });
  assert.equal(ok.req.body, undefined, 'req.body untouched without a body schema');

  const missing = await run(mw, { headers: {}, params: { id: '7' } });
  assert.deepEqual(missing.res.body.data, { column: 'X-Api-Version', message: 'required', in: 'headers' });
});

test('built-in format: optional empty values skip the rules; objects need type object', async () => {
  const mw = validate({ body: { note: { required: false, validation: [{ run: () => false, msg: 'never' }] }, meta: { type: 'object', required: false } } });
  const ok = await run(mw, { body: { note: '' } });
  assert.equal(ok.nextCalled, true);
  assert.deepEqual(ok.req.body, { note: '' });
  const bad = await run(mw, { body: { meta: 'x' } });
  assert.deepEqual(bad.res.body.data.message, ['must be an object']);
  const nonScalar = await run(validate({ body: { name: { type: 'string' } } }), { body: { name: { a: 1 } } });
  assert.deepEqual(nonScalar.res.body.data.message, ['must be a string']);
});

test('built-in format: async rules and a custom status', async () => {
  const mw = validate({ body: { code: { validation: [{ run: async (v) => v.value === 'ok', msg: 'bad code' }] } } }, { status: 400 });
  const bad = await run(mw, { body: { code: 'no' } });
  assert.equal(bad.res.statusCode, 400);
  assert.equal((await run(mw, { body: { code: 'ok' } })).nextCalled, true);
});

test('validate() rejects invalid definitions at route definition time', () => {
  assert.throws(() => validate({ cookies: {} }), /unknown section "cookies"/);
  assert.throws(() => validate({ body: 'x' }), /Standard Schema/);
  assert.throws(() => validate({ body: { a: { type: 'date' } } }), /unknown type "date"/);
  assert.throws(() => validate({ body: { a: { validation: {} } } }), /must be an array/);
  assert.throws(() => validate({ body: { a: 'string' } }), /must be an object/);
});

test('Standard Schema (zod): parsed output replaces req.body; issues give a 422', async () => {
  const mw = validate({
    body: z.object({ email: z.string().email(), age: z.coerce.number().int().min(18) }),
    query: z.object({ page: z.coerce.number().int().default(1) }),
  });
  const ok = await run(mw, { body: { email: 'a@b.io', age: '21', extra: 1 }, query: {} });
  assert.equal(ok.nextCalled, true);
  assert.deepEqual(ok.req.body, { email: 'a@b.io', age: 21 });
  assert.deepEqual(ok.req.validated.query, { page: 1 });

  const bad = await run(mw, { body: { email: 'nope', age: 21 }, query: {} });
  assert.equal(bad.res.statusCode, 422);
  assert.equal(bad.res.body.status, false);
  assert.equal(bad.res.body.data.column, 'email');
  assert.equal(bad.res.body.data.in, 'body');
  assert.ok(Array.isArray(bad.res.body.data.message) && bad.res.body.data.message.length === 1);

  const nested = await run(validate({ body: z.object({ user: z.object({ name: z.string() }) }) }), { body: { user: {} } });
  assert.equal(nested.res.body.data.column, 'user.name');

  const root = await run(validate({ body: z.string() }), { body: {} });
  assert.equal(root.res.body.data.column, null);
});

test('Standard Schema: async validators and non-zod implementations', async () => {
  const custom = {
    '~standard': {
      version: 1,
      vendor: 'custom',
      validate: async (value) => (value.token === 'ok'
        ? { value: { token: 'ok' } }
        : { issues: [{ message: 'bad token', path: [{ key: 'token' }] }] }),
    },
  };
  assert.equal(isStandardSchema(custom), true);
  const bad = await run(validate({ headers: custom }), { headers: { token: 'no' } });
  assert.deepEqual(bad.res.body.data, { column: 'token', message: ['bad token'], in: 'headers' });
  const ok = await run(validate({ headers: custom }), { headers: { token: 'ok' } });
  assert.deepEqual(ok.req.validated.headers, { token: 'ok' });
});

test('validate() middleware carries its schemas for documentation', () => {
  const mw = validate({
    body: {
      email: { type: 'string', description: 'Login email', example: 'a@b.io' },
      remember: { type: 'boolean', required: false, default: false },
      role: { enum: ['a', 'b'], flag: { required: false } },
    },
    query: z.object({ page: z.number().int().optional() }),
  });
  assert.equal(mw.name, 'validate');
  assert.ok(mw[VALIDATE]);
  const doc = describeValidation(mw);
  assert.deepEqual(doc.body, {
    type: 'object',
    properties: {
      email: { type: 'string', description: 'Login email', examples: ['a@b.io'] },
      remember: { type: 'boolean', default: false },
      role: { enum: ['a', 'b'] },
    },
    required: ['email'],
  });
  assert.equal(doc.query.type, 'object');
  assert.equal(doc.query.properties.page.type, 'integer');
  assert.equal('$schema' in doc.query, false);
  assert.equal(describeValidation(() => {}), null);
});

test('describeValidation leaves out Standard Schemas without JSON Schema support', () => {
  const opaque = { '~standard': { version: 1, vendor: 'x', validate: (v) => ({ value: v }) } };
  assert.deepEqual(describeValidation(validate({ body: opaque })), {});
  const converted = describeValidation(validate({ body: opaque }, { toJSONSchema: () => ({ type: 'object' }) }));
  assert.deepEqual(converted, { body: { type: 'object' } });
  const explicit = describeValidation(validate({ body: opaque }, { jsonSchema: { body: { type: 'object', properties: {} } } }));
  assert.deepEqual(explicit.body, { type: 'object', properties: {} });
  // a converter that throws leaves the section undocumented
  const throwing = describeValidation(validate({ body: opaque }, { toJSONSchema: () => { throw new Error('nope'); } }));
  assert.deepEqual(throwing, {});
});
