import { Job } from '../../../../../Job.js';

export const handled = [];

export class FixtureEchoJob extends Job {
  async handle(payload, context) {
    handled.push({ payload, attempt: context.attempt });
    return payload;
  }
}

export class FixtureReportJob extends Job {
  static jobName = 'reports.build';

  static queue = 'reports';

  async handle(payload) {
    handled.push({ report: payload });
  }
}

// not a Job subclass: ignored by discovery
export const helper = () => 'not a job';
export default { notAJob: true };
