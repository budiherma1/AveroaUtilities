import { randomUUID } from 'node:crypto';
import Log from './Log.js';
import { loadAppConfig } from './config.js';
import { getChannel, publish } from './Queue.js';

/*
 * Background jobs on the shared RabbitMQ connection of Queue.js.
 *
 *   class SendReportJob extends Job {
 *     static tries = 3;
 *     static backoff = [1000, 5000, 30000];
 *     async handle(payload) { ... }
 *   }
 *   await SendReportJob.dispatch({ reportId: 1 }, { delay: 60000 });
 *
 * Wire format (JSON, persistent message on a durable queue):
 *   { id, job, payload, attempt, dispatchedAt }
 * `job` is the registered name (`static jobName`, default the class name). A
 * worker only runs classes it was given or found in app/Jobs/index.js and looks
 * them up by that name in a Map: message content never selects a file, a module
 * or code to evaluate.
 *
 * Delays need no broker plugin: a delayed message goes to `<queue>.delay.<ms>`,
 * a durable queue with `x-message-ttl: <ms>` that dead-letters expired messages
 * back to `<queue>` through the default exchange. Every message in such a queue
 * has the same TTL, so the head always expires first. The delay queue deletes
 * itself (`x-expires`) once it has been unused for `<ms>` + 15 minutes.
 */

const JOB_MARK = Symbol.for('averoa.job');
const QUEUE_NAME = /^[A-Za-z0-9_.:-]{1,200}$/;
/** Longest supported delay / backoff: 30 days (x-message-ttl and x-expires must fit 32 bits). */
export const MAX_DELAY = 30 * 24 * 60 * 60 * 1000;
const DELAY_QUEUE_GRACE = 15 * 60 * 1000;
// re-declare a delay queue (renewing its x-expires lease) when this channel last did it longer ago than this
const DELAY_REASSERT_AFTER = 5 * 60 * 1000;

let fake = null;
let defaultQueuePromise = null;

/** Thrown into a job (and passed to `failed()`) when it runs longer than its `timeout`. */
export class JobTimeoutError extends Error {
  constructor(name, ms) {
    super(`Job "${name}" timed out after ${ms} ms`);
    this.name = 'JobTimeoutError';
  }
}

/** Throw unless `name` is a usable queue name (no `amq.` prefix, max 200 safe characters). */
export function validateQueueName(name) {
  if (typeof name !== 'string' || !QUEUE_NAME.test(name) || name.startsWith('amq.')) {
    throw new Error(`Job: invalid queue name "${name}" (letters, digits, _ . : - only, at most 200, not "amq.*")`);
  }
  return name;
}

/** Default job queue: config/queue.js `jobsQueue`, env JOBS_QUEUE, or `jobs`. */
export function defaultJobQueue() {
  defaultQueuePromise ??= loadAppConfig('config/queue.js', () => ({}))
    .then((cfg) => cfg?.jobsQueue || process.env.JOBS_QUEUE || 'jobs')
    .catch((err) => {
      defaultQueuePromise = null;
      throw err;
    });
  return defaultQueuePromise;
}

/** Forget the cached default queue name (tests, or after changing JOBS_QUEUE). */
export function resetJobConfig() {
  defaultQueuePromise = null;
}

/** True for Job subclasses (also across duplicated copies of this package). */
/* eslint-disable no-use-before-define -- Job is declared below; this only runs after the module has loaded */
export function isJobClass(value) {
  return typeof value === 'function' && value !== Job
    && (value.prototype instanceof Job || value[JOB_MARK] === true);
}
/* eslint-enable no-use-before-define */

/** The name a job class is registered and dispatched under. */
export function jobNameOf(JobClass) {
  const name = JobClass.jobName || JobClass.name;
  if (typeof name !== 'string' || name === '') {
    throw new Error('Job: a job class needs a name (give it a class name or `static jobName`)');
  }
  return name;
}

/**
 * Delay in ms from a number of ms or a Date. Rounded up to whole seconds so a
 * handful of delay queues serve every dispatch; 0 = no delay.
 */
export function normaliseDelay(delay) {
  if (delay === undefined || delay === null || delay === 0) return 0;
  const ms = delay instanceof Date ? delay.getTime() - Date.now() : Number(delay);
  if (Number.isNaN(ms) || (!(delay instanceof Date) && (typeof delay !== 'number' || ms < 0))) {
    throw new Error(`Job: invalid delay ${String(delay)} (milliseconds >= 0 or a Date)`);
  }
  if (ms <= 0) return 0; // a Date in the past: run now
  if (ms > MAX_DELAY) throw new Error(`Job: delay ${ms} ms is longer than the maximum of ${MAX_DELAY} ms (30 days)`);
  return Math.ceil(ms / 1000) * 1000;
}

/** `(retry) => ms` doubling from `base` up to `max` (retry 1 waits `base`). */
export function exponentialBackoff(base = 1000, max = 60 * 60 * 1000) {
  return (retry) => Math.min(max, base * 2 ** Math.max(0, retry - 1));
}

/**
 * Wait before retry number `retry` (1 = the first retry).
 * `backoff` is ms, an array of ms (one per retry, the last one repeats) or a
 * function `(retry) => ms`. Anything invalid means no wait.
 */
export function backoffDelay(backoff, retry) {
  let value = backoff;
  if (typeof backoff === 'function') value = backoff(retry);
  else if (Array.isArray(backoff)) value = backoff.length ? backoff[Math.min(retry, backoff.length) - 1] : 0;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(MAX_DELAY, ms);
}

// JSON round trip: what the worker will see (Dates become strings, undefined → null, etc.)
function serialise(payload) {
  const text = JSON.stringify(payload === undefined ? null : payload);
  return text === undefined ? null : JSON.parse(text);
}

const asserted = new WeakMap(); // channel -> Map(queue -> last declare time)

async function declare(channel, queue, options, maxAge = Infinity) {
  let seen = asserted.get(channel);
  if (!seen) {
    seen = new Map();
    asserted.set(channel, seen);
  }
  const last = seen.get(queue);
  if (last !== undefined && Date.now() - last < maxAge) return;
  await channel.assertQueue(queue, options);
  seen.set(queue, Date.now());
}

function sendConfirmed(channel, queue, content, options) {
  return new Promise((resolve, reject) => {
    channel.sendToQueue(queue, content, options, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Publish a job message to `queue`, or to its delay queue when `delay` (ms) > 0.
 * Resolves once the broker has confirmed it.
 */
export async function sendJob(queue, message, delay = 0) {
  const options = { messageId: message.id, type: message.job };
  if (!delay) {
    await publish(queue, message, options);
    return;
  }
  const ms = normaliseDelay(delay);
  const delayQueue = `${queue}.delay.${ms}`;
  const channel = await getChannel();
  // the target must exist before a message dead-letters into it, or the broker drops the message
  await declare(channel, queue, { durable: true });
  await declare(channel, delayQueue, {
    durable: true,
    arguments: {
      'x-message-ttl': ms,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': queue,
      'x-expires': ms + DELAY_QUEUE_GRACE,
    },
  }, DELAY_REASSERT_AFTER);
  await sendConfirmed(channel, delayQueue, Buffer.from(JSON.stringify(message)), {
    persistent: true, contentType: 'application/json', ...options,
  });
}

/** Queue that keeps the record of jobs that failed for good. */
export const failedQueueOf = (queue) => `${queue}.failed`;

/**
 * Run `fn()`; reject with JobTimeoutError (and abort `controller`) after `ms`.
 * The handler is not killed: it keeps running until it honours the signal.
 */
export function runWithTimeout(fn, ms, controller, name) {
  const run = Promise.resolve().then(fn);
  if (!(ms > 0)) return run;
  run.catch(() => {}); // settling after the timeout must not become an unhandled rejection
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new JobTimeoutError(name, ms);
      controller?.abort(err);
      reject(err);
    }, ms);
  });
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

/** Call the optional `failed()` hook; its own errors are logged, never thrown. */
export async function callFailed(instance, payload, error, context) {
  if (typeof instance?.failed !== 'function') return;
  try {
    await instance.failed(payload, error, context);
  } catch (e) {
    Log.error(`Job: ${context?.name ?? 'job'} failed() hook threw: ${e?.message ?? e}`);
  }
}

/**
 * Record `dispatch()` calls instead of publishing them (tests). Returns
 * `{ dispatched, restore() }`; every entry is `{ id, job, payload, queue, delay }`.
 */
export function fakeJobs() {
  const state = {
    dispatched: [],
    restore() {
      if (fake === state) fake = null;
    },
  };
  fake = state;
  return state;
}

/**
 * Base class for background jobs.
 *
 * Static settings (all optional; durations in milliseconds):
 * - `jobName`  registered name (default: the class name); must be unique per worker
 * - `queue`    queue name (default: config/queue.js `jobsQueue`, JOBS_QUEUE or `jobs`)
 * - `tries`    total attempts, including the first (default 1: no retry; at most 100)
 * - `backoff`  wait before a retry: ms, `[ms, ...]` per retry, or `(retry) => ms`
 * - `timeout`  max run time of one attempt; 0 / unset = none
 *
 * `handle(payload, context)` does the work; `failed(payload, error, context)` is
 * called once when the last attempt has failed. `context` is
 * `{ id, name, queue, attempt, tries, signal }` (`signal` aborts on timeout).
 */
export class Job {
  static [JOB_MARK] = true;

  /** @param {any} payload @param {object} context */
  async handle(payload, context) {
    throw new Error(`${this.constructor.name}.handle() is not implemented`);
  }

  /**
   * Queue the job. `payload` must be JSON serialisable.
   * @param {any} [payload]
   * @param {{ delay?: number | Date, queue?: string }} [options] delay in ms or a Date
   * @returns {Promise<{ id: string, job: string, queue: string, delay: number }>}
   */
  static async dispatch(payload, { delay, queue } = {}) {
    const name = jobNameOf(this);
    const target = validateQueueName(queue || this.queue || await defaultJobQueue());
    const ms = normaliseDelay(delay);
    const message = {
      id: randomUUID(), job: name, payload: serialise(payload), attempt: 0, dispatchedAt: new Date().toISOString(),
    };
    if (fake) {
      fake.dispatched.push({
        id: message.id, job: name, payload: message.payload, queue: target, delay: ms,
      });
    } else {
      await sendJob(target, message, ms);
    }
    return {
      id: message.id, job: name, queue: target, delay: ms,
    };
  }

  /**
   * Run the job now, in this process, once (no queue, retries, backoff or
   * timeout). The payload goes through the same JSON round trip as `dispatch()`.
   * On error `failed()` is called and the error is re-thrown. Resolves to the
   * value returned by `handle()`.
   */
  static async dispatchSync(payload) {
    const name = jobNameOf(this);
    const data = serialise(payload);
    const context = {
      id: randomUUID(), name, queue: null, attempt: 1, tries: 1, signal: new AbortController().signal, sync: true,
    };
    const instance = new this();
    try {
      return await instance.handle(data, context);
    } catch (err) {
      await callFailed(instance, data, err, context);
      throw err;
    }
  }
}

export default Job;
