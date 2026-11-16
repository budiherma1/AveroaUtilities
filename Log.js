// winston levels:
// error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6
import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { appPath } from './paths.js';
import { getContext } from './context.js';

/* -------------------------------------------------------------------------- */
/* redaction                                                                  */
/* -------------------------------------------------------------------------- */

export const REDACTED = '[REDACTED]';

/**
 * Keys whose values are replaced by REDACTED, matched case-insensitively
 * after removing everything but letters and digits, so `Authorization`,
 * `x-api-key`, `client_secret`, `refreshToken` and `DB_PASSWORD` all match.
 * A key is sensitive when its normalised form CONTAINS one of these, is
 * `pass`, `pwd`, `jwt`, `otp`, `auth` or `sid`, or ends with `pass` / `pwd`.
 */
export const DEFAULT_REDACT_KEYS = Object.freeze([
  'authorization', 'cookie', 'password', 'passwd', 'passphrase', 'secret', 'token',
  'apikey', 'privatekey', 'credential', 'sessionid', 'csrf',
]);

/** Keys that are sensitive only as a whole word (`pass`, but not `passenger`). */
const EXACT_KEYS = new Set(['pass', 'pwd', 'jwt', 'otp', 'auth', 'sid']);
/** ...or as a suffix (`DB_PASS`, `userPwd`). */
const SUFFIXES = ['pass', 'pwd'];

const MAX_DEPTH = 8;
const normaliseKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

/** `Bearer abc.def` / `Basic dXNlcg==` inside strings. */
const CREDENTIAL_IN_TEXT = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;

const scrubString = (text) => text.replace(CREDENTIAL_IN_TEXT, (_m, scheme) => `${scheme} ${REDACTED}`);

/**
 * Build a key matcher from DEFAULT_REDACT_KEYS plus `extra` (an array or a
 * comma separated string, e.g. env LOG_REDACT=ssn,iban).
 */
export function redactionMatcher(extra = process.env.LOG_REDACT) {
  const list = Array.isArray(extra) ? extra : String(extra ?? '').split(',');
  const parts = [...DEFAULT_REDACT_KEYS, ...list.map(normaliseKey).filter(Boolean)];
  return (key) => {
    const name = normaliseKey(key);
    return EXACT_KEYS.has(name) || SUFFIXES.some((suffix) => name.endsWith(suffix))
      || parts.some((part) => name.includes(part));
  };
}

function redactValue(value, isSensitive, seen, depth) {
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(value);

  let out;
  if (Array.isArray(value)) {
    out = value.map((item) => redactValue(item, isSensitive, seen, depth + 1));
  } else {
    out = {};
    if (value instanceof Error) {
      // own enumerable props are copied below; these are not enumerable
      out.name = value.name;
      out.message = scrubString(String(value.message));
      if (value.stack) out.stack = scrubString(String(value.stack));
    }
    const source = value instanceof Map ? Object.fromEntries(value) : value;
    for (const key of Object.keys(source)) {
      out[key] = isSensitive(key) ? REDACTED : redactValue(source[key], isSensitive, seen, depth + 1);
    }
  }
  seen.delete(value);
  return out;
}

/**
 * A redacted deep copy of `value` (the original is not changed): values of
 * sensitive keys become '[REDACTED]', `Bearer`/`Basic` credentials inside
 * strings are masked, circular references become '[Circular]', Errors become
 * `{ name, message, stack, ...props }`.
 *
 * @param {*} value
 * @param {{ keys?: string[]|string }} [options] extra sensitive keys
 */
export function redact(value, { keys } = {}) {
  return redactValue(value, redactionMatcher(keys), new WeakSet(), 0);
}

/* -------------------------------------------------------------------------- */
/* formats                                                                    */
/* -------------------------------------------------------------------------- */

/** Adds `requestId` (and addLogContext() fields) from the current request context. */
export const contextFormat = winston.format((info) => {
  const store = getContext();
  if (!store) return info;
  if (store.requestId !== undefined && info.requestId === undefined) info.requestId = store.requestId;
  if (store.log) {
    for (const [key, value] of Object.entries(store.log)) {
      if (info[key] === undefined) info[key] = value;
    }
  }
  return info;
});

/** Redacts sensitive fields of the log entry (top level and nested). */
export const redactFormat = winston.format((info, opts = {}) => {
  const isSensitive = opts.matcher ?? redactionMatcher(opts.keys);
  const seen = new WeakSet();
  for (const key of Object.keys(info)) {
    if (key === 'level') continue;
    if (key !== 'message' && key !== 'stack' && isSensitive(key)) {
      info[key] = REDACTED;
    } else {
      info[key] = redactValue(info[key], isSensitive, seen, 0);
    }
  }
  return info;
});

const jsonReplacer = (_key, value) => (typeof value === 'bigint' ? value.toString() : value);

const prettyLine = winston.format.printf((info) => {
  const {
    timestamp, level, message, requestId, stack,
  } = info;
  const rest = {};
  for (const key of Object.keys(info)) {
    if (!['timestamp', 'level', 'message', 'requestId', 'stack'].includes(key)) rest[key] = info[key];
  }
  let text = typeof message === 'string' ? message : JSON.stringify(message, jsonReplacer);
  if (stack) text = String(stack).includes(text) ? stack : `${text}\n${stack}`;
  const meta = Object.keys(rest).length ? ` ${JSON.stringify(rest, jsonReplacer)}` : '';
  return `${timestamp} ${level}${requestId ? ` [${requestId}]` : ''}: ${text}${meta}`;
});

/**
 * The winston format chain of Log's transports: request context → redaction →
 * ISO timestamp → JSON or a readable line. (Errors are expanded to `message`
 * and `stack` by the logger itself, before transports copy the entry.)
 *
 * @param {{ format?: 'json'|'pretty', colors?: boolean, redactKeys?: string[]|string }} [options]
 */
export function logFormat({ format = 'json', colors = false, redactKeys } = {}) {
  const matcher = redactionMatcher(redactKeys);
  const base = [
    contextFormat(),
    redactFormat({ matcher }),
    winston.format.timestamp(),
  ];
  if (format === 'pretty') {
    return winston.format.combine(
      ...base,
      ...(colors ? [winston.format.colorize({ level: true })] : []),
      prettyLine,
    );
  }
  return winston.format.combine(...base, winston.format.json({ replacer: jsonReplacer }));
}

/* -------------------------------------------------------------------------- */
/* logger                                                                     */
/* -------------------------------------------------------------------------- */

const CHANNELS = new Set(['stdout', 'file', 'both']);
const FORMATS = new Set(['json', 'pretty']);
const isDevelopmentEnv = (env) => env === 'development' || env === 'test';

/**
 * Logging settings from the environment.
 *
 * - LOG_LEVEL   winston level (default info)
 * - LOG_FORMAT  json | pretty for console output. Default: pretty when NODE_ENV
 *               is development or test, json otherwise. Files are always JSON.
 * - LOG_CHANNEL stdout | file | both. Unset keeps the 2.0 behaviour: the file,
 *               plus the console unless NODE_ENV=production.
 * - LOG_REDACT  extra sensitive keys, comma separated
 */
export function logSettings(env = process.env) {
  const rawFormat = String(env.LOG_FORMAT ?? '').trim().toLowerCase();
  const rawChannel = String(env.LOG_CHANNEL ?? '').trim().toLowerCase();
  const warnings = [];
  if (rawFormat && !FORMATS.has(rawFormat)) warnings.push(`LOG_FORMAT=${env.LOG_FORMAT} is not json or pretty; using the default`);
  if (rawChannel && !CHANNELS.has(rawChannel)) warnings.push(`LOG_CHANNEL=${env.LOG_CHANNEL} is not stdout, file or both; using the default`);
  return {
    level: env.LOG_LEVEL || 'info',
    format: FORMATS.has(rawFormat) ? rawFormat : (isDevelopmentEnv(env.NODE_ENV) ? 'pretty' : 'json'),
    channel: CHANNELS.has(rawChannel) ? rawChannel : null,
    redactKeys: env.LOG_REDACT,
    production: env.NODE_ENV === 'production',
    warnings,
  };
}

/**
 * Build a logger. Every option defaults to logSettings() (the environment).
 *
 * @param {object}  [options]
 * @param {string}  [options.level]
 * @param {'json'|'pretty'} [options.format]   console format
 * @param {'stdout'|'file'|'both'|null} [options.channel] null = 2.0 behaviour
 * @param {string}  [options.dir]      log directory (default <app>/storages/logs)
 * @param {string}  [options.filename] file name inside dir (default averoa.log)
 * @param {import('stream').Writable} [options.stream] write console output here instead of stdout (tests)
 * @param {boolean} [options.colors]   colorize the pretty format (default: stdout is a TTY and NO_COLOR is unset)
 * @param {string[]|string} [options.redactKeys] extra sensitive keys
 * @returns {import('winston').Logger}
 */
export function createLogger(options = {}) {
  const settings = logSettings();
  const level = options.level ?? settings.level;
  const format = options.format ?? settings.format;
  const channel = options.channel === undefined ? settings.channel : options.channel;
  const redactKeys = options.redactKeys ?? settings.redactKeys;
  const production = options.production ?? settings.production;
  // eslint-disable-next-line no-console
  if (options.channel === undefined && options.format === undefined) settings.warnings.forEach((w) => console.warn(`[averoa] ${w}`));

  const transports = [];
  const wantsFile = channel !== 'stdout';
  if (wantsFile) {
    const dir = options.dir ?? appPath('storages', 'logs');
    try {
      fs.mkdirSync(dir, { recursive: true });
      transports.push(new winston.transports.File({
        filename: path.join(dir, options.filename ?? 'averoa.log'),
        format: logFormat({ format: 'json', redactKeys }),
      }));
    } catch (e) {
      // Read-only filesystem or missing permissions: fall back to the console only.
      // eslint-disable-next-line no-console
      console.warn(`[averoa] cannot write logs to ${dir}: ${e.message}`);
    }
  }

  const wantsConsole = channel === 'stdout' || channel === 'both'
    || (channel === null && !production)
    || transports.length === 0;
  if (wantsConsole) {
    const colors = options.colors ?? (!options.stream && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
    const consoleFormat = logFormat({ format, colors, redactKeys });
    transports.push(options.stream
      ? new winston.transports.Stream({ stream: options.stream, format: consoleFormat })
      : new winston.transports.Console({ format: consoleFormat }));
  }

  return winston.createLogger({ level, format: winston.format.errors({ stack: true }), transports });
}

const logger = createLogger();

export default logger;
