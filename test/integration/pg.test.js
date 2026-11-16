import { test } from 'node:test';
import { useDatabaseUrl } from './env.js';

const url = process.env.AVEROA_TEST_PG_URL;
if (!url) {
  test('PostgreSQL integration suite', { skip: 'AVEROA_TEST_PG_URL is not set' }, () => {});
} else {
  useDatabaseUrl(url, 'pg');
  const { default: suite } = await import('./suite.js');
  suite('pg');
}
