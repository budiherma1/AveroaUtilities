/**
 * Load an optional app config file (e.g. 'config/database.js'). Its default
 * export may be an object or a function `(process) => object`; `fallback()`
 * is used when the file is missing or exports nothing.
 */
export function loadAppConfig<T = Record<string, unknown>>(relativePath: string, fallback?: () => T): Promise<T>;

/** Normalised SQL dialect ('mysql', 'pg', 'sqlite', or the lower-cased name) of a knex client. */
export function dialectOf(client: unknown): string;

/** Dialect of a knex instance or query builder. */
export function dialectOfKnex(knexLike: unknown): string;
