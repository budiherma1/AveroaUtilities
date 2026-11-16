// Type-level tests of the published declarations (`npm run typecheck`).
// Never executed: it only has to compile. `@ts-expect-error` lines must fail.
import {
  Model, Crud, FilterSearch, FilterSearchError, DB, getDB, isDBReady,
  Mail, startMailWorker, MailWorker, Queue, closeQueue,
  Job, JobTimeoutError, fakeJobs, exponentialBackoff, startJobWorker, retryFailedJobs,
  Schedule, ScheduledEvent, startScheduler, runScheduleOnce,
  View, Log, Fetch, fetchReady, Validator,
  validate, describeValidation, isStandardSchema, VALIDATE,
  createLogger, logSettings, logFormat, redact, REDACTED,
  requestContext, runWithContext, getContext, getRequestId, addLogContext,
  Gate, AccessGate, GateResponse, AuthorizationError, can,
  appRoot, appPath, appHas, importApp, importAppDefault, resetAppRoot,
} from '@averoa/utilities';
import type {
  ColumnMap, JobContext, HttpRequest, HttpResponse, NextFunction, Middleware, FilterSearchResult, Logger,
} from '@averoa/utilities';
import { appPath as appPathOnly } from '@averoa/utilities/paths';
import { getRequestId as requestIdOnly } from '@averoa/utilities/context';
import DefaultLog, { redactionMatcher } from '@averoa/utilities/Log';
import Auth, { AuthContext } from '@averoa/utilities/AuthSandbox.js';
import { configureQueue, publish } from '@averoa/utilities/Queue.js';
import { setTransporter, defaultMailQueue } from '@averoa/utilities/Mail.js';
import { databaseConfig, envDatabaseConfig } from '@averoa/utilities/DB.js';
import { loadJobs } from '@averoa/utilities/JobWorker.js';
import { MAX_DELAY, normaliseDelay, validateQueueName } from '@averoa/utilities/Job.js';
import { loadSchedule } from '@averoa/utilities/Schedule.js';
import { PublicError, errorResult } from '@averoa/utilities/FilterSearch.js';
import { z } from 'zod';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(): T => true as T;

declare const req: HttpRequest;
declare const res: HttpResponse;
declare const next: NextFunction;

/* ---------------------------------------------------------------- Model */

class Users extends Model {
  static tableName = 'users';
  static hidden = ['password'];
  static allowWithTrashed = true;

  static column: ColumnMap = {
    id: { migration: (m) => m.table.increments(m.column), flag: { required: false } },
    email: {
      migration: (m) => m.table.string(m.column, 100),
      seed: (f) => f.internet.email(),
      validation: [{ run: (v) => v.validator.isEmail(v.value), msg: 'email format required' }],
      flag: { required: true, unique: true },
    },
    password: { flag: { writable: true } },
  };

  id!: number;
  email!: string;
}

export async function models(): Promise<void> {
  await Users.migrationUp(DB);
  await Users.seeder(10, DB);
  await Users.seeder(DB);
  await Users.seederCustom(5, async () => ({ email: 'a@b.c' }), DB);
  const writable: string[] = Users.writableColumns();
  const dup: boolean = await Users.isDuplicate('email', 'a@b.c', 1);
  const check = Users.validation({ email: 'x' }, 'update');
  if (!check.status) {
    const message: string | string[] = check.data.message;
    void message;
  }
  await Users.validationRouter(req, res, next, { type: 'json', create: true });
  await Users.checkParamId(req, res, next);
  const rows = await Users.query().where('id', 1);
  const first: Users | undefined = rows[0];
  Users.search(Users.query(), 'term');
  void writable; void dup; void first;
}

/* ---------------------------------------------------- Crud, FilterSearch */

export async function crud(): Promise<void> {
  const created = await Crud.create(Users, { body: { email: 'a@b.c' }, user: { id: 1 } }, { insert: { role: 'member' } });
  if (created.status) {
    assertType<Equal<typeof created.data, Users>>();
  } else {
    const code: number = created.statusCode;
    void code;
  }

  const byName = await Crud.findOne('Users', { params: { id: '5' } });
  if (!byName.status) void byName.message;

  const list = await Crud.findAll(Users, req, { maxLimit: 200 });
  if ('draw' in list) void list.recordsTotal;
  else if (list.status) void list.metadata.page_total;

  const trx = await DB.transaction();
  await Crud.update(Users, req, { update: { verified: true } }, trx);
  await Crud.delete('Users', req, {}, trx);

  const filtered = await FilterSearch.model(Users, { query: { 'email:like': '%a%' } }, { limit: 5 });
  if (filtered.status) assertType<Equal<typeof filtered.data, Users[]>>();

  const report: FilterSearchResult<{ id: number }> = await FilterSearch.knex<{ id: number }>(
    DB('users as u').select('u.id'), req, { column: ['u.id'], maxLimit: 500 },
  );
  void report;

  // @ts-expect-error knex mode needs a column whitelist
  await FilterSearch.knex(DB('users'), req, {});

  const err = new FilterSearchError('bad filter');
  const code: number = err.statusCode;
  const safe = errorResult(new PublicError('Nope', 404));
  void code; void safe;
}

/* -------------------------------------------------------------------- DB */

export async function db(): Promise<void> {
  const knex = await getDB();
  const same = await DB.ready;
  const ready: boolean = isDBReady();
  await DB('users').where('id', 1).first();
  await DB.raw('select 1');
  const cfg = databaseConfig ?? envDatabaseConfig();
  void knex; void same; void ready; void cfg;
}

/* ---------------------------------------------------------- Mail, Queue */

export async function mail(): Promise<void> {
  const result = await Mail.init()
    .from('no-reply@example.test')
    .to(['a@example.test', { name: 'B', address: 'b@example.test' }])
    .subject('Hello')
    .html('emails/welcome', { name: 'A' })
    .text('Hello')
    .attachments([{ filename: 'a.txt', content: 'a' }])
    .queue()
    .send();
  if ('status' in result && result.status === 'queued') void result.channel;

  setTransporter({ sendMail: async () => ({ messageId: '1' }) });
  const queueName: string = await defaultMailQueue();
  const worker = await startMailWorker({ prefetch: 2, maxRetries: 1 });
  const tag: string = worker.consumerTag;
  await worker.stop();
  await MailWorker();

  configureQueue({ url: 'amqp://localhost', heartbeat: 10 });
  const ok: true = await Queue('reports', { id: 1 });
  await publish('reports', 'text', { headers: { a: 1 } });
  await closeQueue();
  void queueName; void tag; void ok;
}

/* ------------------------------------------------------ Jobs, Schedule */

class SendReportJob extends Job {
  static tries = 3;
  static backoff = [1000, 5000, 30000];
  static timeout = 60_000;

  async handle(payload: { reportId: number }, context: JobContext): Promise<string> {
    if (context.signal.aborted) return 'aborted';
    return `report ${payload.reportId} (attempt ${context.attempt}/${context.tries})`;
  }

  async failed(payload: { reportId: number }, error: unknown): Promise<void> {
    Log.error(`report ${payload.reportId} failed`, { error });
  }
}

export async function jobs(): Promise<void> {
  const dispatched = await SendReportJob.dispatch({ reportId: 1 }, { delay: 60_000 });
  const id: string = dispatched.id;
  await SendReportJob.dispatch({ reportId: 2 }, { delay: new Date(), queue: 'reports' });
  // @ts-expect-error the payload type comes from handle()
  await SendReportJob.dispatch({ reportId: 'one' });
  const value: string = await SendReportJob.dispatchSync({ reportId: 3 });

  const fake = fakeJobs();
  const recorded: number = fake.dispatched.length;
  fake.restore();

  const backoff: (retry: number) => number = exponentialBackoff(1000, 60_000);
  const worker = await startJobWorker({ jobs: [SendReportJob], concurrency: 4, backoff });
  const names: string[] = worker.jobs;
  await worker.stop();
  const moved: number = await retryFailedJobs({ queue: 'jobs', limit: 10 });
  const registry = await loadJobs({ SendReportJob });
  const timeout = new JobTimeoutError('SendReportJob', 1000);
  void id; void value; void recorded; void names; void moved; void registry; void timeout;
  void MAX_DELAY; void normaliseDelay(1500); void validateQueueName('jobs');

  const schedule = new Schedule();
  schedule.job(SendReportJob, { reportId: 1 }).dailyAt('03:00').timezone('Asia/Jakarta');
  schedule.call(() => undefined, 'cleanup').everyFiveMinutes().withoutOverlapping();
  const event: ScheduledEvent = schedule.events[0];
  const scheduler = await startScheduler({
    schedule: (s) => { s.call(async () => {}).hourly(); },
    lock: async (e, at) => Boolean(e.description && at),
  });
  void scheduler.events[0]?.nextRun;
  await scheduler.stop();
  const ran: string[] = await runScheduleOnce({ schedule, at: new Date() });
  await loadSchedule({ schedule(s) { s.call(() => 1).daily(); } });
  void event; void ran;
}

/* ------------------------------------------------------------ Validation */

export function validation(): Middleware[] {
  const login = validate({
    body: {
      email: { type: 'string', validation: [{ run: (v) => v.validator.isEmail(v.value), msg: 'email format required' }] },
      password: { type: 'string' },
      remember: { type: 'boolean', required: false, default: false },
      page: { type: 'integer', default: 1, validation: [{ run: (v) => v.raw >= 1, msg: 'must be >= 1' }] },
    },
  }, { status: 400 });

  const notes = validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({ text: z.string().min(1).max(500) }),
  });

  // @ts-expect-error unknown field type
  validate({ body: { a: { type: 'date' } } });

  const docs = describeValidation(login);
  const meta = login[VALIDATE];
  const standard: boolean = isStandardSchema(z.string());
  void docs; void meta; void standard;
  return [login, notes];
}

/* ------------------------------------------------------------------ Gate */

class Post { userId = 1; }
interface User { id: number; isAdmin: boolean }

class PostPolicy {
  update(user: User, post: Post) {
    return user.id === post.userId ? true : GateResponse.deny('Not your post');
  }
}

export async function gate(user: User, post: Post): Promise<void> {
  Gate.define('view-reports', (u: User) => u.isAdmin === true);
  Gate.policy(Post, PostPolicy);
  Gate.before((u) => (u?.isAdmin ? true : undefined));
  const allowed: boolean = await Gate.allows(user, 'update', post);
  const response: GateResponse = await Gate.authorize(user, 'update', post);
  await Gate.forUser(user).check(['update', 'delete'], post);

  const isolated = new AccessGate<User>().define('x', (u) => u.id > 0);
  // @ts-expect-error callbacks must return a boolean or a GateResponse
  isolated.define('y', () => 'yes');

  const mw: Middleware = can('update', async (r) => (r.params.id ? post : null), { gate: isolated });
  const plain: Middleware = can('create', Post);
  const error = new AuthorizationError('nope', 403, { ability: 'update' });
  const status: number = error.statusCode;
  void allowed; void response; void mw; void plain; void status;
}

/* ---------------------------------------------- Log, context, paths, ... */

export async function services(): Promise<void> {
  Log.info('started', { port: 3000 });
  Log.error(new Error('boom'));
  const child: Logger = DefaultLog.child({ module: 'test' });
  const custom = createLogger({ channel: 'stdout', format: 'pretty', redactKeys: ['ssn'] });
  custom.warn('x');
  const settings = logSettings({ LOG_LEVEL: 'debug' });
  const channel: 'stdout' | 'file' | 'both' | null = settings.channel;
  void logFormat({ format: 'json' });
  const masked = redact({ password: 'x' }, { keys: 'ssn' });
  const marker: '[REDACTED]' = REDACTED;
  const isSecret: boolean = redactionMatcher()('token');

  const requestId = runWithContext({ requestId: 'abc' }, () => getRequestId());
  const ctx = getContext();
  addLogContext({ userId: 1 });
  requestContext.run({ requestId: 'x' }, () => requestIdOnly());

  const root: string = appRoot();
  const file: string = appPath('config', 'database.js');
  const exists: boolean = appHas('config');
  const mod = await importApp<{ Users: typeof Users }>('app/Models/index.js');
  const users: typeof Users = mod.Users;
  const maybe = await importApp('config/x.js', { optional: true });
  const def = await importAppDefault<() => object>('config/x.js');
  resetAppRoot();
  void appPathOnly('x');

  await fetchReady;
  const response = await Fetch.get<{ ok: boolean }>('/health');
  const ok: boolean = response.data.ok;
  await Fetch.ready;

  const html: string = await View.render('welcome', { name: 'A' });
  const isEmail: boolean = Validator.isEmail('a@b.c');

  const auth = Auth(req);
  const current = auth.check() ? auth.user<User>() : null;
  const context: AuthContext = auth;
  await auth.logout();

  void child; void channel; void masked; void marker; void isSecret; void requestId; void ctx; void root;
  void file; void exists; void users; void maybe; void def; void ok; void html; void isEmail; void current; void context;
}
