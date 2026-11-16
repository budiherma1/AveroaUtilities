import './setup.js';
import {
  test, describe, beforeEach, afterEach,
} from 'node:test';
import assert from 'node:assert/strict';
import { configureQueue, closeQueue } from '../Queue.js';
import {
  Job, JobTimeoutError, fakeJobs, exponentialBackoff, backoffDelay, normaliseDelay, validateQueueName,
  resetJobConfig, MAX_DELAY,
} from '../Job.js';
import {
  startJobWorker, retryFailedJobs, loadJobs, UNKNOWN_JOB_RETRIES,
} from '../JobWorker.js';
import {
  createMockAmqp, message, wait, until,
} from './amqp-mock.js';
import { handled, FixtureEchoJob } from './fixtures/app/app/Jobs/index.js';

let amqp;
beforeEach(async () => {
  await closeQueue();
  amqp = createMockAmqp();
  configureQueue({ url: 'amqp://test', driver: amqp });
  delete process.env.JOBS_QUEUE;
  resetJobConfig();
  handled.length = 0;
});

class SendReportJob extends Job {
  static tries = 3;

  static backoff = [1000, 5000];

  async handle(payload) {
    return { ok: payload.id };
  }
}

describe('dispatch', () => {
  test('publishes a persistent JSON message to the default queue', async () => {
    const r = await SendReportJob.dispatch({ id: 7, at: new Date('2026-01-01T00:00:00Z'), skip: undefined });
    assert.equal(r.queue, 'jobs');
    assert.equal(r.job, 'SendReportJob');
    assert.equal(r.delay, 0);
    const [p] = amqp.state.published;
    assert.equal(p.q, 'jobs');
    assert.equal(p.opts.persistent, true);
    assert.equal(p.opts.contentType, 'application/json');
    assert.equal(p.opts.messageId, r.id);
    assert.equal(p.opts.type, 'SendReportJob');
    assert.deepEqual(
      { ...p.body, dispatchedAt: undefined },
      {
        id: r.id, job: 'SendReportJob', payload: { id: 7, at: '2026-01-01T00:00:00.000Z' }, attempt: 0, dispatchedAt: undefined,
      },
    );
    assert.ok(amqp.state.asserted.some((a) => a.q === 'jobs' && a.opts.durable === true && !a.opts.arguments));
  });

  test('queue: option > static queue > JOBS_QUEUE > "jobs"; names are validated', async () => {
    class OnReports extends Job { static queue = 'reports'; }
    process.env.JOBS_QUEUE = 'from-env';
    resetJobConfig();
    assert.equal((await SendReportJob.dispatch(1)).queue, 'from-env');
    assert.equal((await OnReports.dispatch(1)).queue, 'reports');
    assert.equal((await OnReports.dispatch(1, { queue: 'urgent' })).queue, 'urgent');
    await assert.rejects(OnReports.dispatch(1, { queue: 'amq.gen' }), /invalid queue name/);
    await assert.rejects(OnReports.dispatch(1, { queue: 'a b' }), /invalid queue name/);
    assert.throws(() => validateQueueName('x'.repeat(201)), /invalid queue name/);
  });

  test('a payload that cannot be serialised is rejected before publishing', async () => {
    await assert.rejects(SendReportJob.dispatch({ n: 1n }), /BigInt/);
    assert.equal(amqp.state.published.length, 0);
  });

  test('delayed dispatch goes to a TTL queue that dead-letters into the job queue', async () => {
    const r = await SendReportJob.dispatch({ id: 1 }, { delay: 1500 });
    assert.equal(r.delay, 2000, 'rounded up to whole seconds');
    const [p] = amqp.state.published;
    assert.equal(p.q, 'jobs.delay.2000');
    assert.equal(p.opts.persistent, true);
    const target = amqp.state.asserted.findIndex((a) => a.q === 'jobs');
    const delayQ = amqp.state.asserted.findIndex((a) => a.q === 'jobs.delay.2000');
    assert.ok(target !== -1 && target < delayQ, 'the target queue is declared first');
    assert.deepEqual(amqp.state.asserted[delayQ].opts, {
      durable: true,
      arguments: {
        'x-message-ttl': 2000,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': 'jobs',
        'x-expires': 2000 + 15 * 60 * 1000,
      },
    });

    // the declaration is cached per channel
    await SendReportJob.dispatch({ id: 2 }, { delay: 2000 });
    assert.equal(amqp.state.asserted.filter((a) => a.q === 'jobs.delay.2000').length, 1);
  });

  test('delay accepts a Date; invalid delays are rejected', async () => {
    const r = await SendReportJob.dispatch(null, { delay: new Date(Date.now() + 60_000) });
    assert.ok(r.delay === 60_000 || r.delay === 61_000);
    assert.equal(normaliseDelay(new Date(Date.now() - 1000)), 0);
    assert.equal(normaliseDelay(0), 0);
    assert.equal(normaliseDelay(1), 1000);
    for (const bad of [-1, '1000', Number.NaN, MAX_DELAY + 1]) {
      assert.throws(() => normaliseDelay(bad), /delay/);
    }
  });

  test('dispatchSync runs the job now with the serialised payload and returns its result', async () => {
    assert.deepEqual(await SendReportJob.dispatchSync({ id: 3 }), { ok: 3 });
    const seen = [];
    class Echo extends Job {
      async handle(payload, context) { seen.push({ payload, context }); }
    }
    await Echo.dispatchSync({ when: new Date(0), gone: undefined });
    assert.deepEqual(seen[0].payload, { when: '1970-01-01T00:00:00.000Z' });
    assert.equal(seen[0].context.attempt, 1);
    assert.equal(seen[0].context.sync, true);
    assert.equal(amqp.state.connects, 0, 'no broker involved');
  });

  test('dispatchSync calls failed() and re-throws', async () => {
    const failed = [];
    class Boom extends Job {
      async handle() { throw new Error('boom'); }

      async failed(payload, error) { failed.push([payload, error.message]); }
    }
    await assert.rejects(Boom.dispatchSync({ a: 1 }), /boom/);
    assert.deepEqual(failed, [[{ a: 1 }, 'boom']]);
    // a throwing failed() hook does not hide the job error
    class Worse extends Boom {
      async failed() { throw new Error('hook'); }
    }
    await assert.rejects(Worse.dispatchSync(), /boom/);
  });

  test('a job without handle() fails clearly', async () => {
    class Empty extends Job {}
    await assert.rejects(Empty.dispatchSync(), /Empty\.handle\(\) is not implemented/);
  });

  test('fakeJobs() records dispatches instead of publishing', async () => {
    const fake = fakeJobs();
    try {
      await SendReportJob.dispatch({ id: 9 }, { delay: 5000, queue: 'q1' });
      assert.deepEqual(fake.dispatched.map(({ id, ...rest }) => rest), [
        {
          job: 'SendReportJob', payload: { id: 9 }, queue: 'q1', delay: 5000,
        },
      ]);
      assert.equal(amqp.state.published.length, 0);
    } finally {
      fake.restore();
    }
    await SendReportJob.dispatch({ id: 10 });
    assert.equal(amqp.state.published.length, 1);
  });
});

describe('backoff', () => {
  test('fixed, per-retry array (last repeats), function and exponential', () => {
    assert.equal(backoffDelay(500, 1), 500);
    assert.equal(backoffDelay(500, 4), 500);
    assert.equal(backoffDelay([100, 200], 1), 100);
    assert.equal(backoffDelay([100, 200], 2), 200);
    assert.equal(backoffDelay([100, 200], 5), 200);
    assert.equal(backoffDelay((n) => n * 10, 3), 30);
    assert.equal(backoffDelay(undefined, 1), 0);
    assert.equal(backoffDelay(-5, 1), 0);
    assert.equal(backoffDelay([], 1), 0);
    const exp = exponentialBackoff(1000, 5000);
    assert.deepEqual([1, 2, 3, 4].map(exp), [1000, 2000, 4000, 5000]);
  });
});

describe('startJobWorker', () => {
  let worker;
  afterEach(async () => {
    await worker?.stop();
    worker = null;
  });

  const consumerOf = (q) => amqp.state.consumers.findLast((c) => c.q === q).fn;

  test('discovers Job subclasses in app/Jobs/index.js and consumes their queues', async () => {
    worker = await startJobWorker({ concurrency: 4 });
    assert.deepEqual(worker.jobs.sort(), ['FixtureEchoJob', 'reports.build']);
    assert.deepEqual(worker.queues.sort(), ['jobs', 'reports']);
    assert.equal(amqp.state.channels[0].prefetchCount, 4);

    const msg = message({
      id: 'a', job: 'FixtureEchoJob', payload: { x: 1 }, attempt: 0,
    });
    consumerOf('jobs')(msg);
    await until(() => amqp.state.acks.includes(msg));
    assert.deepEqual(handled, [{ payload: { x: 1 }, attempt: 1 }]);
  });

  test('loadJobs rejects duplicate names and non-job classes', async () => {
    class A extends Job { static jobName = 'same'; }
    class B extends Job { static jobName = 'same'; }
    await assert.rejects(loadJobs([A, B]), /two job classes are registered as "same"/);
    await assert.rejects(loadJobs([class NotAJob {}]), /not a Job subclass/);
    assert.deepEqual([...(await loadJobs({ A, other: 1 })).keys()], ['same']);
    await assert.rejects(startJobWorker({ jobs: [] }), /no job classes/);
  });

  test('a failing job is retried with backoff through the delay queue, then failed() and the failed queue', async () => {
    const calls = [];
    const failedHook = [];
    class Flaky extends Job {
      static tries = 3;

      static backoff = [1000, 5000];

      async handle(payload, context) {
        calls.push(context.attempt);
        throw new Error(`nope ${context.attempt}`);
      }

      async failed(payload, error, context) {
        failedHook.push({ payload, message: error.message, attempt: context.attempt });
      }
    }
    worker = await startJobWorker({ jobs: [Flaky] });
    const fn = consumerOf('jobs');

    const m1 = message({
      id: 'id-1', job: 'Flaky', payload: { n: 1 }, attempt: 0,
    });
    fn(m1);
    await until(() => amqp.state.acks.includes(m1));
    let p = amqp.state.published.at(-1);
    assert.equal(p.q, 'jobs.delay.1000');
    assert.deepEqual(p.body, {
      id: 'id-1', job: 'Flaky', payload: { n: 1 }, attempt: 1,
    });

    const m2 = message(p.body);
    fn(m2);
    await until(() => amqp.state.acks.includes(m2));
    p = amqp.state.published.at(-1);
    assert.equal(p.q, 'jobs.delay.5000');
    assert.equal(p.body.attempt, 2);

    const m3 = message(p.body);
    fn(m3);
    await until(() => amqp.state.acks.includes(m3) && failedHook.length === 1);
    p = amqp.state.published.at(-1);
    assert.equal(p.q, 'jobs.failed');
    assert.equal(p.body.job, 'Flaky');
    assert.equal(p.body.id, 'id-1');
    assert.equal(p.body.queue, 'jobs');
    assert.equal(p.body.attempt, 3);
    assert.deepEqual(p.body.payload, { n: 1 });
    assert.equal(p.body.error.message, 'nope 3');
    assert.ok(p.body.failedAt);
    assert.deepEqual(calls, [1, 2, 3]);
    assert.deepEqual(failedHook, [{ payload: { n: 1 }, message: 'nope 3', attempt: 3 }]);
    assert.equal(amqp.state.nacks.length, 0);
  });

  test('worker defaults apply to jobs that set no tries/backoff; a 0 backoff retries on the queue itself', async () => {
    class Once extends Job {
      async handle() { throw new Error('x'); }
    }
    worker = await startJobWorker({ jobs: [Once], tries: 2 });
    const m = message({ id: 'i', job: 'Once', payload: null });
    consumerOf('jobs')(m);
    await until(() => amqp.state.acks.includes(m));
    assert.equal(amqp.state.published.at(-1).q, 'jobs');
    assert.equal(amqp.state.published.at(-1).body.attempt, 1);
  });

  test('if the retry cannot be published the message is requeued, not lost', async () => {
    class Flaky extends Job {
      static tries = 2;

      async handle() { throw new Error('x'); }
    }
    worker = await startJobWorker({ jobs: [Flaky] });
    amqp.state.failPublish = 1;
    const m = message({ id: 'i', job: 'Flaky', payload: null });
    consumerOf('jobs')(m);
    await until(() => amqp.state.nacks.length === 1);
    assert.deepEqual(amqp.state.nacks[0], { msg: m, requeue: true });
    assert.ok(!amqp.state.acks.includes(m));
  });

  test('timeout fails the attempt with JobTimeoutError and aborts the signal', async () => {
    let signal;
    const errors = [];
    class Slow extends Job {
      static timeout = 30;

      async handle(payload, context) {
        ({ signal } = context);
        await new Promise((resolve) => { context.signal.addEventListener('abort', resolve); });
      }

      async failed(payload, error) { errors.push(error); }
    }
    worker = await startJobWorker({ jobs: [Slow] });
    const m = message({ id: 'i', job: 'Slow', payload: null });
    consumerOf('jobs')(m);
    await until(() => errors.length === 1);
    assert.ok(errors[0] instanceof JobTimeoutError);
    assert.equal(signal.aborted, true);
    assert.match(amqp.state.published.at(-1).body.error.message, /timed out after 30 ms/);
  });

  test('an unknown job is re-queued with a growing delay for another worker (rolling deploys)', async () => {
    worker = await startJobWorker({ jobs: [FixtureEchoJob] });
    const fn = consumerOf('jobs');
    const first = message({ id: 'n', job: 'AddedInTheNextRelease', payload: { a: 1 } });
    fn(first);
    await until(() => amqp.state.acks.includes(first));
    let p = amqp.state.published.at(-1);
    assert.equal(p.q, 'jobs.delay.5000');
    assert.deepEqual({ job: p.body.job, payload: p.body.payload, unknownRetries: p.body.unknownRetries },
      { job: 'AddedInTheNextRelease', payload: { a: 1 }, unknownRetries: 1 });

    const third = message({ id: 'n', job: 'AddedInTheNextRelease', payload: null, unknownRetries: 2 });
    fn(third);
    await until(() => amqp.state.acks.includes(third));
    p = amqp.state.published.at(-1);
    assert.equal(p.q, 'jobs.delay.20000');
    assert.equal(p.body.unknownRetries, 3);
    assert.equal(handled.length, 0);
  });

  test('unknown job names (after the retries) and malformed messages go to the failed queue', async () => {
    worker = await startJobWorker({ jobs: [FixtureEchoJob] });
    const fn = consumerOf('jobs');
    const unknown = message({ id: 'u', job: '../../etc/passwd', payload: { a: 1 }, unknownRetries: UNKNOWN_JOB_RETRIES });
    fn(unknown);
    await until(() => amqp.state.acks.includes(unknown));
    let p = amqp.state.published.at(-1);
    assert.equal(p.q, 'jobs.failed');
    assert.equal(p.body.job, '../../etc/passwd');
    assert.match(p.body.error.message, /unknown job/);

    const proto = message({ id: 'p', job: 'constructor', payload: null, unknownRetries: UNKNOWN_JOB_RETRIES });
    fn(proto);
    await until(() => amqp.state.acks.includes(proto));
    assert.match(amqp.state.published.at(-1).body.error.message, /unknown job "constructor"/);

    const junk = message('not json');
    fn(junk);
    await until(() => amqp.state.acks.includes(junk));
    p = amqp.state.published.at(-1);
    assert.equal(p.body.job, null);
    assert.equal(Buffer.from(p.body.raw, 'base64').toString(), 'not json');

    const noName = message({ payload: 1 });
    fn(noName);
    await until(() => amqp.state.acks.includes(noName));
    assert.match(amqp.state.published.at(-1).body.error.message, /no job name/);
    assert.equal(handled.length, 0);
  });

  test('a malformed message that cannot be recorded is dropped; an unknown job is requeued', async () => {
    worker = await startJobWorker({ jobs: [FixtureEchoJob] });
    const fn = consumerOf('jobs');
    amqp.state.failPublish = 2;
    const junk = message('junk');
    fn(junk);
    const unknown = message({ job: 'Nope', unknownRetries: UNKNOWN_JOB_RETRIES });
    fn(unknown);
    await until(() => amqp.state.nacks.length === 2);
    assert.deepEqual(amqp.state.nacks.find((n) => n.msg === junk), { msg: junk, requeue: false });
    assert.deepEqual(amqp.state.nacks.find((n) => n.msg === unknown), { msg: unknown, requeue: true });
  });

  test('stop() waits for running jobs; channel loss re-creates the consumers', async () => {
    let release;
    let finished = false;
    class Long extends Job {
      async handle() {
        await new Promise((r) => { release = r; });
        finished = true;
      }
    }
    worker = await startJobWorker({ jobs: [Long], reconnectDelay: 5 });
    const ch = amqp.state.channels.at(-1);
    ch.emit('error', new Error('PRECONDITION_FAILED'));
    ch.emit('close');
    await until(() => amqp.state.consumers.length === 2);

    consumerOf('jobs')(message({ id: 'l', job: 'Long' }));
    await until(() => typeof release === 'function');
    const stopping = worker.stop();
    await wait(20);
    assert.equal(finished, false);
    release();
    await stopping;
    assert.equal(finished, true);
    worker = null;
  });

  test('stop() also waits for a timed-out job that ignores its signal; stop({ timeout }) gives up', async () => {
    let release;
    let finished = false;
    class Stubborn extends Job {
      static timeout = 20;

      async handle() { // ignores context.signal
        await new Promise((r) => { release = r; });
        finished = true;
      }
    }
    worker = await startJobWorker({ jobs: [Stubborn] });
    const m = message({ id: 's', job: 'Stubborn' });
    consumerOf('jobs')(m);
    await until(() => amqp.state.acks.includes(m)); // timed out and settled
    const stopping = worker.stop();
    await wait(30);
    assert.equal(finished, false, 'still running');
    let resolved = false;
    stopping.then(() => { resolved = true; });
    await wait(10);
    assert.equal(resolved, false, 'stop() waits for it');
    release();
    await stopping;
    assert.equal(finished, true);

    // a handler that never finishes: stop({ timeout }) returns anyway
    class Forever extends Job {
      async handle() { await new Promise(() => {}); }
    }
    worker = await startJobWorker({ jobs: [Forever] });
    consumerOf('jobs')(message({ id: 'f', job: 'Forever' }));
    await wait(10);
    const started = Date.now();
    await worker.stop({ timeout: 50 });
    assert.ok(Date.now() - started < 1000);
    worker = null;
  });
});

test('retryFailedJobs moves records back with a fresh attempt count and keeps malformed ones', async () => {
  const rec = (body) => message(body);
  const good = rec({
    id: 'g', job: 'Flaky', payload: { n: 1 }, attempt: 3, queue: 'other', error: {},
  });
  const bad = rec('garbage');
  amqp.state.stored['jobs.failed'] = [good, bad];
  assert.equal(await retryFailedJobs(), 1);
  const p = amqp.state.published.at(-1);
  assert.equal(p.q, 'jobs', 'always the queue the failed queue belongs to, not the record');
  assert.equal(p.body.job, 'Flaky');
  assert.equal(p.body.attempt, 0);
  assert.deepEqual(p.body.payload, { n: 1 });
  assert.ok(amqp.state.acks.includes(good));
  assert.deepEqual(amqp.state.nacks, [{ msg: bad, requeue: true }]);
});
