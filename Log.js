// winston levels:
// error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6
import fs from 'fs';
import winston from 'winston';
import { appPath } from './paths.js';

const level = process.env.LOG_LEVEL || 'info';
const transports = [];

const dir = appPath('storages', 'logs');
try {
  fs.mkdirSync(dir, { recursive: true });
  transports.push(new winston.transports.File({ filename: `${dir}/averoa.log` }));
} catch (e) {
  // Read-only filesystem or missing permissions: fall back to the console only.
  // eslint-disable-next-line no-console
  console.warn(`[averoa] cannot write logs to ${dir}: ${e.message}`);
}

if (process.env.NODE_ENV !== 'production' || transports.length === 0) {
  transports.push(new winston.transports.Console({ format: winston.format.simple() }));
}

const logger = winston.createLogger({
  level,
  format: winston.format.json(),
  transports,
});

export default logger;
