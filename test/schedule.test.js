import './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  Schedule, ScheduledEvent, startScheduler, runScheduleOnce, loadSchedule,
} from '../Schedule.js';
import { Job, fakeJobs } from '../Job.js';
import { calls as kernelCalls } from './fixtures/app/app/Console/Kernel.js';

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => { setImmediate(r); });
};

describe('ScheduledEvent frequencies', () => {
  test('helpers build cron expressions; invalid input is rejected', () => {
    const e = () => new ScheduledEvent(() => {}, 'x');
    assert.equal(e().expression, '* * * * *', 'every minute by default');
    assert.equal(e().everyFiveMinutes().expression, '*/5 * * * *');
    assert.equal(e().everyFifteenMinutes().expression, '*/15 * * * *');
    assert.equal(e().hourly().expression, '0 * * * *');
    assert.equal(e().hourlyAt(17).expression, '17 * * * *');
    assert.equal(e().daily().expression, '0 0 * * *');
    assert.equal(e().dailyAt('03:00').expression, '0 3 * * *');
    assert.equal(e().dailyAt('7:05').expression, '5 7 * * *');
    assert.equal(e().weeklyOn(1, '08:30').expression, '30 8 * * 1');
    assert.equal(e().monthlyOn(15, '12:00').expression, '0 12 15 * *');
    assert.equal(e().cron(' */5 * * * * ').expression, '*/5 * * * *');
    for (const bad of ['24:00', '3', '03:60', 'noon']) assert.throws(() => e().dailyAt(bad), /invalid time/);
    assert.throws(() => e().hourlyAt(60), /invalid minute/);
    assert.throws(() => e().cron(''), /cron expression required/);
    const w = e().timezone('Asia/Jakarta').withoutOverlapping().name('nightly');
    assert.equal(w.tz, 'Asia/Jakarta');
    assert.equal(w.overlapping, false);
    assert.equal(w.description, 'nightly');
  });

  test('job() needs a Job subclass, call() a function', () => {
    const s = new Schedule();
    assert.throws(() => s.job(class X {}), /Job subclass/);
    assert.throws(() => s.call('x'), /function/);
    class Ping extends Job {}
    assert.equal(s.job(Ping).description, 'Ping');
    // a named function expression: its name becomes the description
    // eslint-disable-next-line prefer-arrow-callback
    assert.equal(s.call(function tidy() {}).description, 'tidy');
    assert.equal(s.call(() => {}).description, 'call #3');
  });
});

describe('loadSchedule', () => {
  test('accepts a function, an object or class with schedule(), or app/Console/Kernel.js', async () => {
    const fromFn = await loadSchedule((s) => { s.call(() => {}, 'a'); });
    assert.equal(fromFn.events.length, 1);
    const fromObj = await loadSchedule({ schedule(s) { s.call(() => {}, 'b').hourly(); } });
    assert.equal(fromObj.events[0].expression, '0 * * * *');
    class Kernel { schedule(s) { s.call(() => {}, 'c'); s.call(() => {}, 'd'); } }
    assert.equal((await loadSchedule(Kernel)).events.length, 2);
    const kernel = await loadSchedule();
    assert.deepEqual(kernel.events.map((e) => [e.description, e.expression]), [
      ['FixtureEchoJob', '0 3 * * *'],
      ['kernel-hourly', '0 * * * *'],
    ]);
    await assert.rejects(loadSchedule(42), /must be a function/);
  });
});

describe('runScheduleOnce', () => {
  test('runs the events due in the given minute (Kernel discovery, job dispatch)', async () => {
    const fake = fakeJobs();
    kernelCalls.length = 0;
    try {
      const at = new Date(2026, 0, 1, 3, 0, 42); // 03:00 local
      assert.deepEqual(await runScheduleOnce({ at }), ['FixtureEchoJob', 'kernel-hourly']);
      assert.deepEqual(fake.dispatched.map((d) => [d.job, d.payload]), [['FixtureEchoJob', { from: 'kernel' }]]);
      assert.deepEqual(kernelCalls, ['hourly']);
      assert.deepEqual(await runScheduleOnce({ at: new Date(2026, 0, 1, 3, 1) }), []);
      assert.deepEqual(await runScheduleOnce({ at: new Date(2026, 0, 1, 4, 0) }), ['kernel-hourly']);
    } finally {
      fake.restore();
    }
  });

  test('time zones: per event, or the scheduler default', async () => {
    const schedule = new Schedule();
    schedule.call(() => {}, 'jakarta').dailyAt('03:00').timezone('Asia/Jakarta'); // 20:00 UTC
    schedule.call(() => {}, 'default').dailyAt('03:00');
    const at = new Date('2026-01-01T20:00:00Z');
    assert.deepEqual(await runScheduleOnce({ schedule, at, timezone: 'UTC' }), ['jakarta']);
    assert.deepEqual(await runScheduleOnce({ schedule, at: new Date('2026-01-01T03:00:00Z'), timezone: 'UTC' }), ['default']);
    assert.deepEqual(await runScheduleOnce({ schedule, at, timezone: 'Asia/Jakarta' }), ['jakarta', 'default']);
  });

  test('invalid cron or time zone fails at start with the event name', async () => {
    const bad = new Schedule();
    bad.call(() => {}, 'broken').cron('61 * * * *');
    await assert.rejects(runScheduleOnce({ schedule: bad }), /"broken": invalid cron "61 \* \* \* \*"/);
    const tz = new Schedule();
    tz.call(() => {}, 'tz').timezone('Mars/Olympus');
    await assert.rejects(runScheduleOnce({ schedule: tz }), /"tz": invalid cron .* or time zone "Mars\/Olympus"/);
  });

  test('lock hook: falsy or throwing skips the run', async () => {
    const ran = [];
    const schedule = new Schedule();
    schedule.call(() => ran.push('a'), 'a');
    schedule.call(() => ran.push('b'), 'b');
    schedule.call(() => ran.push('c'), 'c');
    const seen = [];
    await runScheduleOnce({
      schedule,
      at: new Date('2026-01-01T00:00:10Z'),
      lock: (event, at) => {
        seen.push([event.description, at.toISOString()]);
        if (event.description === 'c') throw new Error('redis down');
        return event.description === 'a';
      },
    });
    assert.deepEqual(ran, ['a']);
    assert.deepEqual(seen.map((s) => s[1]), Array(3).fill('2026-01-01T00:00:00.000Z'));
  });
});

describe('startScheduler', () => {
  test('fires at due times, skips overlapping runs, logs task errors and stops', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-01-01T00:00:30Z') });
    let release;
    const gate = new Promise((r) => { release = r; });
    const runs = { slow: 0, fast: 0, boom: 0 };
    const schedule = new Schedule();
    schedule.call(async () => { runs.slow += 1; await gate; }, 'slow').everyMinute().withoutOverlapping();
    schedule.call(() => { runs.fast += 1; }, 'fast').everyMinute();
    schedule.call(() => { runs.boom += 1; throw new Error('boom'); }, 'boom').everyTwoMinutes();

    const scheduler = await startScheduler({ schedule, timezone: 'UTC' });
    assert.deepEqual(scheduler.events.map((e) => [e.name, e.nextRun.toISOString()]), [
      ['slow', '2026-01-01T00:01:00.000Z'],
      ['fast', '2026-01-01T00:01:00.000Z'],
      ['boom', '2026-01-01T00:02:00.000Z'],
    ]);

    t.mock.timers.tick(29_999);
    await flush();
    assert.deepEqual(runs, { slow: 0, fast: 0, boom: 0 });

    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(runs, { slow: 1, fast: 1, boom: 0 });
    assert.equal(scheduler.events[0].nextRun.toISOString(), '2026-01-01T00:02:00.000Z');

    t.mock.timers.tick(60_000); // slow is still running: skipped
    await flush();
    assert.deepEqual(runs, { slow: 1, fast: 2, boom: 1 });

    release();
    await flush();
    t.mock.timers.tick(60_000);
    await flush();
    assert.deepEqual(runs, { slow: 2, fast: 3, boom: 1 });

    await scheduler.stop();
    t.mock.timers.tick(10 * 60_000);
    await flush();
    assert.deepEqual(runs, { slow: 2, fast: 3, boom: 1 });
  });

  test('wakes at least every maxSleep and runs 6-field (seconds) expressions on real timers', async () => {
    const ticks = [];
    const schedule = new Schedule();
    schedule.call(() => ticks.push(Date.now()), 'every-second').cron('* * * * * *');
    const scheduler = await startScheduler({ schedule, maxSleep: 200 });
    await new Promise((r) => { setTimeout(r, 2300); });
    await scheduler.stop();
    assert.ok(ticks.length >= 2 && ticks.length <= 3, `ran ${ticks.length} times`);
  });
});
