import { FixtureEchoJob } from '../Jobs/index.js';

export const calls = [];

// the `schedule(schedule)` shape documented in the README
// eslint-disable-next-line no-shadow
export default function schedule(schedule) {
  schedule.job(FixtureEchoJob, { from: 'kernel' }).dailyAt('03:00');
  schedule.call(() => calls.push('hourly'), 'kernel-hourly').hourly();
}
