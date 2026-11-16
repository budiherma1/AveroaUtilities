import Log from './Log.js';
import { getConnection, publish } from './Queue.js';
import { importApp } from './paths.js';
import {
  isJobClass, jobNameOf, validateQueueName, defaultJobQueue, sendJob, backoffDelay, failedQueueOf,
  runWithTimeout, callFailed,
} from './Job.js';

/** ack/nack on a channel that may already be closed: log instead of throwing. */
function settle(what, fn) {
  try {
    fn();
  } catch (e) {
    Log.warn(`JobWorker: ${what} failed (the broker will redeliver the message): ${e?.message ?? e}`);
  }
}

/** Upper bound of a job's `tries` (total attempts). */
export const MAX_TRIES = 100;

/**
 * A job name this worker does not know (typically an older worker during a
 * rolling deploy that added the job) is re-published with a growing delay
 * (5 s, 10 s, ... capped at 5 min) up to this many times (about 35 minutes in
 * all), so a newer worker can take it; then it goes to `<queue>.failed`.
 */
export const UNKNOWN_JOB_RETRIES = 10;
const unknownJobDelay = (n) => Math.min(5000 * 2 ** n, 5 * 60 * 1000);

const describe = (err) => ({
  name: err?.name ?? 'Error',
  message: err?.message ?? String(err),
  stack: typeof err?.stack === 'string' ? err.stack.split('\n').slice(0, 15).join('\n') : undefined,
});

/**
 * Registry `name -> class` from an array of job classes, an object of them
 * (e.g. `import * as jobs from '#jobs'`), or, when `jobs` is not given, the
 * Job subclasses exported by the app's `app/Jobs/index.js`. Exports that are
 * not Job subclasses are ignored; two classes with the same name are an error.
 */
export async function loadJobs(jobs) {
  let source = jobs;
  if (source === undefined || source === null) {
    source = await importApp('app/Jobs/index.js', { optional: true }) ?? {};
  }
  const list = Array.isArray(source) ? source : Object.values(source);
  const registry = new Map();
  for (const value of list) {
    if (!isJobClass(value)) {
      if (Array.isArray(source)) throw new Error(`JobWorker: ${value?.name ?? String(value)} is not a Job subclass`);
      continue;
    }
    const name = jobNameOf(value);
    const existing = registry.get(name);
    if (existing && existing !== value) throw new Error(`JobWorker: two job classes are registered as "${name}"`);
    registry.set(name, value);
  }
  return registry;
}

/**
 * Consume job queues and run the jobs.
 *
 * - every message is looked up by its `job` name in the registry (never
 *   imported or evaluated from message content); unknown names and malformed
 *   messages go to the failed queue
 * - success → ack. Failure → re-published with `attempt + 1` after the job's
 *   `backoff` (through a delay queue) while attempts < `tries`; then `failed()`
 *   is called and a record `{ id, job, queue, payload, attempt, failedAt, error }`
 *   is published to `<queue>.failed`
 * - a retry or failed record is published (and confirmed) before the original
 *   message is acked; if that publish fails the message is requeued
 * - `timeout` rejects the attempt with JobTimeoutError and aborts `context.signal`
 * - reconnects with exponential backoff when the channel or connection is lost
 *   (like the mail worker); `stop()` stops consuming and waits for running jobs
 *
 * @param {object} [options]
 * @param {string[]} [options.queues] queues to consume (default: the queues of the registered jobs)
 * @param {Function[]|object} [options.jobs] job classes (default: Job exports of app/Jobs/index.js)
 * @param {number} [options.concurrency=1] jobs run at once per queue (AMQP prefetch)
 * @param {number} [options.prefetch] alias of `concurrency`
 * @param {number} [options.tries] default `tries` for jobs that set none (1)
 * @param {*} [options.backoff] default `backoff` for jobs that set none (0)
 * @param {number} [options.timeout] default `timeout` in ms for jobs that set none (0 = none)
 * @param {number} [options.reconnectDelay=1000]
 * @param {number} [options.maxReconnectDelay=30000]
 */
export async function startJobWorker({
  queues, jobs, concurrency, prefetch, tries, backoff, timeout,
  reconnectDelay = 1000, maxReconnectDelay = 30000,
} = {}) {
  const registry = await loadJobs(jobs);
  if (registry.size === 0) {
    throw new Error('JobWorker: no job classes (pass `jobs`, or export Job subclasses from app/Jobs/index.js)');
  }
  const fallbackQueue = await defaultJobQueue();
  const queueNames = [...new Set(
    (queues?.length ? queues : [...registry.values()].map((J) => J.queue || fallbackQueue))
      .map((q) => validateQueueName(String(q).trim())),
  )];
  const perQueue = Math.max(1, Math.floor(Number(concurrency ?? prefetch ?? 1)) || 1);
  const defaults = { tries, backoff, timeout };

  const inFlight = new Set();
  // handle() promises, kept until they settle: a timed-out job that ignores
  // context.signal keeps running after its message was settled
  const running = new Set();
  const track = (promise) => {
    const tracked = Promise.resolve(promise);
    running.add(tracked);
    tracked.then(() => running.delete(tracked), () => running.delete(tracked));
    return tracked;
  };
  let stopped = false;
  let current = null; // { channel, connection, consumerTags, detach }
  let timer = null;
  let attempt = 0;

  async function recordFailed(queueName, record) {
    await publish(failedQueueOf(queueName), { ...record, queue: queueName, failedAt: new Date().toISOString() });
  }

  async function reject(channel, msg, queueName, message, error, { requeueOnError }) {
    Log.error(`JobWorker: ${error.message} (queue "${queueName}")`);
    try {
      await recordFailed(queueName, {
        id: message?.id ?? msg.properties?.messageId ?? null,
        job: typeof message?.job === 'string' ? message.job : null,
        payload: message && typeof message === 'object' ? (message.payload ?? null) : null,
        raw: message === undefined ? msg.content.toString('base64') : undefined,
        attempt: 0,
        error: describe(error),
      });
      settle('ack', () => channel.ack(msg));
    } catch (e) {
      Log.error(`JobWorker: cannot record the failed message: ${e?.message ?? e}`);
      settle('nack', () => channel.nack(msg, false, requeueOnError));
    }
  }

  async function handle(channel, msg, queueName) {
    let message;
    try {
      message = JSON.parse(msg.content.toString());
    } catch {
      await reject(channel, msg, queueName, undefined, new Error('malformed job message (not JSON)'), { requeueOnError: false });
      return;
    }
    if (!message || typeof message !== 'object' || typeof message.job !== 'string') {
      await reject(channel, msg, queueName, message, new Error('malformed job message (no job name)'), { requeueOnError: false });
      return;
    }
    const JobClass = registry.get(message.job);
    if (!JobClass) {
      const seen = Number.isInteger(message.unknownRetries) && message.unknownRetries >= 0 ? message.unknownRetries : 0;
      if (seen >= UNKNOWN_JOB_RETRIES) {
        await reject(channel, msg, queueName, message, new Error(`unknown job "${message.job}"`), { requeueOnError: true });
        return;
      }
      const wait = unknownJobDelay(seen);
      Log.warn(`JobWorker: unknown job "${message.job}" on "${queueName}" (not registered in this worker); `
        + `re-queued in ${wait} ms for another worker (${seen + 1}/${UNKNOWN_JOB_RETRIES})`);
      try {
        await sendJob(queueName, { ...message, unknownRetries: seen + 1 }, wait);
      } catch (e) {
        Log.error(`JobWorker: cannot re-publish unknown job "${message.job}", requeueing: ${e?.message ?? e}`);
        settle('nack', () => channel.nack(msg, false, true));
        return;
      }
      settle('ack', () => channel.ack(msg));
      return;
    }

    const name = message.job;
    const done = Number.isInteger(message.attempt) && message.attempt >= 0 ? message.attempt : 0;
    const attemptNo = done + 1;
    // capped: tries = Infinity would retry a failing job forever
    const maxTries = Math.min(MAX_TRIES, Math.max(1, Math.floor(Number(JobClass.tries ?? defaults.tries ?? 1)) || 1));
    const ms = Number(JobClass.timeout ?? defaults.timeout ?? 0) || 0;
    const controller = new AbortController();
    const context = {
      id: message.id ?? null, name, queue: queueName, attempt: attemptNo, tries: maxTries, signal: controller.signal,
    };

    let instance;
    let error = null;
    try {
      await runWithTimeout(() => {
        instance = new JobClass();
        return track(instance.handle(message.payload ?? null, context));
      }, ms, controller, name);
    } catch (err) {
      error = err ?? new Error(`job "${name}" failed`);
    }

    if (!error) {
      settle('ack', () => channel.ack(msg));
      return;
    }

    if (attemptNo < maxTries) {
      const wait = backoffDelay(JobClass.backoff ?? defaults.backoff ?? 0, attemptNo);
      Log.warn(`JobWorker: ${name} failed (attempt ${attemptNo}/${maxTries}), retrying in ${wait} ms: ${error.message}`);
      try {
        await sendJob(queueName, { ...message, attempt: attemptNo }, wait);
      } catch (e) {
        Log.error(`JobWorker: cannot re-publish ${name}, requeueing: ${e?.message ?? e}`);
        settle('nack', () => channel.nack(msg, false, true));
        return;
      }
      settle('ack', () => channel.ack(msg));
      return;
    }

    Log.error(`JobWorker: ${name} failed after ${attemptNo} attempt(s): ${error.message}`);
    try {
      await recordFailed(queueName, {
        id: message.id ?? null, job: name, payload: message.payload ?? null, attempt: attemptNo, error: describe(error),
      });
    } catch (e) {
      Log.error(`JobWorker: cannot record failed ${name}, requeueing: ${e?.message ?? e}`);
      settle('nack', () => channel.nack(msg, false, true));
      return;
    }
    settle('ack', () => channel.ack(msg));
    await callFailed(instance ?? Object.create(JobClass.prototype), message.payload ?? null, error, context);
  }

  function lost(state, reason) {
    if (current !== state) return; // an older channel, already replaced
    current = null;
    state.detach();
    if (stopped) return;
    Log.warn(`JobWorker: ${reason}; reconnecting`);
    scheduleReconnect();
  }

  async function setup() {
    const connection = await getConnection();
    const channel = await connection.createChannel();
    const state = {
      channel, connection, consumerTags: [], detach: () => {},
    };

    // Without an 'error' listener an AMQP channel error crashes the process.
    const onChannelError = (err) => Log.error(`JobWorker: channel error: ${err?.message ?? err}`);
    const onChannelClose = () => lost(state, 'channel closed');
    const onConnectionError = (err) => Log.error(`JobWorker: connection error: ${err?.message ?? err}`);
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
      await channel.prefetch(perQueue);
      current = state;
      for (const queueName of queueNames) {
        await channel.assertQueue(queueName, { durable: true });
        const { consumerTag } = await channel.consume(queueName, (msg) => {
          if (!msg) { // consumer cancelled by the broker (queue deleted, failover, ...)
            lost(state, `consumer of "${queueName}" cancelled by the broker`);
            try { channel.close().catch(() => {}); } catch { /* already closed */ }
            return;
          }
          const task = handle(channel, msg, queueName).catch((e) => Log.error(`JobWorker: ${e?.message ?? e}`));
          inFlight.add(task);
          task.finally(() => inFlight.delete(task));
        });
        state.consumerTags.push(consumerTag);
      }
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
        if (!stopped) Log.info(`JobWorker: consuming ${queueNames.join(', ')} again`);
      } catch (e) {
        Log.error(`JobWorker: reconnect failed (next try in ${Math.min(maxReconnectDelay, reconnectDelay * 2 ** attempt)}ms): ${e?.message ?? e}`);
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
  Log.info(`JobWorker: consuming ${queueNames.join(', ')} (${registry.size} job class(es), concurrency ${perQueue})`);

  return {
    queues: queueNames,
    jobs: [...registry.keys()],
    /** Tags of the current consumers (they change after a reconnect). */
    get consumerTags() {
      return [...(current?.consumerTags ?? first.consumerTags)];
    },
    /**
     * Stop consuming and reconnecting, wait for running jobs (also timed-out ones
     * still running), close the channel. With `timeout` (ms) it stops waiting
     * after that long; unfinished messages are then redelivered by the broker.
     * @param {{ timeout?: number }} [options]
     */
    async stop({ timeout: stopTimeout } = {}) {
      if (stopped) return;
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      const state = current;
      current = null;
      if (state) {
        state.detach();
        for (const tag of state.consumerTags) {
          try { await state.channel.cancel(tag); } catch { /* channel gone */ }
        }
      }
      const settled = Promise.allSettled([...inFlight, ...running]);
      if (stopTimeout > 0) {
        let timer2;
        const expired = new Promise((resolve) => { timer2 = setTimeout(() => resolve(true), stopTimeout); });
        if (await Promise.race([settled.then(() => false), expired])) {
          Log.warn(`JobWorker: ${inFlight.size + running.size} job(s) still running after ${stopTimeout} ms; closing anyway`);
        }
        clearTimeout(timer2);
      } else {
        await settled;
      }
      if (state) {
        try { await state.channel.close(); } catch { /* already closed */ }
      }
    },
  };
}

/**
 * Move failed job records from `<queue>.failed` back to `<queue>` with a fresh
 * attempt count. Records without a job name (malformed messages) stay where
 * they are. Resolves to the number of jobs re-queued.
 *
 * @param {{ queue?: string, limit?: number }} [options] queue default: the default job queue
 */
export async function retryFailedJobs({ queue, limit = Infinity } = {}) {
  const queueName = validateQueueName(queue || await defaultJobQueue());
  const failedName = failedQueueOf(queueName);
  const connection = await getConnection();
  const channel = await connection.createChannel();
  channel.on('error', (err) => Log.error(`retryFailedJobs: channel error: ${err?.message ?? err}`));
  const keep = [];
  let moved = 0;
  try {
    await channel.assertQueue(failedName, { durable: true });
    while (moved < limit) {
      const msg = await channel.get(failedName, { noAck: false });
      if (!msg) break;
      let record;
      try {
        record = JSON.parse(msg.content.toString());
      } catch {
        record = null;
      }
      if (!record || typeof record.job !== 'string') {
        keep.push(msg);
        continue;
      }
      await sendJob(queueName, {
        id: record.id,
        job: record.job,
        payload: record.payload ?? null,
        attempt: 0,
        dispatchedAt: new Date().toISOString(),
      });
      channel.ack(msg);
      moved += 1;
    }
  } finally {
    for (const msg of keep) settle('nack', () => channel.nack(msg, false, true));
    try { await channel.close(); } catch { /* already closed */ }
  }
  return moved;
}

export default startJobWorker;
