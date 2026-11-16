import './setup.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import {
  Queue, closeQueue, Mail, startMailWorker, View, DB,
} from '../index.js';
import { configureQueue } from '../Queue.js';
import { setTransporter } from '../Mail.js';

after(() => DB.destroy());

/** In-memory amqplib stand-in. */
function createMockAmqp() {
  const state = {
    connects: 0, published: [], asserted: [], acks: [], nacks: [], consumers: [], connections: [],
    channels: [], createChannelTimes: [], failCreateChannel: 0, ackThrows: false,
  };
  class Channel extends EventEmitter {
    async assertQueue(q, opts) { state.asserted.push({ q, opts }); return { queue: q }; }
    sendToQueue(q, content, opts, cb) {
      state.published.push({ q, content, opts });
      if (cb) setImmediate(() => cb(null));
      return true;
    }
    async prefetch(n) { this.prefetchCount = n; }
    async consume(q, fn) { state.consumers.push({ q, fn }); return { consumerTag: `tag-${state.consumers.length}` }; }
    ack(msg) {
      if (state.ackThrows) throw new Error('Channel closed');
      state.acks.push(msg);
    }
    nack(msg, all, requeue) { state.nacks.push({ msg, requeue }); }
    async cancel() {}
    async close() { this.emit('close'); }
  }
  class Connection extends EventEmitter {
    async createConfirmChannel() { return new Channel(); }
    async createChannel() {
      state.createChannelTimes.push(Date.now());
      if (state.failCreateChannel > 0) {
        state.failCreateChannel -= 1;
        throw new Error('broker unavailable');
      }
      const ch = new Channel();
      state.channels.push(ch);
      return ch;
    }
    async close() { this.closed = true; this.emit('close'); }
  }
  return {
    state,
    async connect(url, opts) {
      state.connects += 1;
      state.lastUrl = url;
      state.lastOpts = opts;
      const c = new Connection();
      state.connections.push(c);
      return c;
    },
  };
}

let amqp;
beforeEach(async () => {
  await closeQueue();
  amqp = createMockAmqp();
  configureQueue({ url: 'amqp://test', driver: amqp });
});

test('Queue reuses one connection and channel for many messages', async () => {
  await Promise.all([Queue('jobs', { a: 1 }), Queue('jobs', 'text'), Queue('other', { b: 2 })]);
  await Queue('jobs', { c: 3 });
  assert.equal(amqp.state.connects, 1);
  assert.equal(amqp.state.published.length, 4);
  for (const p of amqp.state.published) assert.equal(p.opts.persistent, true);
  assert.ok(amqp.state.asserted.every((a) => a.opts.durable === true));
  assert.equal(amqp.state.published[0].opts.contentType, 'application/json');
  assert.equal(amqp.state.published[1].content.toString(), 'text');
});

test('Queue reconnects after the connection closes; closeQueue closes it', async () => {
  await Queue('jobs', 1);
  amqp.state.connections[0].emit('close');
  await Queue('jobs', 2);
  assert.equal(amqp.state.connects, 2);

  await closeQueue();
  assert.equal(amqp.state.connections[1].closed, true);
});

test('Queue without a configured server rejects clearly', async () => {
  await closeQueue();
  configureQueue({ url: '' });
  const saved = process.env.RABBITMQ_SERVER;
  delete process.env.RABBITMQ_SERVER;
  try {
    await assert.rejects(Queue('jobs', 1), /no AMQP server configured/);
  } finally {
    if (saved !== undefined) process.env.RABBITMQ_SERVER = saved;
    configureQueue({ url: 'amqp://test' });
  }
});

test('Mail renders the view and enqueues the options', async () => {
  const r = await Mail.init().from('a@x.io').to('b@x.io').subject('Hi')
    .html('hello', { name: 'Bob' })
    .queue('mail')
    .send();
  assert.equal(r.status, 'queued');
  assert.equal(r.channel, 'mail');
  const body = JSON.parse(amqp.state.published[0].content.toString());
  assert.equal(body.html.trim(), '<p>Hello Bob</p>');
  assert.equal(body.to, 'b@x.io');
});

test('Mail: raw HTML is used as-is; render errors are thrown (and logged)', async () => {
  const sent = [];
  setTransporter({ async sendMail(o) { sent.push(o); return { messageId: '1' }; } });
  await Mail.init().to('b@x.io').html('<b>raw</b>').send();
  assert.equal(sent[0].html, '<b>raw</b>');
  await assert.rejects(Mail.init().to('b@x.io').html('missing-template').send());
  assert.ok(View);
});

test('startMailWorker sends, acks, retries with a limit, and stops', async () => {
  const sent = [];
  let fail = 0;
  const transporter = {
    async sendMail(o) {
      if (o.subject === 'boom') { fail += 1; throw new Error('smtp down'); }
      sent.push(o);
    },
  };
  const worker = await startMailWorker({ queue: 'mail', prefetch: 2, maxRetries: 2, transporter });
  const { fn } = amqp.state.consumers.at(-1);
  const deliver = (content, headers = {}) => {
    const msg = { content: Buffer.from(JSON.stringify(content)), properties: { headers } };
    fn(msg);
    return msg;
  };
  const flush = () => new Promise((r) => setTimeout(r, 20));

  const ok = deliver({ to: 'x@y.z', subject: 'hi', attachments: [{ filename: 'a', content: { type: 'Buffer', data: [104, 105] } }] });
  await flush();
  assert.equal(sent.length, 1);
  assert.ok(Buffer.isBuffer(sent[0].attachments[0].content));
  assert.ok(amqp.state.acks.includes(ok));

  const before = amqp.state.published.length;
  const bad = deliver({ to: 'x@y.z', subject: 'boom' });
  await flush();
  assert.ok(amqp.state.acks.includes(bad));
  const retry = amqp.state.published.at(-1);
  assert.equal(amqp.state.published.length, before + 1);
  assert.equal(retry.opts.headers['x-averoa-retries'], 1);

  const last = deliver({ to: 'x@y.z', subject: 'boom' }, { 'x-averoa-retries': 2 });
  await flush();
  assert.deepEqual(amqp.state.nacks.at(-1), { msg: last, requeue: false });

  const junk = { content: Buffer.from('not json'), properties: {} };
  fn(junk);
  await flush();
  assert.equal(amqp.state.nacks.at(-1).msg, junk);

  await worker.stop();
  assert.equal(fail, 2);
  assert.equal(amqp.state.connects, 1);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await wait(5);
  }
}

test('U13: an ack failure after a successful send does not re-publish (no duplicate mail)', async () => {
  const sent = [];
  const transporter = { async sendMail(o) { sent.push(o); } };
  const worker = await startMailWorker({ queue: 'mail', transporter, reconnectDelay: 5 });
  const { fn } = amqp.state.consumers.at(-1);
  amqp.state.ackThrows = true;
  const before = amqp.state.published.length;
  fn({ content: Buffer.from(JSON.stringify({ to: 'x@y.z', subject: 'once' })), properties: { headers: {} } });
  await wait(20);
  amqp.state.ackThrows = false;
  assert.equal(sent.length, 1);
  assert.equal(amqp.state.published.length, before, 'must not re-publish a sent mail');
  assert.equal(amqp.state.nacks.length, 0);
  await worker.stop();
});

test('U2: channel error/close does not crash; the consumer is re-created', async () => {
  const sent = [];
  const transporter = { async sendMail(o) { sent.push(o.subject); } };
  const worker = await startMailWorker({ queue: 'mail', transporter, reconnectDelay: 5 });
  const firstTag = worker.consumerTag;
  const ch = amqp.state.channels.at(-1);

  // an unhandled 'error' on an EventEmitter would throw here
  ch.emit('error', new Error('PRECONDITION_FAILED'));
  ch.emit('close');
  await until(() => amqp.state.consumers.length === 2);
  assert.notEqual(worker.consumerTag, firstTag);

  amqp.state.consumers.at(-1).fn({ content: Buffer.from(JSON.stringify({ subject: 'after' })), properties: {} });
  await until(() => sent.length === 1);
  assert.deepEqual(sent, ['after']);

  // broker cancels the consumer (msg === null) → consume again
  amqp.state.consumers.at(-1).fn(null);
  await until(() => amqp.state.consumers.length === 3);
  await worker.stop();
});

test('U2: connection close reconnects with exponential backoff; stop() cancels reconnects', async () => {
  const worker = await startMailWorker({
    queue: 'mail', transporter: { async sendMail() {} }, reconnectDelay: 20, maxReconnectDelay: 40,
  });
  amqp.state.failCreateChannel = 3;
  amqp.state.createChannelTimes.length = 0;
  amqp.state.connections.at(-1).emit('close');
  await until(() => amqp.state.consumers.length === 2, 3000);
  assert.equal(amqp.state.connects, 2, 'a new connection is opened');

  const t = amqp.state.createChannelTimes;
  assert.equal(t.length, 4);
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  // delays 20 → 40 → 80 capped at 40 (lower bounds; timers may fire late)
  assert.ok(gaps[0] >= 35, `gap ${gaps[0]}`);
  assert.ok(gaps[1] >= 35, `gap ${gaps[1]}`);
  assert.ok(gaps[2] >= 35 && gaps[2] < 1000, `gap ${gaps[2]}`);

  // a pending reconnect is cancelled by stop()
  amqp.state.channels.at(-1).emit('close');
  await worker.stop();
  const consumers = amqp.state.consumers.length;
  await wait(80);
  assert.equal(amqp.state.consumers.length, consumers);
});

test('U2: stop() does not trigger a reconnect', async () => {
  const worker = await startMailWorker({ queue: 'mail', transporter: { async sendMail() {} }, reconnectDelay: 5 });
  await worker.stop();
  await wait(30);
  assert.equal(amqp.state.consumers.length, 1);
});
