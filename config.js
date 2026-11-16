import { importAppDefault } from './paths.js';

/**
 * Load an optional app config file (e.g. 'config/database.js').
 *
 * The default export may be a plain object or a function `(process) => object`.
 * Returns `fallback()` when the file does not exist or exports nothing.
 */
export async function loadAppConfig(relativePath, fallback = () => ({})) {
  const exported = await importAppDefault(relativePath, { optional: true });
  if (exported === null || exported === undefined) return fallback();
  const value = typeof exported === 'function' ? exported(process) : exported;
  return value ?? fallback();
}

/** Normalised SQL dialect name for a knex client name. */
export function dialectOf(client) {
  const name = typeof client === 'function' ? (client.prototype?.dialect ?? client.name) : client;
  switch (String(name ?? '').toLowerCase()) {
    case 'mysql':
    case 'mysql2':
      return 'mysql';
    case 'pg':
    case 'postgres':
    case 'postgresql':
    case 'pgnative':
    case 'cockroachdb':
      return 'pg';
    case 'sqlite':
    case 'sqlite3':
    case 'better-sqlite3':
      return 'sqlite';
    default:
      return String(name ?? '').toLowerCase();
  }
}

/** Dialect of a knex instance or knex query builder. */
export function dialectOfKnex(knexLike) {
  const client = knexLike?.client;
  return dialectOf(client?.config?.client ?? client?.dialect);
}
