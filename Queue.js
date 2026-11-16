import { loadAppConfig } from './config.js';

/*
 * One lazily opened AMQP connection + one confirm channel for the whole
 * process. Both are dropped on 'close'/'error' and re-opened on next use.
 *
 * Config: app config/queue.js (optional) `{ amqp, heartbeat }`,
 * otherwise env RABBITMQ_SERVER.
 */

let overrides = {};
let driver = null;
let connectionPromise = null;
let channelPromise = null;
const assertedQueues = new Set();

/**
 * Override queue settings (mostly for tests / custom setups).
 * @param {{ url?: string, heartbeat?: number, driver?: { connect: Function } }} options
 */
export function configureQueue(options = {}) {
  overrides = { ...overrides, ...options };
  if (options.driver) driver = options.driver;
}

async function settings() {
  const cfg = await loadAppConfig('config/queue.js', () => ({}));
  return {
    url: overrides.url ?? cfg.amqp ?? cfg.url ?? process.env.RABBITMQ_SERVER,
    heartbeat: overrides.heartbeat ?? cfg.heartbeat ?? 5,
  };
}

async function getDriver() {
  if (!driver) {
    const mod = await import('amqplib');
    driver = mod.default ?? mod;
  }
  return driver;
}

function resetState() {
  connectionPromise = null;
  channelPromise = null;
  assertedQueues.clear();
}

/** The shared AMQP connection (opened on first use). */
export function getConnection() {
  if (!connectionPromise) {
    const promise = (async () => {
      const { url, heartbeat } = await settings();
      if (!url) {
        throw new Error('Queue: no AMQP server configured (config/queue.js `amqp` or env RABBITMQ_SERVER)');
      }
      const amqp = await getDriver();
      const connection = await amqp.connect(url, { heartbeat });
      const drop = () => {
        if (connectionPromise === promise) resetState();
      };
      connection.on('error', async (err) => {
        drop();
        const { default: Log } = await import('./Log.js');
        Log.error(`Queue connection error: ${err?.message ?? err}`);
      });
      connection.on('close', drop);
      return connection;
    })();
    promise.catch(() => {
      if (connectionPromise === promise) resetState();
    });
    connectionPromise = promise;
  }
  return connectionPromise;
}

/** The shared confirm channel used for publishing. */
export function getChannel() {
  if (!channelPromise) {
    const promise = (async () => {
      const connection = await getConnection();
      const channel = await connection.createConfirmChannel();
      const drop = () => {
        if (channelPromise === promise) {
          channelPromise = null;
          assertedQueues.clear();
        }
      };
      channel.on('error', drop);
      channel.on('close', drop);
      return channel;
    })();
    promise.catch(() => {
      if (channelPromise === promise) channelPromise = null;
    });
    channelPromise = promise;
  }
  return channelPromise;
}

function encode(data) {
  if (Buffer.isBuffer(data)) return { content: data, contentType: undefined };
  if (typeof data === 'string') return { content: Buffer.from(data), contentType: 'text/plain' };
  return { content: Buffer.from(JSON.stringify(data)), contentType: 'application/json' };
}

/**
 * Publish `data` to the durable queue `queue` as a persistent message and
 * wait for the broker confirm.
 * Strings are sent as-is, Buffers raw, anything else as JSON.
 */
export async function publish(queue, data, options = {}) {
  const channel = await getChannel();
  if (!assertedQueues.has(queue)) {
    await channel.assertQueue(queue, { durable: true });
    assertedQueues.add(queue);
  }
  const { content, contentType } = encode(data);
  await new Promise((resolve, reject) => {
    channel.sendToQueue(
      queue,
      content,
      { persistent: true, ...(contentType ? { contentType } : {}), ...options },
      (err) => (err ? reject(err) : resolve()),
    );
  });
  return true;
}

/** Close the shared channel and connection (graceful shutdown, tests). */
export async function closeQueue() {
  const channel = channelPromise;
  const connection = connectionPromise;
  resetState();
  if (channel) {
    try { await (await channel).close(); } catch { /* already closed */ }
  }
  if (connection) {
    try { await (await connection).close(); } catch { /* already closed */ }
  }
}

/** Default export (v1 compatible): `await Queue('queue-name', data)`. */
export default function Queue(queue, data, options) {
  return publish(queue, data, options);
}
