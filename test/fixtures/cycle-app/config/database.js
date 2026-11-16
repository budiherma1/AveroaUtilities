// No package.json in this fixture on purpose: '@averoa/utilities' then
// self-resolves to this package. Importing the ROOT package from a config
// file used to deadlock DB.js's top-level await (node exit code 13).
import { appPath } from '@averoa/utilities';

export default () => ({
  client: 'better-sqlite3',
  connection: { filename: appPath('storages', 'cycle.sqlite') },
  useNullAsDefault: true,
});
