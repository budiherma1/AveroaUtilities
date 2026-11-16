import { test } from 'node:test';
import { useDatabaseUrl } from './env.js';

const url = process.env.AVEROA_TEST_MYSQL_URL;
if (!url) {
  test('MySQL integration suite', { skip: 'AVEROA_TEST_MYSQL_URL is not set' }, () => {});
} else {
  useDatabaseUrl(url, 'mysql2');
  const { default: suite } = await import('./suite.js');
  suite('mysql');
}
