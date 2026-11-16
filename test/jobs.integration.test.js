// Jobs and scheduler against a real RabbitMQ. Skipped unless RABBITMQ_TEST_SERVER is set, e.g.
//   docker run -d --rm --name averoa-rabbitmq -p 127.0.0.1:35672:5672 rabbitmq:4.1-alpine
//   RABBITMQ_TEST_SERVER=amqp://guest:guest@127.0.0.1:35672 npm test
import './setup.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import amqplib from 'amqplib';
import { configureQueue, closeQueue, getConnection } from '../Queue.js';
import { Job } from '../Job.js';
import { startJobWorker, retryFailedJobs } from '../JobWorker.js';
import { Schedule, startScheduler } from '../Schedule.js';
import { until } from './amqp-mock.js';

const url = process.env.RABBITMQ_TEST_SERVER;
const run = `it-${randomBytes(4).toString('hex')}`;
const queues = new Set();
const q = (name) => {
  const full = `${run}.${name}`;
  queues.add(full);
  return full;
};

describe('jobs on RabbitMQ', { skip: !url && 'set RABBITMQ_TEST_SERVER to run' }, () => {
  before(async () => {
    await closeQueue();
    configureQueue({ url, driver: amqplib });
  });

  after(async () => {
    const connection = await getConnection();
    const channel = await connection.createChannel();
    channel.on('error', () => {});
    for (const name of queues) {
      for (const suffix of ['', '.failed', '.delay.1000', '.delay.2000']) {
        try { await channel.deleteQueue(name + suffix); } catch { /* not there */ }
      }
    }
    await channel.close().catch(() => {});
    await closeQueue();
  });

  async function readFailed(queue) {
    const connection = await getConnection();
    const channel = await connection.createChannel();
    try {
      await channel.assertQueue(`${queue}.failed`, { durable: true });
      const msg = await channel.get(`${queue}.failed`, { noAck: false });
      if (!msg) return null;
      channel.nack(msg, false, true);
      return JSON.parse(msg.content.toString());
    } finally {
      await channel.close();
    }
  }

  test('dispatch → worker handles the job', async () => {
    const queue = q('basic');
    const seen = [];
    class Greet extends Job {
      static queue = queue;

      async handle(payload, context) { seen.push({ payload, attempt: context.attempt }); }
    }
    const worker = await startJobWorker({ jobs: [Greet] });
    try {
      await Greet.dispatch({ name: 'Ada', at: new Date('2026-01-01T00:00:00Z') });
      await until(() => seen.length === 1, 5000);
      assert.deepEqual(seen, [{ payload: { name: 'Ada', at: '2026-01-01T00:00:00.000Z' }, attempt: 1 }]);
    } finally {
      await worker.stop();
    }
  });

  test('delayed dispatch runs after the delay (TTL queue + dead-lettering, no plugin)', async () => {
    const queue = q('delayed');
    const seen = [];
    class Later extends Job {
      static queue = queue;

      async handle() { seen.push(Date.now()); }
    }
    const worker = await startJobWorker({ jobs: [Later] });
    try {
      const start = Date.now();
      const r = await Later.dispatch(null, { delay: 1000 });
      assert.equal(r.delay, 1000);
      await new Promise((resolve) => { setTimeout(resolve, 600); });
      assert.equal(seen.length, 0, 'not before the delay');
      await until(() => seen.length === 1, 5000);
      assert.ok(seen[0] - start >= 1000, `ran after ${seen[0] - start} ms`);
    } finally {
      await worker.stop();
    }
  });

  test('retries with backoff, then failed() and a record in <queue>.failed; retryFailedJobs re-queues it', async () => {
    const queue = q('flaky');
    const attempts = [];
    const failed = [];
    let succeed = false;
    class Flaky extends Job {
      static queue = queue;

      static tries = 3;

      static backoff = [1000, 2000];

      async handle(payload, context) {
        attempts.push({ attempt: context.attempt, at: Date.now() });
        if (!succeed) throw new Error(`fail ${context.attempt}`);
      }

      async failed(payload, error, context) {
        failed.push({ payload, message: error.message, attempt: context.attempt });
      }
    }
    const worker = await startJobWorker({ jobs: [Flaky] });
    try {
      await Flaky.dispatch({ id: 42 });
      await until(() => failed.length === 1, 10000);
      assert.deepEqual(attempts.map((a) => a.attempt), [1, 2, 3]);
      const gap1 = attempts[1].at - attempts[0].at;
      const gap2 = attempts[2].at - attempts[1].at;
      assert.ok(gap1 >= 1000 && gap1 < 3000, `first backoff ${gap1} ms`);
      assert.ok(gap2 >= 2000 && gap2 < 4000, `second backoff ${gap2} ms`);
      assert.deepEqual(failed, [{ payload: { id: 42 }, message: 'fail 3', attempt: 3 }]);

      const record = await readFailed(queue);
      assert.equal(record.job, 'Flaky');
      assert.equal(record.queue, queue);
      assert.equal(record.attempt, 3);
      assert.deepEqual(record.payload, { id: 42 });
      assert.equal(record.error.message, 'fail 3');

      succeed = true;
      assert.equal(await retryFailedJobs({ queue }), 1);
      await until(() => attempts.length === 4, 5000);
      assert.equal(attempts[3].attempt, 1, 'a fresh attempt count');
      assert.equal(await readFailed(queue), null);
    } finally {
      await worker.stop();
    }
  });

  test('the scheduler dispatches a job that a worker runs', async () => {
    const queue = q('scheduled');
    const seen = [];
    class Tick extends Job {
      static queue = queue;

      async handle(payload) { seen.push(payload); }
    }
    const worker = await startJobWorker({ jobs: [Tick] });
    const schedule = new Schedule();
    schedule.job(Tick, { from: 'scheduler' }).cron('* * * * * *'); // every second
    const scheduler = await startScheduler({ schedule });
    try {
      await until(() => seen.length >= 1, 4000);
      assert.deepEqual(seen[0], { from: 'scheduler' });
    } finally {
      await scheduler.stop();
      await worker.stop();
    }
  });
});
