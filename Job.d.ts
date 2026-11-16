import type { AbortSignalLike } from './types.js';

/** Wait before a retry: ms, `[ms, ...]` per retry (the last repeats), or `(retry) => ms`. */
export type Backoff = number | readonly number[] | ((retry: number) => number);

/** Second argument of `handle()` and third of `failed()`. */
export interface JobContext {
  /** Message id (stable across retries). */
  id: string | null;
  /** Registered job name. */
  name: string;
  /** Queue the message came from (null for dispatchSync()). */
  queue: string | null;
  /** Attempt number, 1-based. */
  attempt: number;
  tries: number;
  /** Aborted when the attempt exceeds the job's `timeout`. */
  signal: AbortSignalLike;
  /** Set by dispatchSync(). */
  sync?: true;
}

export interface DispatchOptions {
  /** Delay in ms, or a Date (a past Date runs now). At most MAX_DELAY. */
  delay?: number | Date;
  /** Queue name (default: the job's `static queue`, then the default job queue). */
  queue?: string;
}

export interface DispatchResult {
  id: string;
  job: string;
  queue: string;
  /** Delay in ms, rounded up to whole seconds. */
  delay: number;
}

/** Wire format of a job message. */
export interface JobMessage {
  id: string;
  job: string;
  payload: unknown;
  attempt: number;
  dispatchedAt: string;
}

/** Payload type of a job class: the first parameter of its `handle()`. */
export type JobPayload<J extends Job> = Parameters<J['handle']>[0];

/** Thrown into a job (and passed to `failed()`) when it runs longer than its `timeout`. */
export class JobTimeoutError extends Error {
  constructor(name: string, ms: number);
  name: 'JobTimeoutError';
}

/**
 * Base class for background jobs.
 *
 * ```ts
 * class SendReportJob extends Job {
 *   static tries = 3;
 *   static backoff = [1000, 5000, 30000];
 *   async handle(payload: { reportId: number }, context: JobContext) { ... }
 * }
 * await SendReportJob.dispatch({ reportId: 1 }, { delay: 60000 });
 * ```
 */
export class Job {
  /** Registered name (default: the class name); unique per worker. */
  static jobName?: string;
  /** Queue name (default: config/queue.js `jobsQueue`, JOBS_QUEUE or 'jobs'). */
  static queue?: string;
  /** Total attempts, including the first (default 1). */
  static tries?: number;
  static backoff?: Backoff;
  /** Max run time of one attempt in ms; 0 / unset = none. */
  static timeout?: number;

  /** Does the work. The payload went through a JSON round trip. */
  handle(payload: any, context: JobContext): unknown;
  /** Called once when the last attempt has failed. Its errors are logged, never thrown. */
  failed?(payload: any, error: unknown, context: JobContext): unknown;

  /** Queue the job; `payload` must be JSON serialisable. Resolves once the broker confirmed it. */
  static dispatch<J extends Job>(this: new () => J, payload?: JobPayload<J>, options?: DispatchOptions): Promise<DispatchResult>;

  /**
   * Run the job now, in this process, once (no queue, retries, backoff or
   * timeout). On error `failed()` is called and the error re-thrown.
   */
  static dispatchSync<J extends Job>(this: new () => J, payload?: JobPayload<J>): Promise<Awaited<ReturnType<J['handle']>>>;
}

export default Job;

/** Longest supported delay / backoff in ms (30 days). */
export const MAX_DELAY: number;

/** Throws unless `name` is a usable queue name; returns it. */
export function validateQueueName(name: string): string;

/** Default job queue: config/queue.js `jobsQueue`, env JOBS_QUEUE, or 'jobs'. */
export function defaultJobQueue(): Promise<string>;

/** Forget the cached default queue name. */
export function resetJobConfig(): void;

/** True for Job subclasses (also across duplicated copies of this package). */
export function isJobClass(value: unknown): value is typeof Job;

/** The name a job class is registered and dispatched under. */
export function jobNameOf(JobClass: { jobName?: string; name: string }): string;

/** Delay in ms (rounded up to whole seconds) from ms or a Date; throws when invalid. */
export function normaliseDelay(delay?: number | Date | null): number;

/** `(retry) => ms` doubling from `base` (default 1000) up to `max` (default 1 hour). */
export function exponentialBackoff(base?: number, max?: number): (retry: number) => number;

/** Wait in ms before retry number `retry` (1 = the first retry); 0 for anything invalid. */
export function backoffDelay(backoff: Backoff | null | undefined, retry: number): number;

/** Publish a job message to `queue`, or to its delay queue when `delay` (ms) > 0. */
export function sendJob(queue: string, message: JobMessage, delay?: number): Promise<void>;

/** Queue holding the records of jobs that failed for good: `<queue>.failed`. */
export function failedQueueOf(queue: string): string;

/** Run `fn()`; reject with JobTimeoutError (and abort `controller`) after `ms` (0 = no limit). */
export function runWithTimeout<T>(
  fn: () => T | PromiseLike<T>,
  ms: number,
  controller?: { abort(reason?: unknown): void },
  name?: string,
): Promise<T>;

/** Call the optional `failed()` hook of `instance`; its errors are logged, never thrown. */
export function callFailed(instance: unknown, payload: unknown, error: unknown, context: JobContext): Promise<void>;

export interface FakeDispatch {
  id: string;
  job: string;
  payload: unknown;
  queue: string;
  delay: number;
}

export interface FakeJobs {
  /** Every dispatch() since fakeJobs() was called. */
  dispatched: FakeDispatch[];
  /** Publish for real again. */
  restore(): void;
}

/** Make dispatch() record instead of publish (tests). */
export function fakeJobs(): FakeJobs;
