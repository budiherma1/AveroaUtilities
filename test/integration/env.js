// Integration tests against a real MySQL / PostgreSQL server.
//
// Each dialect has its own test file (one process each, because DB is a
// singleton built from the environment when @averoa/utilities is imported):
//   AVEROA_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/averoa_test
//   AVEROA_TEST_PG_URL=postgres://user:pass@127.0.0.1:5432/averoa_test
// Unset → the file reports one skipped test. Use a throwaway database: the
// suite drops and recreates the it_* tables.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Point the package at the integration fixture app (no config/database.js)
 * and describe the server through the DB_* variables, so DB is built by
 * envDatabaseConfig() exactly as in an app without a database config file.
 */
export function useDatabaseUrl(url, client) {
  const u = new URL(url);
  Object.assign(process.env, {
    AVEROA_ROOT: path.join(here, '..', 'fixtures', 'integration-app'),
    LOG_LEVEL: process.env.LOG_LEVEL || 'error',
    DB_CLIENT: client,
    DB_HOST: u.hostname,
    DB_PORT: u.port,
    DB_USER: decodeURIComponent(u.username),
    DB_PASS: decodeURIComponent(u.password),
    DB_NAME: decodeURIComponent(u.pathname.replace(/^\//, '')),
  });
  if (!u.port) delete process.env.DB_PORT;
}
