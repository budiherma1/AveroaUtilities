// Child process entry for test/config-cycle.test.js
const { DB, getDB, Fetch } = await import('../../index.js');
const db = await getDB();
const rows = await DB.raw('select 1 as x');
await Fetch.ready;
console.log(JSON.stringify({
  ok: db === (await DB.ready),
  x: rows[0]?.x,
  isFn: typeof DB === 'function',
  baseURL: Fetch.defaults.baseURL ?? null,
  header: Fetch.defaults.headers?.['x-app-root'] ?? null,
}));
await DB.destroy();
