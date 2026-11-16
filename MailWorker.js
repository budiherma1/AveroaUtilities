import Log from './Log.js';
import { getConnection, publish } from './Queue.js';
import { defaultMailQueue, getTransporter } from './Mail.js';

const RETRY_HEADER = 'x-averoa-retries';

// Buffers in attachments come back from JSON as { type: 'Buffer', data: [...] }.
function revive(options) {
  if (Array.isArray(options?.attachments)) {
    options.attachments = options.attachments.map((a) => (
      a?.content?.type === 'Buffer' && Array.isArray(a.content.data)
        ? { ...a, content: Buffer.from(a.content.data) }
        : a
    ));
  }
  return options;
}

/** ack/nack on a channel that may already be closed: log instead of throwing. */
function settle(what, fn) {
  try {
    fn();
  } catch (e) {
    Log.warn(`MailWorker: ${what} failed (the broker will redeliver the message): ${e?.message ?? e}`);
  }
}

/**
 * Consume the mail queue and send each message with nodemailer.
 *
 * - ack after a successful send (an ack failure is logged, never turned into
 *   a retry: the mail was sent)
 * - on failure the message is re-published with a retry counter, up to
 *   `maxRetries`; after that it is rejected (nack, no requeue → dead-letter
 *   exchange if the queue has one)
 * - malformed messages are rejected immediately
 * - when the channel or connection closes or errors (broker restart, network
 *   loss, consumer cancelled) the consumer is set up again with exponential
 *   backoff (`reconnectDelay` doubling up to `maxReconnectDelay`); `stop()`
 *   cancels pending reconnects
 *
 * @param {object} [options]
 * @param {string} [options.queue] queue name (default: config/mail.js `queue`, env MAIL_QUEUE, 'mail')
 * @param {number} [options.prefetch=1] unacked messages handled concurrently
 * @param {number} [options.maxRetries=3]
 * @param {object} [options.transporter] nodemailer transporter (default: the shared one)
 * @param {number} [options.reconnectDelay=1000] first reconnect delay in ms
 * @param {number} [options.maxReconnectDelay=30000] reconnect delay cap in ms
 * @returns {Promise<{ queue: string, consumerTag: string, stop: () => Promise<void> }>}
 */
export async function startMailWorker({
  queue, prefetch = 1, maxRetries = 3, transporter, reconnectDelay = 1000, maxReconnectDelay = 30000,
} = {}) {
  const queueName = queue || await defaultMailQueue();
  const mailer = transporter ?? await getTransporter();

  const inFlight = new Set();
  let stopped = false;
  let current = null; // { channel, connection, consumerTag, detach }
  let timer = null;
  let attempt = 0;

  async function handle(channel, msg) {
    let options;
    try {
      options = revive(JSON.parse(msg.content.toString()));
    } catch (e) {
      Log.error(`MailWorker: dropping malformed message on "${queueName}": ${e.message}`);
      settle('nack', () => channel.nack(msg, false, false));
      return;
    }

    let sendError = null;
    try {
      await mailer.sendMail(options);
    } catch (err) {
      sendError = err ?? new Error('sendMail failed');
    }

    if (!sendError) {
      // outside the send try: an ack failure must not re-publish a sent mail
      settle('ack', () => channel.ack(msg));
      return;
    }

    const headers = msg.properties?.headers ?? {};
    const retries = Number(headers[RETRY_HEADER] ?? 0);
    if (retries < maxRetries) {
      Log.warn(`MailWorker: send failed (attempt ${retries + 1}/${maxRetries + 1}), retrying: ${sendError.message}`);
      let republished = false;
      try {
        await publish(queueName, msg.content, {
          contentType: msg.properties?.contentType ?? 'application/json',
          headers: { ...headers, [RETRY_HEADER]: retries + 1 },
        });
        republished = true;
      } catch (e) {
        Log.error(`MailWorker: cannot re-publish, requeueing: ${e.message}`);
      }
      if (republished) settle('ack', () => channel.ack(msg));
      else settle('nack', () => channel.nack(msg, false, true));
    } else {
      Log.error(`MailWorker: giving up after ${retries + 1} attempts: ${sendError.message}`);
      settle('nack', () => channel.nack(msg, false, false));
    }
  }

  function lost(state, reason) {
    if (current !== state) return; // an older channel, already replaced
    current = null;
    state.detach();
    if (stopped) return;
    Log.warn(`MailWorker: ${reason}; reconnecting to "${queueName}"`);
    scheduleReconnect();
  }

  async function setup() {
    const connection = await getConnection();
    const channel = await connection.createChannel();
    const state = {
      channel, connection, consumerTag: null, detach: () => {},
    };

    // Without an 'error' listener an AMQP channel error crashes the process.
    const onChannelError = (err) => Log.error(`MailWorker: channel error: ${err?.message ?? err}`);
    const onChannelClose = () => lost(state, 'channel closed');
    const onConnectionError = (err) => Log.error(`MailWorker: connection error: ${err?.message ?? err}`);
    const onConnectionClose = () => lost(state, 'connection closed');
    channel.on('error', onChannelError);
    channel.on('close', onChannelClose);
    connection.on('error', onConnectionError);
    connection.on('close', onConnectionClose);
    state.detach = () => {
      // keep a no-op 'error' listener on the channel: late errors must not crash
      channel.off('close', onChannelClose);
      connection.off('error', onConnectionError);
      connection.off('close', onConnectionClose);
    };

    try {
      await channel.assertQueue(queueName, { durable: true });
      await channel.prefetch(prefetch);
      current = state;
      const { consumerTag } = await channel.consume(queueName, (msg) => {
        if (!msg) { // consumer cancelled by the broker (queue deleted, failover, ...)
          lost(state, 'consumer cancelled by the broker');
          try { channel.close().catch(() => {}); } catch { /* already closed */ }
          return;
        }
        const task = handle(channel, msg).catch((e) => Log.error(`MailWorker: ${e.message}`));
        inFlight.add(task);
        task.finally(() => inFlight.delete(task));
      });
      state.consumerTag = consumerTag;
    } catch (e) {
      if (current === state) current = null;
      state.detach();
      try { await channel.close(); } catch { /* already closed */ }
      throw e;
    }

    if (stopped) { // stop() was called while we were (re)connecting
      current = null;
      state.detach();
      try { await channel.close(); } catch { /* already closed */ }
      return state;
    }
    attempt = 0;
    return state;
  }

  function scheduleReconnect() {
    if (stopped || timer) return;
    const delay = Math.min(maxReconnectDelay, reconnectDelay * 2 ** attempt);
    attempt += 1;
    timer = setTimeout(async () => {
      timer = null;
      if (stopped) return;
      try {
        await setup();
        if (!stopped) Log.info(`MailWorker: consuming "${queueName}" again`);
      } catch (e) {
        Log.error(`MailWorker: reconnect failed (next try in ${Math.min(maxReconnectDelay, reconnectDelay * 2 ** attempt)}ms): ${e?.message ?? e}`);
        scheduleReconnect();
      }
    }, delay);
  }

  let first;
  try {
    first = await setup();
  } catch (e) {
    // the caller gets no handle to stop() us: no background reconnects
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    throw e;
  }
  Log.info(`MailWorker: consuming "${queueName}"`);

  return {
    queue: queueName,
    /** Tag of the current consumer (changes after a reconnect). */
    get consumerTag() {
      return current?.consumerTag ?? first.consumerTag;
    },
    /** Stop consuming and reconnecting, wait for in-flight sends, close the channel. */
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      const state = current;
      current = null;
      if (state) {
        state.detach();
        try { await state.channel.cancel(state.consumerTag); } catch { /* channel gone */ }
      }
      await Promise.allSettled([...inFlight]);
      if (state) {
        try { await state.channel.close(); } catch { /* already closed */ }
      }
    },
  };
}

export default startMailWorker;
