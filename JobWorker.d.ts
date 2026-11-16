import type { Backoff, Job } from './Job.js';

/** Job classes: an array, or an object of exports (non-Job values are ignored). */
export type JobList = ReadonlyArray<typeof Job> | Record<string, unknown>;

/**
 * Registry `name -> class` from `jobs`, or from the Job exports of the app's
 * app/Jobs/index.js when `jobs` is not given. Duplicate names are an error.
 */
export function loadJobs(jobs?: JobList | null): Promise<Map<string, typeof Job>>;

export interface JobWorkerOptions {
  /** Queues to consume (default: the queues of the registered jobs). */
  queues?: string[];
  /** Job classes (default: the Job exports of app/Jobs/index.js). */
  jobs?: JobList;
  /** Jobs run at once per queue (AMQP prefetch, default 1). */
  concurrency?: number;
  /** Alias of `concurrency`. */
  prefetch?: number;
  /** Default `tries` for jobs that set none (1). */
  tries?: number;
  /** Default `backoff` for jobs that set none (0). */
  backoff?: Backoff;
  /** Default `timeout` in ms for jobs that set none (0 = none). */
  timeout?: number;
  /** First reconnect delay in ms (default 1000). */
  reconnectDelay?: number;
  /** Reconnect delay cap in ms (default 30000). */
  maxReconnectDelay?: number;
}

export interface JobWorkerHandle {
  readonly queues: string[];
  /** Registered job names. */
  readonly jobs: string[];
  /** Tags of the current consumers (they change after a reconnect). */
  readonly consumerTags: string[];
  /** Stop consuming and reconnecting, wait for running jobs, close the channel. */
  stop(): Promise<void>;
}

/** Consume job queues and run the jobs (retries, backoff, timeouts, failed queue, reconnects). */
export function startJobWorker(options?: JobWorkerOptions): Promise<JobWorkerHandle>;

export interface RetryFailedJobsOptions {
  /** Default: the default job queue. */
  queue?: string;
  /** Maximum number of jobs to move (default: all). */
  limit?: number;
}

/** Move failed job records from `<queue>.failed` back to `<queue>`; resolves to how many were moved. */
export function retryFailedJobs(options?: RetryFailedJobsOptions): Promise<number>;

export default startJobWorker;
