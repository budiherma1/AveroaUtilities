// Imported first by every test file: points the paths helpers at the fixture app.
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.AVEROA_ROOT = path.join(here, 'fixtures', 'app');
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
