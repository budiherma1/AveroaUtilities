// Imports the package root through a path the source sniffing in DB.js does
// not recognise: exercises the bounded wait fallback.
import { appRoot } from '../../../../index.js';

export default () => ({
  client: 'better-sqlite3',
  connection: { filename: ':memory:' },
  useNullAsDefault: true,
  root: appRoot(),
});
