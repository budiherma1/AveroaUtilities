import type { Awaitable } from './types.js';
import type { DispatchOptions, Job, JobPayload } from './Job.js';

/** One scheduled task: a frequency, options and what to run. Setters are chainable. */
export class ScheduledEvent {
  constructor(run: () => unknown, description: string);
  run: () => unknown;
  description: string;
  /** Cron expression (default every minute). */
  expression: string;
  tz: string | undefined;
  overlapping: boolean;

  /** Any 5-field (or 6-field, with seconds) cron expression. */
  cron(expression: string): this;
  everyMinute(): this;
  everyTwoMinutes(): this;
  everyFiveMinutes(): this;
  everyTenMinutes(): this;
  everyFifteenMinutes(): this;
  everyThirtyMinutes(): this;
  hourly(): this;
  /** Every hour at the given minute (0-59). */
  hourlyAt(minute: number): this;
  daily(): this;
  /** Every day at HH:MM (24-hour, in the event's time zone). */
  dailyAt(time: string): this;
  /** Sundays at 00:00. */
  weekly(): this;
  /** `day` 0 = Sunday ... 6. */
  weeklyOn(day: number, time?: string): this;
  /** The 1st of every month at 00:00. */
  monthly(): this;
  monthlyOn(day?: number, time?: string): this;
  /** IANA time zone for this event. */
  timezone(tz: string): this;
  /** Skip an occurrence while the previous run of this event is still running (in this process). */
  withoutOverlapping(): this;
  /** Name used in logs and passed to the `lock` hook. */
  name(description: string): this;
}

/** The list of scheduled events. */
export class Schedule {
  constructor();
  events: ScheduledEvent[];
  /** Dispatch a job on a schedule (it runs on a job worker, not in the scheduler). */
  job<J extends Job>(JobClass: new () => J, payload?: JobPayload<J>, options?: DispatchOptions): ScheduledEvent;
  /** Run a function in the scheduler process. */
  call(fn: () => unknown, description?: string): ScheduledEvent;
}

export default Schedule;

/**
 * A schedule: a Schedule, a function `(schedule) => void`, an object or class
 * with a `schedule(schedule)` method.
 */
export type ScheduleDefinition =
  | Schedule
  | ((schedule: Schedule) => unknown)
  | { schedule(schedule: Schedule): unknown }
  | (new () => { schedule(schedule: Schedule): unknown });

/** A Schedule from a definition, or from the default export of app/Console/Kernel.js. */
export function loadSchedule(definition?: ScheduleDefinition | null): Promise<Schedule>;

/** Called before each run; a falsy result means another scheduler has it: skip. */
export type ScheduleLock = (event: ScheduledEvent, at: Date) => Awaitable<unknown>;

export interface SchedulerOptions {
  /** Default: app/Console/Kernel.js. */
  schedule?: ScheduleDefinition;
  /** Default IANA time zone (default: SCHEDULE_TIMEZONE, else the process TZ). */
  timezone?: string;
  lock?: ScheduleLock;
  /** Longest single wait in ms (default 60000). */
  maxSleep?: number;
}

export interface ScheduledEventInfo {
  name: string;
  expression: string;
  timezone: string | null;
  overlapping: boolean;
  nextRun: Date | null;
}

export interface SchedulerHandle {
  readonly events: ScheduledEventInfo[];
  /** Stop scheduling and wait for the running tasks. */
  stop(): Promise<void>;
}

/** Run the schedule until stop(). Needs the optional peer dependency `croner`. */
export function startScheduler(options?: SchedulerOptions): Promise<SchedulerHandle>;

export interface RunScheduleOnceOptions {
  schedule?: ScheduleDefinition;
  timezone?: string;
  lock?: ScheduleLock;
  /** The minute to run (default now). */
  at?: Date;
}

/** Run every event due in the current minute once; resolves to their names. */
export function runScheduleOnce(options?: RunScheduleOnceOptions): Promise<string[]>;
