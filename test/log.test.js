import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { setTimeout as sleep } from 'timers/promises';
import winston from 'winston';
import {
  createLogger, logSettings, redact, REDACTED,
  requestContext, runWithContext, getRequestId, addLogContext, getContext,
} from '../index.js';

/** A logger writing console output to memory; `lines()` parses JSON lines. */
function memoryLogger(options = {}) {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk.toString()));
  const logger = createLogger({
    channel: 'stdout', format: 'json', level: 'debug', stream, ...options,
  });
  const text = async () => {
    await sleep(5);
    return chunks.join('');
  };
  const lines = async () => (await text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { logger, text, lines };
}

test('JSON lines carry timestamp, level, message and the requestId of the current context', async () => {
  const { logger, lines } = memoryLogger();
  logger.info('outside');
  runWithContext({ requestId: 'req-1' }, () => logger.warn('inside', { a: 1 }));

  const [outside, inside] = await lines();
  assert.equal(outside.level, 'info');
  assert.equal(outside.message, 'outside');
  assert.match(outside.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal('requestId' in outside, false);

  assert.equal(inside.level, 'warn');
  assert.equal(inside.message, 'inside');
  assert.equal(inside.requestId, 'req-1');
  assert.equal(inside.a, 1);
  assert.ok(inside.timestamp);
});

test('the request id follows async boundaries and concurrent contexts stay isolated', async () => {
  const { logger, lines } = memoryLogger();

  const work = (id) => runWithContext({ requestId: id }, async () => {
    await sleep(Math.random() * 10);
    logger.info('after await', { expected: id });
    await new Promise((resolve) => { setImmediate(resolve); });
    setTimeout(() => logger.info('in timer', { expected: id }), 1);
    await Promise.resolve().then(() => logger.info('in then', { expected: id }));
    await new Promise((resolve) => { process.nextTick(resolve); });
    assert.equal(getRequestId(), id);
    await sleep(5);
  });
  await Promise.all(['a', 'b', 'c', 'd'].map(work));

  const entries = await lines();
  assert.equal(entries.length, 12);
  for (const entry of entries) assert.equal(entry.requestId, entry.expected, entry.message);
  assert.equal(getRequestId(), undefined, 'no context leaks out');
});

test('addLogContext() adds fields to later lines of the same context only', async () => {
  const { logger, lines } = memoryLogger();
  assert.equal(addLogContext({ userId: 1 }), false, 'no-op outside a context');
  await runWithContext({ requestId: 'r' }, async () => {
    logger.info('before');
    assert.equal(addLogContext({ userId: 42 }), true);
    await sleep(1);
    logger.info('after');
    logger.info('explicit wins', { userId: 7 });
  });
  logger.info('outside');
  const [before, after, explicit, outside] = await lines();
  assert.equal(before.userId, undefined);
  assert.equal(after.userId, 42);
  assert.equal(explicit.userId, 7);
  assert.equal(outside.userId, undefined);
});

test('the context storage is shared through a global symbol (core and utilities use the same one)', () => {
  assert.equal(globalThis[Symbol.for('averoa.requestContext')], requestContext);
  requestContext.run({ requestId: 'from-core' }, () => {
    assert.equal(getRequestId(), 'from-core');
    assert.deepEqual(getContext(), { requestId: 'from-core' });
  });
});

test('sensitive fields are redacted at any depth, case-insensitively, without changing the original', async () => {
  const { logger, lines } = memoryLogger();
  const meta = {
    password: 'p',
    user: { email: 'a@b.c', Password: 'p2', profile: { apiKey: 'k', name: 'Ada' } },
    headers: {
      Authorization: 'Bearer abcdefgh', cookie: 'sid=1', 'x-api-key': 'k', 'user-agent': 'curl',
    },
    body: { refresh_token: 'r', client_secret: 's', _csrf: 'c', items: [{ token: 't', id: 1 }] },
    DB_PASS: 'x',
    passenger: 'kept',
  };
  const copy = structuredClone(meta);
  logger.info('login', meta);
  const [entry] = await lines();

  assert.equal(entry.password, REDACTED);
  assert.equal(entry.user.Password, REDACTED);
  assert.equal(entry.user.profile.apiKey, REDACTED);
  assert.equal(entry.user.profile.name, 'Ada');
  assert.equal(entry.user.email, 'a@b.c');
  assert.equal(entry.headers.Authorization, REDACTED);
  assert.equal(entry.headers.cookie, REDACTED);
  assert.equal(entry.headers['x-api-key'], REDACTED);
  assert.equal(entry.headers['user-agent'], 'curl');
  assert.equal(entry.body.refresh_token, REDACTED);
  assert.equal(entry.body.client_secret, REDACTED);
  assert.equal(entry.body._csrf, REDACTED);
  assert.deepEqual(entry.body.items, [{ token: REDACTED, id: 1 }]);
  assert.equal(entry.DB_PASS, REDACTED);
  assert.equal(entry.passenger, 'kept');
  assert.deepEqual(meta, copy, 'the logged object is not modified');
});

test('Bearer/Basic credentials inside strings are masked; Errors keep message and stack', async () => {
  const { logger, lines } = memoryLogger();
  logger.info('calling upstream with Authorization: Bearer eyJhbGciOi.abc.def');
  logger.error(new Error('failed with basic dXNlcjpwYXNz'));
  logger.info('nested', { err: new Error('inner') });
  const [msg, err, nested] = await lines();
  assert.equal(msg.message, `calling upstream with Authorization: Bearer ${REDACTED}`);
  assert.equal(err.message, `failed with basic ${REDACTED}`);
  assert.match(err.stack, /^Error: failed with basic \[REDACTED\]\n\s+at /);
  assert.equal(nested.err.message, 'inner');
  assert.match(nested.err.stack, /Error: inner/);
});

test('extra keys from LOG_REDACT / redactKeys; circular references are safe', async () => {
  const { logger, lines } = memoryLogger({ redactKeys: 'ssn, iban' });
  const circular = { name: 'loop', SSN: '123' };
  circular.self = circular;
  logger.info('custom', { circular, iban: 'DE00', other: 1 });
  const [entry] = await lines();
  assert.equal(entry.iban, REDACTED);
  assert.equal(entry.circular.SSN, REDACTED);
  assert.equal(entry.circular.self, '[Circular]');
  assert.equal(entry.other, 1);

  assert.deepEqual(redact({ a: { ssn: 1, b: [1, { password: 2 }] } }, { keys: ['ssn'] }), { a: { ssn: REDACTED, b: [1, { password: REDACTED }] } });
});

test('pretty format: one readable line with the request id', async () => {
  const { logger, text } = memoryLogger({ format: 'pretty', colors: false });
  runWithContext({ requestId: 'pretty-1' }, () => logger.info('hello', { token: 't', n: 1 }));
  const line = (await text()).trim();
  assert.match(line, /^\d{4}-\d{2}-\d{2}T\S+Z info \[pretty-1\]: hello \{"token":"\[REDACTED\]","n":1\}$/);
});

test('logSettings(): LOG_FORMAT defaults to json outside development/test; invalid values warn', () => {
  assert.equal(logSettings({ NODE_ENV: 'production' }).format, 'json');
  assert.equal(logSettings({ NODE_ENV: 'staging' }).format, 'json');
  assert.equal(logSettings({}).format, 'json');
  assert.equal(logSettings({ NODE_ENV: 'development' }).format, 'pretty');
  assert.equal(logSettings({ NODE_ENV: 'test' }).format, 'pretty');
  assert.equal(logSettings({ NODE_ENV: 'production', LOG_FORMAT: 'Pretty' }).format, 'pretty');
  assert.equal(logSettings({ NODE_ENV: 'development', LOG_FORMAT: 'json' }).format, 'json');

  assert.equal(logSettings({}).channel, null);
  assert.equal(logSettings({ LOG_CHANNEL: 'STDOUT' }).channel, 'stdout');
  const bad = logSettings({ LOG_CHANNEL: 'syslog', LOG_FORMAT: 'xml' });
  assert.equal(bad.channel, null);
  assert.equal(bad.warnings.length, 2);
});

const transportKinds = (logger) => logger.transports.map((t) => (t instanceof winston.transports.File ? 'file' : 'console'));

test('LOG_CHANNEL: stdout (no file), file (JSON lines), both, and the 2.0 default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'averoa-log-'));
  try {
    const stdoutDir = path.join(dir, 'never-created');
    assert.deepEqual(transportKinds(createLogger({ channel: 'stdout', dir: stdoutDir })), ['console']);
    assert.equal(fs.existsSync(stdoutDir), false, 'stdout does not create the log directory');

    const fileLogger = createLogger({
      channel: 'file', dir, format: 'pretty', level: 'info',
    });
    assert.deepEqual(transportKinds(fileLogger), ['file']);
    await runWithContext({ requestId: 'file-1' }, async () => {
      fileLogger.info('to file', { secret: 's' });
    });
    const file = path.join(dir, 'averoa.log');
    for (let i = 0; i < 100 && !(fs.existsSync(file) && fs.readFileSync(file, 'utf8').endsWith('\n')); i += 1) {
      await sleep(10);
    }
    fileLogger.close();
    const [line] = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(line.message, 'to file');
    assert.equal(line.requestId, 'file-1');
    assert.equal(line.secret, REDACTED);
    assert.ok(line.timestamp, 'files are JSON even when LOG_FORMAT=pretty');

    assert.deepEqual(transportKinds(createLogger({ channel: 'both', dir, production: true })), ['file', 'console']);
    assert.deepEqual(transportKinds(createLogger({ channel: null, dir, production: true })), ['file']);
    assert.deepEqual(transportKinds(createLogger({ channel: null, dir, production: false })), ['file', 'console']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unwritable log directory falls back to the console', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'averoa-log-'));
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const { warn } = console;
  const warnings = [];
  console.warn = (m) => warnings.push(m);
  try {
    const logger = createLogger({ channel: 'file', dir: path.join(blocker, 'logs') });
    assert.deepEqual(transportKinds(logger), ['console']);
    assert.match(warnings[0], /cannot write logs/);
  } finally {
    console.warn = warn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('secrets inside strings: URL passwords, query parameters and JSON text', () => {
  const out = redact({
    config: { data: '{"password":"hunter2","user":"ada"}', url: 'https://api.example.com/v1?api_key=SECRETQ&page=2' },
    link: '/reset?token=abc123&x=1',
    dsn: 'postgres://app:pa55word@db.internal/app',
    awsAccessKeyId: 'AKIAEXAMPLE',
    tags: new Set(['a', 'Bearer abcdefghij']),
    harmless: 'monkey=1&keyboard=2&page=3',
  });
  assert.equal(out.config.data, '{"password":"[REDACTED]","user":"ada"}');
  assert.equal(out.config.url, 'https://api.example.com/v1?api_key=[REDACTED]&page=2');
  assert.equal(out.link, '/reset?token=[REDACTED]&x=1');
  assert.equal(out.dsn, 'postgres://app:[REDACTED]@db.internal/app');
  assert.equal(out.awsAccessKeyId, '[REDACTED]');
  assert.deepEqual(out.tags, ['a', 'Bearer [REDACTED]']);
  assert.equal(out.harmless, 'monkey=1&keyboard=2&page=3');
});
