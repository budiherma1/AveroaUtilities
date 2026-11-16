import './setup.js';
import { after } from 'node:test';
import { Model as Objection } from 'objection';
import { DB } from '../index.js';
import { Users, Posts, Tags } from './fixtures/app/app/Models/index.js';

Objection.knex(DB);

// knex keeps a pool open; close it so the test process can exit
after(() => DB.destroy());

export { DB, Users, Posts, Tags };

export async function resetDb() {
  for (const M of [Posts, Users, Tags]) {
    await DB.schema.dropTableIfExists(M.tableName);
    await M.migrationUp(DB);
  }
}

/** Minimal Express-like response. */
export function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
  };
  return res;
}

/** Express-5-like request: `query` is a getter on the prototype. */
export function fakeReq({ query = {}, ...rest } = {}) {
  Object.freeze(query); // any mutation throws (modules are strict)
  const proto = {};
  Object.defineProperty(proto, 'query', { get() { return query; }, configurable: true });
  return Object.assign(Object.create(proto), { params: {}, ...rest });
}
