import type { Knex } from 'knex';

/**
 * The application's knex instance, built from config/database.js (or env).
 * A callable proxy: `DB('users')`, `DB.raw()`, `DB.transaction()` and
 * `Model.knex(DB)` forward to the real instance. `DB.ready` is the same
 * promise as getDB().
 */
declare const DB: Knex & { readonly ready: Promise<Knex> };
export default DB;

/** Resolves to the knex instance once config/database.js is loaded. */
export function getDB(): Promise<Knex>;

/** True once the knex instance exists. */
export function isDBReady(): boolean;

/** The resolved knex config (live binding, null until loaded). */
export let databaseConfig: Knex.Config | null;

/** Env-based knex config used when the app has no config/database.js. */
export function envDatabaseConfig(): Knex.Config;

/** SQLite filename resolved against the app root (':memory:', absolute paths and `file:` URIs kept). */
export function sqliteFilename(name?: string | null): string;

export interface MysqlTimezone {
  /** mysql/mysql2 `timezone` option. */
  driver: string;
  /** MySQL session `time_zone`. */
  session: string;
}

/**
 * MySQL time zone from DB_TIMEZONE: unset / 'Z' / 'UTC' → UTC, '+07:00' →
 * that offset, 'local' → null. Throws for anything else.
 */
export function mysqlTimezone(value?: string | null): MysqlTimezone | null;

/** True when the app config imports the root package (which would deadlock a top-level await). */
export function configImportsRoot(file?: string): boolean;
