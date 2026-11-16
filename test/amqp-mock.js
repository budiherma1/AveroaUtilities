import { EventEmitter } from 'events';

/** In-memory amqplib stand-in: records declarations, publications, acks and nacks. */
export function createMockAmqp() {
  const state = {
    connects: 0,
    published: [],
    asserted: [],
    acks: [],
    nacks: [],
    consumers: [],
    connections: [],
    channels: [],
    failPublish: 0,
    stored: {}, // queue -> messages for channel.get()
  };
  class Channel extends EventEmitter {
    async assertQueue(q, opts) { state.asserted.push({ q, opts }); return { queue: q }; }

    sendToQueue(q, content, opts, cb) {
      if (state.failPublish > 0) {
        state.failPublish -= 1;
        if (cb) setImmediate(() => cb(new Error('nacked by broker')));
        return true;
      }
      state.published.push({ q, content, opts, body: safeJson(content) });
      if (cb) setImmediate(() => cb(null));
      return true;
    }

    async prefetch(n) { this.prefetchCount = n; }

    async consume(q, fn) {
      state.consumers.push({ q, fn, channel: this });
      return { consumerTag: `tag-${state.consumers.length}` };
    }

    async get(q) {
      const list = state.stored[q] ?? [];
      return list.length ? list.shift() : false;
    }

    ack(msg) { state.acks.push(msg); }

    nack(msg, all, requeue) { state.nacks.push({ msg, requeue }); }

    async cancel() {}

    async close() { this.emit('close'); }
  }
  class Connection extends EventEmitter {
    async createConfirmChannel() { return new Channel(); }

    async createChannel() {
      const ch = new Channel();
      state.channels.push(ch);
      return ch;
    }

    async close() { this.closed = true; this.emit('close'); }
  }
  return {
    state,
    async connect() {
      state.connects += 1;
      const c = new Connection();
      state.connections.push(c);
      return c;
    },
  };
}

function safeJson(buf) {
  try { return JSON.parse(buf.toString()); } catch { return undefined; }
}

/** A delivered message as amqplib hands it to a consumer. */
export function message(body, properties = {}) {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { content, fields: {}, properties: { headers: {}, ...properties } };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await wait(5);
  }
}
