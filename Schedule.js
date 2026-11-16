import Log from './Log.js';
import { importAppDefault } from './paths.js';
import { isJobClass, jobNameOf } from './Job.js';

/*
 * Task scheduler: define recurring tasks in code and run them from one
 * long-lived process (`startScheduler()`), or once per minute from a system
 * cron / Kubernetes CronJob (`runScheduleOnce()`).
 *
 *   export default function schedule(schedule) {
 *     schedule.job(PruneSoftDeletedJob).dailyAt('03:00');
 *     schedule.call(() => cleanup()).everyFiveMinutes().withoutOverlapping();
 *   }
 *
 * Cron expressions are parsed by `croner` (optional peer dependency, loaded
 * lazily): 5 fields (minute precision) or 6 fields (with seconds), standard
 * day-of-month OR day-of-week semantics, IANA time zones.
 *
 * Run ONE scheduler process per application: every running scheduler fires
 * every task. To run several for availability, pass a `lock` (e.g. Redis
 * `SET key NX PX`) so only one of them runs each occurrence.
 */

const HH_MM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

let cronLib = null;
async function loadCron() {
  if (!cronLib) {
    try {
      const mod = await import('croner');
      cronLib = mod.Cron ?? mod.default?.Cron ?? mod.default;
    } catch (err) {
      throw new Error('Schedule: the scheduler needs the "croner" package; install it with `npm install croner`', { cause: err });
    }
  }
  return cronLib;
}

function parseTime(time) {
  const match = HH_MM.exec(String(time));
  if (!match) throw new Error(`Schedule: invalid time "${time}" (use HH:MM, 24-hour)`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function intIn(value, min, max, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Schedule: invalid ${what} ${value} (${min}-${max})`);
  return n;
}

/** One scheduled task: a frequency, options and what to run. Setters are chainable. */
export class ScheduledEvent {
  constructor(run, description) {
    this.run = run;
    this.description = description;
    this.expression = '* * * * *';
    this.tz = undefined;
    this.overlapping = true;
  }

  /** Any 5-field (or 6-field, with seconds) cron expression. */
  cron(expression) {
    if (typeof expression !== 'string' || expression.trim() === '') throw new Error('Schedule: cron expression required');
    this.expression = expression.trim();
    return this;
  }

  everyMinute() { return this.cron('* * * * *'); }

  everyTwoMinutes() { return this.cron('*/2 * * * *'); }

  everyFiveMinutes() { return this.cron('*/5 * * * *'); }

  everyTenMinutes() { return this.cron('*/10 * * * *'); }

  everyFifteenMinutes() { return this.cron('*/15 * * * *'); }

  everyThirtyMinutes() { return this.cron('*/30 * * * *'); }

  hourly() { return this.cron('0 * * * *'); }

  /** Every hour at the given minute (0-59). */
  hourlyAt(minute) { return this.cron(`${intIn(minute, 0, 59, 'minute')} * * * *`); }

  daily() { return this.cron('0 0 * * *'); }

  /** Every day at HH:MM (24-hour, in the event's time zone). */
  dailyAt(time) {
    const { hour, minute } = parseTime(time);
    return this.cron(`${minute} ${hour} * * *`);
  }

  /** Sundays at 00:00, or `weeklyOn(day, 'HH:MM')` for another day (0 = Sunday). */
  weekly() { return this.cron('0 0 * * 0'); }

  weeklyOn(day, time = '00:00') {
    const { hour, minute } = parseTime(time);
    return this.cron(`${minute} ${hour} * * ${intIn(day, 0, 6, 'weekday')}`);
  }

  /** The 1st of every month at 00:00, or `monthlyOn(day, 'HH:MM')`. */
  monthly() { return this.cron('0 0 1 * *'); }

  monthlyOn(day = 1, time = '00:00') {
    const { hour, minute } = parseTime(time);
    return this.cron(`${minute} ${hour} ${intIn(day, 1, 31, 'day of month')} * *`);
  }

  /** IANA time zone for this event (default: the scheduler's, else the process time zone). */
  timezone(tz) {
    this.tz = tz;
    return this;
  }

  /** Skip an occurrence while the previous run of this event is still running (in this process). */
  withoutOverlapping() {
    this.overlapping = false;
    return this;
  }

  /** Name used in logs and passed to the `lock` hook. */
  name(description) {
    this.description = String(description);
    return this;
  }
}

/** The list of scheduled events. */
export class Schedule {
  constructor() {
    this.events = [];
  }

  /**
   * Dispatch a job on a schedule (it runs on a job worker, not in the
   * scheduler). `withoutOverlapping()` only covers the dispatch.
   */
  job(JobClass, payload, options = {}) {
    if (!isJobClass(JobClass)) throw new Error('Schedule.job() expects a Job subclass');
    const event = new ScheduledEvent(() => JobClass.dispatch(payload, options), jobNameOf(JobClass));
    this.events.push(event);
    return event;
  }

  /** Run a function in the scheduler process. */
  call(fn, description) {
    if (typeof fn !== 'function') throw new Error('Schedule.call() expects a function');
    const event = new ScheduledEvent(fn, description || fn.name || `call #${this.events.length + 1}`);
    this.events.push(event);
    return event;
  }
}

/**
 * A Schedule from: a Schedule, a function `(schedule) => void`, an object or
 * class with a `schedule(schedule)` method, or — when nothing is given — the
 * default export of the app's `app/Console/Kernel.js`.
 */
export async function loadSchedule(definition) {
  if (definition instanceof Schedule) return definition;
  let source = definition;
  if (source === undefined || source === null) {
    source = await importAppDefault('app/Console/Kernel.js', { optional: true });
    if (!source) throw new Error('Schedule: no schedule (pass `schedule`, or export one from app/Console/Kernel.js)');
  }
  const schedule = new Schedule();
  if (typeof source?.schedule === 'function') {
    await source.schedule(schedule);
  } else if (typeof source === 'function' && typeof source.prototype?.schedule === 'function') {
    await new source().schedule(schedule);
  } else if (typeof source === 'function') {
    await source(schedule);
  } else {
    throw new Error('Schedule: the schedule must be a function (schedule) => {} or have a schedule(schedule) method');
  }
  return schedule;
}

async function compile(schedule, timezone) {
  const Cron = await loadCron();
  const timezoneOf = (event) => event.tz || timezone || undefined;
  return schedule.events.map((event) => {
    let cron;
    try {
      cron = new Cron(event.expression, { paused: true, timezone: timezoneOf(event) });
      cron.nextRun(); // surfaces an invalid time zone now, not at the first tick
    } catch (err) {
      throw new Error(`Schedule: "${event.description}": invalid cron "${event.expression}"${timezoneOf(event) ? ` or time zone "${timezoneOf(event)}"` : ''}: ${err.message}`, { cause: err });
    }
    return {
      event, cron, running: null, next: null, timezone: timezoneOf(event),
    };
  });
}

function makeRunner({ lock }) {
  const running = new Set();
  function fire(entry, scheduledAt) {
    const { event } = entry;
    if (!event.overlapping && entry.running) {
      Log.info(`Scheduler: skipping "${event.description}", the previous run is still running`);
      return;
    }
    const task = (async () => {
      if (lock) {
        let acquired;
        try {
          acquired = await lock(event, scheduledAt);
        } catch (err) {
          Log.error(`Scheduler: lock for "${event.description}" failed, skipping: ${err?.message ?? err}`);
          return;
        }
        if (!acquired) return;
      }
      try {
        await event.run();
      } catch (err) {
        Log.error(`Scheduler: "${event.description}" failed: ${err?.message ?? err}`);
      }
    })();
    entry.running = task;
    running.add(task);
    task.finally(() => {
      running.delete(task);
      if (entry.running === task) entry.running = null;
    });
  }
  return { fire, running };
}

/**
 * Run the schedule until `stop()`.
 *
 * Wakes at the next due time (at least once a minute, so clock changes are
 * picked up), runs every event that is due and computes its next time from
 * "now": occurrences missed while the process was down or asleep are not
 * caught up. Errors of a task are logged, never thrown.
 *
 * @param {object} [options]
 * @param {*} [options.schedule] see loadSchedule() (default: app/Console/Kernel.js)
 * @param {string} [options.timezone] default IANA time zone (default: SCHEDULE_TIMEZONE, else the process TZ)
 * @param {(event: ScheduledEvent, at: Date) => boolean|Promise<boolean>} [options.lock]
 *   called before each run; falsy = another scheduler has it, skip
 * @param {number} [options.maxSleep=60000] longest single wait in ms
 */
export async function startScheduler({
  schedule, timezone = process.env.SCHEDULE_TIMEZONE || undefined, lock, maxSleep = 60000,
} = {}) {
  const loaded = await loadSchedule(schedule);
  const entries = await compile(loaded, timezone);
  const { fire, running } = makeRunner({ lock });
  let stopped = false;
  let timer = null;

  const now = () => new Date();
  for (const entry of entries) entry.next = entry.cron.nextRun(now());

  function arm() {
    if (stopped) return;
    const t = Date.now();
    const soonest = entries.reduce((min, e) => (e.next && e.next.getTime() < min ? e.next.getTime() : min), Infinity);
    const wait = Math.max(0, Math.min(maxSleep, soonest - t));
    timer = setTimeout(tick, wait);
  }

  function tick() {
    timer = null;
    if (stopped) return;
    const at = now();
    for (const entry of entries) {
      if (entry.next && entry.next.getTime() <= at.getTime()) {
        const scheduledAt = entry.next;
        entry.next = entry.cron.nextRun(at);
        fire(entry, scheduledAt);
      }
    }
    arm();
  }

  arm();
  Log.info(`Scheduler: ${entries.length} event(s) scheduled`);

  return {
    /** `[{ name, expression, timezone, overlapping, nextRun }]` */
    get events() {
      return entries.map((e) => ({
        name: e.event.description,
        expression: e.event.expression,
        timezone: e.timezone ?? null,
        overlapping: e.event.overlapping,
        nextRun: e.next,
      }));
    },
    /** Stop scheduling and wait for the running tasks. */
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      await Promise.allSettled([...running]);
    },
  };
}

/**
 * Run, once, every event due in the current minute, wait for them and resolve
 * to their names. For a system cron / Kubernetes CronJob that starts the
 * process every minute instead of a long-running scheduler. 6-field (seconds)
 * expressions match second 0 only.
 *
 * @param {{ schedule?: *, timezone?: string, lock?: Function, at?: Date }} [options]
 */
export async function runScheduleOnce({
  schedule, timezone = process.env.SCHEDULE_TIMEZONE || undefined, lock, at = new Date(),
} = {}) {
  const loaded = await loadSchedule(schedule);
  const entries = await compile(loaded, timezone);
  const { fire, running } = makeRunner({ lock });
  const minute = new Date(at);
  minute.setSeconds(0, 0);
  const due = entries.filter((e) => e.cron.match(minute));
  for (const entry of due) fire(entry, minute);
  await Promise.allSettled([...running]);
  return due.map((e) => e.event.description);
}

export default Schedule;
