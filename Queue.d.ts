/*
 * amqplib ships no types; the connection and channel are typed with the
 * methods this package uses. Cast to amqplib's types (`@types/amqplib`) for more.
 */

export interface AmqpMessage {
  content: Uint8Array & { toString(encoding?: string): string };
  fields: Record<string, unknown>;
  properties: { headers?: Record<string, unknown>; contentType?: string; messageId?: string; [key: string]: unknown };
}

export interface PublishOptions {
  persistent?: boolean;
  contentType?: string;
  headers?: Record<string, unknown>;
  messageId?: string;
  type?: string;
  expiration?: string | number;
  priority?: number;
  [key: string]: unknown;
}

export interface AmqpChannel {
  assertQueue(queue: string, options?: Record<string, unknown>): Promise<unknown>;
  sendToQueue(queue: string, content: Uint8Array, options?: PublishOptions, callback?: (err: unknown) => void): boolean;
  consume(queue: string, onMessage: (msg: AmqpMessage | null) => void, options?: Record<string, unknown>): Promise<{ consumerTag: string }>;
  get(queue: string, options?: { noAck?: boolean }): Promise<AmqpMessage | false>;
  ack(message: AmqpMessage, allUpTo?: boolean): void;
  nack(message: AmqpMessage, allUpTo?: boolean, requeue?: boolean): void;
  prefetch(count: number, global?: boolean): Promise<unknown>;
  cancel(consumerTag: string): Promise<unknown>;
  close(): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

export interface AmqpConnection {
  createChannel(): Promise<AmqpChannel>;
  createConfirmChannel(): Promise<AmqpChannel>;
  close(): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

/** What `amqplib` provides: `connect(url, { heartbeat })`. */
export interface AmqpDriver {
  connect(url: string, options?: { heartbeat?: number }): Promise<AmqpConnection>;
}

export interface QueueOptions {
  /** AMQP URL (default: config/queue.js `amqp`, env RABBITMQ_SERVER). */
  url?: string;
  /** Heartbeat in seconds (default 5). */
  heartbeat?: number;
  /** Replace amqplib (tests, custom setups). */
  driver?: AmqpDriver;
}

/** Override queue settings (mostly for tests / custom setups). */
export function configureQueue(options?: QueueOptions): void;

/** The shared AMQP connection (opened on first use). */
export function getConnection(): Promise<AmqpConnection>;

/** The shared confirm channel used for publishing. */
export function getChannel(): Promise<AmqpChannel>;

/**
 * Publish `data` to the durable queue `queue` as a persistent message and
 * wait for the broker confirm. Strings are sent as-is, Buffers raw, anything
 * else as JSON.
 */
export function publish(queue: string, data: unknown, options?: PublishOptions): Promise<true>;

/** Close the shared channel and connection (graceful shutdown, tests). */
export function closeQueue(): Promise<void>;

/** `await Queue('queue-name', data)`: same as publish(). */
export default function Queue(queue: string, data: unknown, options?: PublishOptions): Promise<true>;
