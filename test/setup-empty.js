// Fixture app with no config/ directory at all.
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.AVEROA_ROOT = path.join(here, 'fixtures', 'empty-app');
process.env.LOG_LEVEL = 'error';
process.env.FETCH_BASE_URL = 'https://api.example.test';
