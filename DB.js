import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import knex from 'knex';
import { loadAppConfig } from './config.js';
import { appHas, appPath } from './paths.js';

const SQLITE_CLIENTS = new Set(['sqlite3', 'better-sqlite3']);

/**
 * Resolve a SQLite filename the same way @averoa/core's knexfile does: relative
 * paths are relative to the app root (not the process cwd), so the app and the
 * migrate/seed scripts always open the same file. ':memory:', absolute paths
 * and `file:` URIs are kept as they are.
 */
export function sqliteFilename(name) {
  if (!name || name === ':memory:' || name.startsWith('file:') || path.isAbsolute(name)) {
    return name || ':memory:';
  }
  return appPath(name);
}

/**
 * Env-based configuration used when the app has no config/database.js.
 * SQLite clients get `{ filename: DB_NAME || ':memory:' }` (relative names resolved
 * against the app root) and `useNullAsDefault`.
 */
export function envDatabaseConfig() {
  const client = process.env.DB_CLIENT || 'mysql2';
  if (SQLITE_CLIENTS.has(client)) {
    return {
      client,
      connection: { filename: sqliteFilename(process.env.DB_NAME) },
      useNullAsDefault: true,
    };
  }
  return {
    client,
    connection: {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
    },
  };
}

const DRIVERS = {
  mysql: 'mysql', mysql2: 'mysql2', pg: 'pg', postgres: 'pg', postgresql: 'pg', sqlite3: 'sqlite3', 'better-sqlite3': 'better-sqlite3', tedious: 'tedious', mssql: 'tedious', oracledb: 'oracledb',
};

function driverMissing(client) {
  const driver = typeof client === 'string' ? DRIVERS[client] : null;
  if (!driver) return false;
  try {
    createRequire(import.meta.url).resolve(driver);
    return false;
  } catch {
    return driver;
  }
}

function build(config) {
  // Keep the module importable when the driver (mysql2, pg, ...) is not
  // installed: return a connection-less query builder, so queries fail with
  // a clear message instead of the whole app crashing at import time.
  const missing = config?.connection ? driverMissing(config.client) : false;
  if (missing) {
    // eslint-disable-next-line no-console
    console.warn(`[averoa] database driver "${missing}" is not installed (npm i ${missing}); DB has no connection`);
    return knex({ client: config.client });
  }
  return knex(config);
}

/*
 * Loading config/database.js
 * --------------------------
 * v2.0.0 awaited the config at module top level. When the config file (or
 * anything it imports) imports the root `@averoa/utilities` package, that
 * top-level await waits on itself: Node exits with code 13 and no message.
 *
 * Now:
 *  - no config file → DB is built synchronously from env;
 *  - config file that imports the root package → loaded lazily (no wait at
 *    import time, a warning recommends `@averoa/utilities/paths`);
 *  - any other config file → awaited at import time as before, but only for
 *    CONFIG_WAIT_MS; if it hasn't loaded by then (e.g. an indirect import
 *    cycle) loading continues in the background instead of hanging.
 * DB is a proxy that forwards to the knex instance once it exists. Code that
 * may run before that should `await getDB()` or `await DB.ready`.
 */
const CONFIG_FILE = 'config/database.js';
const CONFIG_WAIT_MS = Number(process.env.AVEROA_CONFIG_WAIT_MS) || 2000;
const ROOT_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]@averoa\/utilities(?:\/index(?:\.js)?)?['"]/;

let instance = null;
let loadError = null;

/** The resolved knex config (null until loaded). */
// eslint-disable-next-line import/no-mutable-exports
export let databaseConfig = null;

function setInstance(config) {
  databaseConfig = config;
  instance = build(config);
  return instance;
}

function warn(message) {
  // eslint-disable-next-line no-console
  console.warn(`[averoa] ${message}`);
}

/** True when the app config imports the root package (which would deadlock a top-level await). */
export function configImportsRoot(file = appPath(CONFIG_FILE)) {
  try {
    return ROOT_IMPORT.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

let ready;
if (!appHas(CONFIG_FILE)) {
  ready = Promise.resolve(setInstance(envDatabaseConfig()));
} else {
  ready = loadAppConfig(CONFIG_FILE, envDatabaseConfig).then(setInstance, (e) => {
    loadError = e;
    warn(`cannot load ${CONFIG_FILE}: ${e.message}`);
    throw e;
  });
  ready.catch(() => {}); // surfaced through getDB() / DB usage, not as an unhandled rejection

  if (configImportsRoot()) {
    warn(`${CONFIG_FILE} imports '@averoa/utilities'; import helpers from '@averoa/utilities/paths' instead `
      + '(DB is initialised lazily — use `await getDB()` before the first query at startup)');
  } else {
    let timer;
    await Promise.race([
      ready.catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, CONFIG_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    if (!instance && !loadError) {
      warn(`${CONFIG_FILE} did not load within ${CONFIG_WAIT_MS}ms (import cycle with '@averoa/utilities'?); `
        + 'DB is initialised lazily — use `await getDB()` before the first query');
    }
  }
}

/** Resolves to the knex instance once config/database.js is loaded. */
export function getDB() {
  return ready;
}

/** True once the knex instance exists. */
export function isDBReady() {
  return instance !== null;
}

function current() {
  if (instance) return instance;
  if (loadError) throw loadError;
  throw new Error(`DB is not ready yet (${CONFIG_FILE} is still loading): \`await getDB()\` or \`await DB.ready\` first`);
}

/**
 * The application's knex instance, built from config/database.js (or env).
 * A callable proxy: `DB('users')`, `DB.raw()`, `DB.transaction()`,
 * `Model.knex(DB)` all forward to the real instance.
 */
const DB = new Proxy(function averoaDB() {}, {
  apply(_target, _thisArg, args) {
    return current()(...args);
  },
  get(target, prop) {
    if (prop === 'ready') return ready;
    if (instance) return Reflect.get(instance, prop, instance);
    // not loaded yet: answer harmless probes instead of throwing
    if (typeof prop === 'symbol' || prop === 'then') return undefined;
    if (prop === 'destroy') return (...args) => ready.then((db) => db.destroy(...args));
    if (prop === 'prototype' || prop === 'name' || prop === 'length') return Reflect.get(target, prop);
    return Reflect.get(current(), prop);
  },
  set(_target, prop, value) {
    return Reflect.set(current(), prop, value);
  },
  has(target, prop) {
    if (prop === 'ready' || Reflect.has(target, prop)) return true;
    return instance ? prop in instance : false;
  },
});

export default DB;
