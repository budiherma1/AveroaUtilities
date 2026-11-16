# Changelog

## Unreleased

### Added

- **TypeScript declarations.** Hand-written `.d.ts` files for every module (the runtime JavaScript is unchanged):
  `"types"` and a `types` condition in every `exports` entry, and a `./*.js` pattern so deep imports
  (`@averoa/utilities/Job.js`) are typed too. `req`/`res`/`next`, the logger, the nodemailer transporter and the AMQP
  objects are structural types, so neither `@types/express` nor `@types/node` is required by these declarations;
  `knex`, `objection`, `axios` and `edge.js` types come from those packages. `Job.dispatch()` / `dispatchSync()` take
  the payload type of the job's `handle()`, `Crud` and `FilterSearch.model()` results carry the model type.
- Development: ESLint 10 flat config (`npm run lint`), `npm run typecheck` (`tsc` over the declarations and
  `test/types/usage.ts`), a test that every `.d.ts` declares exactly its module's runtime exports, and both steps in
  CI.
- **Background jobs.** `Job` base class (`static queue`, `tries`, `backoff`, `timeout`, `jobName`; `handle(payload,
  context)`, optional `failed(payload, error, context)`), `MyJob.dispatch(payload, { delay, queue })` on the shared
  AMQP connection and confirm channel of `Queue`, `MyJob.dispatchSync(payload)` (in-process, no broker),
  `exponentialBackoff()`, `JobTimeoutError` and `fakeJobs()` for tests.
- **Delayed jobs without a broker plugin**: per-delay TTL queues (`<queue>.delay.<ms>`) that dead-letter into the job
  queue and expire when unused.
- **`startJobWorker({ jobs, queues, concurrency, tries, backoff, timeout })`**: runs jobs registered by name (passed in
  or discovered from `app/Jobs/index.js`), with retries and backoff, per-attempt timeouts (`context.signal` is
  aborted), a failed-jobs queue (`<queue>.failed`), graceful `stop()` and reconnect with exponential backoff.
  `retryFailedJobs({ queue, limit })` re-queues failed jobs.
- **Scheduler.** `Schedule` (`job()`, `call()`, `cron()`, `everyMinute()` ... `dailyAt()`, `weeklyOn()`, `monthlyOn()`,
  `timezone()`, `withoutOverlapping()`, `name()`), `startScheduler({ schedule, timezone, lock })` (default schedule:
  `app/Console/Kernel.js`) and `runScheduleOnce()` for system cron / Kubernetes CronJobs.
- New optional peer dependency `croner` ^10 (cron parsing, only loaded by the scheduler).
- New env vars: `JOBS_QUEUE` (default job queue, also `config/queue.js` `jobsQueue`), `SCHEDULE_TIMEZONE`.
- Authorization: `Gate` (the application's `AccessGate`) with `define(ability, callback)`, `policy(ModelClass,
  Policy)` (policy methods named after abilities plus an optional `before(user, ability)`), global `before` / `after`
  callbacks, and `allows` / `denies` / `check` / `any` / `inspect` / `authorize` / `forUser`. Checks fail closed
  (unknown abilities, missing policy methods, guests and non-`true` results deny). `authorize()` throws an
  `AuthorizationError` (`statusCode` 403, `expose: true`), so `errorResult()` and `@averoa/core`'s error handler
  answer 403. Callbacks may return a `GateResponse` (`allow()`, `deny(message, statusCode)`, `denyAsNotFound()`).
- `can(ability, resource?, options?)`: Express middleware for route middleware arrays. 401 JSON without a user, 404
  JSON when the resource loader finds nothing, 403 JSON (or the denial's status) when denied; the resource is kept on
  `res.locals.resource`.
- New root exports: `Gate`, `AccessGate`, `GateResponse`, `AuthorizationError`, `can`.
- **`validate(schemas, options?)`**: Express middleware that validates `body`, `query`, `params` and `headers` of
  routes that are not crud routes. Each section is a Standard Schema v1 validator (zod, valibot, arktype, ...) or an
  object of field definitions in the Model column style (`type`, `required`, `default`, `enum`,
  `validation: [{ run, msg }]`). Failures answer 422 `{ status: false, data: { column, message, in } }`, the
  `validationRouter` shape plus the section. The parsed output is in `req.validated.{body,query,params,headers}`;
  `req.body` is replaced with the parsed body (original in `req.bodyRaw`), the Express 5 `req.query` getter is left
  alone.
- **`describeValidation(fn)`**: JSON Schema of the sections a `validate()` middleware checks, for API documentation
  (field definitions always; Standard Schemas through `~standard.jsonSchema`, a `toJSONSchema()` method or the
  `toJSONSchema` / `jsonSchema` options).
- `isStandardSchema(value)` and the `VALIDATE` symbol.
- `zod` as a devDependency (tests only).

### Added (observability)

- **Request context.** New `context.js` (also `@averoa/utilities/context`): `requestContext` (`AsyncLocalStorage`,
  shared with `@averoa/core` through a global registered symbol), `runWithContext()`, `getContext()`,
  `getRequestId()` and `addLogContext()`.
- **Structured logging.** Every `Log` line has `timestamp`, `level`, `message` and, during a request, `requestId`
  (plus `addLogContext()` fields). `LOG_FORMAT=json|pretty` picks the console format (default `pretty` for
  `development` / `test`, `json` otherwise); the file is always JSON. Errors are logged with `message` and `stack`.
- **`LOG_CHANNEL=stdout|file|both`**: `stdout` writes no file (containers). Unset keeps the 2.0 behaviour (file, plus
  the console unless `NODE_ENV=production`).
- **Redaction.** Values of sensitive keys (authorization, cookie, password, secret, token, api key, csrf, ... at any
  depth) are logged as `[REDACTED]`, `Bearer` / `Basic` credentials inside strings are masked; `LOG_REDACT` adds keys.
  The logged objects are not modified.
- New exports `createLogger`, `logSettings`, `logFormat`, `redact`, `REDACTED` and the context helpers.

### Changed

- The console output of `Log` outside production is now the `pretty` format (with timestamp and request id) instead
  of winston's `simple` format; set `LOG_FORMAT=json` for JSON lines.

### Fixed (found by the new MySQL / PostgreSQL integration tests)

- **MySQL time zones.** Without `config/database.js`, `mysql`/`mysql2` connections now set the driver `timezone` and
  the session `time_zone` to the same value, from the new `DB_TIMEZONE` (default `Z`, i.e. UTC; `+07:00`-style
  offsets and `local` are accepted). Before, `created_at` (filled by MySQL) and `deleted_at` (written by `Crud` from a
  JS `Date`) could be stored in different zones. `DB_TIMEZONE=local` keeps the previous behaviour. `mysqlTimezone()` is
  exported from `DB.js`.
- **A value the database rejects is a 400 `Invalid value`**, not a 500 `Database error` (SQLSTATE class 22, e.g.
  `'abc'` for an integer column on PostgreSQL). `Crud.findOne`, `Crud.delete` and the `checkParamId` route hook answer 404
  for an id the database rejects, and `Model.isDuplicate` treats it as no match. `isDataError()` is exported from
  `FilterSearch.js`.
- **`:like` on MySQL** uses `like cast(? as binary)` instead of the deprecated `like binary ?`; `:ilike` and `:search`
  on MySQL use the column collation.
- **`:like`, `:ilike`, `:search` and `Model.search()` on PostgreSQL** cast the column to `text`, so numeric and date
  columns no longer fail with `operator does not exist`. `likeClause()` is exported from `FilterSearch.js`.
- **`groupBy`** selects only the grouped column (other columns are invalid SQL on PostgreSQL and on MySQL with
  `ONLY_FULL_GROUP_BY`). `$select` and `orderBy` may only name that column and `$relations` cannot be combined with
  it (400).

### Added

- `npm run test:integration` (MySQL / PostgreSQL, skipped without `AVEROA_TEST_MYSQL_URL` / `AVEROA_TEST_PG_URL`) and
  GitHub Actions workflows for CI and tag-triggered npm releases.

## 2.0.2

### Fixed

- `?$datatable=0` (or `false`) no longer enables DataTables mode. Only `1`, `true`, `yes`, `on` (any case) or a
  boolean `true` enable it; `$datatable` and `$draw` are never passed to the filters.
- `Crud.findAll` resolves `{ status: false, message, statusCode }` for an unknown model name (it rejected), like the
  other `Crud` methods.
- `col:in` / `col:btwn` reject object values (`?id:in[a]=1` became `"[object Object]"`) and arrays that hold anything
  but strings, with `invalid value for <key>` (400). `$select` objects are rejected as `invalid $select`.
- `Model.validation()` in create mode only requires `writableColumns()`: the primary key (unless `flag.fillable`) and
  hidden columns that are not `flag.writable` are no longer required, matching `validationRouter`.
- Knex-mode soft delete qualifies `deleted_at` with the base table (`config.table`, or the builder's single `FROM`
  table / alias), so builders that join other tables with `deleted_at` no longer fail as ambiguous. Raw or subquery
  `FROM`s keep the unqualified name. New `table` option for `FilterSearch.knex`.
- Without `config/database.js`, `DB_CLIENT=sqlite3` / `better-sqlite3` builds
  `{ filename: DB_NAME || ':memory:' }` with `useNullAsDefault: true` (it built an unusable host/port connection).
- `Crud.update` with uploads reads the current row with the transaction (`Model.query(trx)`), not outside it.
- `option.update` on `Crud.update` / `Crud.delete` can no longer overwrite `created_by` / `created_at`
  (`option.insert` on `create` still may set them).
- A relative SQLite `DB_NAME` in the env fallback is resolved against the app root (not the process cwd), matching `@averoa/core`'s knexfile, so the app and the migrate/seed scripts always open the same file. New export `sqliteFilename()` from `DB.js`.

### Changed

- Error results from `Crud` and `FilterSearch` include `statusCode`: `FilterSearchError` 400, Objection
  `ValidationError` 422, `NotFoundError` 404, `PublicError` / `expose` errors their own code, database and other
  errors 500 (`FilterSearch.knex` without `column` too). Controllers can send
  `res.status(result.statusCode ?? 200)`. The rest of the `{ status: false, message }` shape is unchanged; success
  results have no `statusCode`.
- `Crud.findOne` resolves `{ status: false, message: "ID <id> doesn't exist", statusCode: 404 }` for a missing or
  soft-deleted id (it resolved `{ status: true, data: null }`), so callers outside the `crud()` route hooks get a 404
  too. `Crud.update` / `Crud.delete` resolve the same result when no live row matched (they resolved a bare
  `{ status: false }`).

## 2.0.1

### Security

- Upgrade `nodemailer` from ^6.9 to ^10.3.1. Every 6.x release is affected by published advisories (SMTP command injection, recipient-domain allow-list bypasses, address-parser DoS, file/URL access bypasses).
- Optional peer `@faker-js/faker` now requires >=10.5.0 (versions <=10.4.0 have a code-execution advisory in `helpers.fake`). Seeds must use the faker 10 API (`f.person.*`, `f.number.int`, ...).

### Changed

- `engines.node` is now >=20 (required by nodemailer 10). Node 18 is end-of-life.

## 2.0.0

Requires Node >= 18.17, ESM only. Peer dependencies: `knex ^3`, `objection ^3`, `edge.js ^5`
(and optionally `@faker-js/faker` for seeders) — install them in the app.

### Breaking changes

- **No more `./../../../` imports.** App files are found through `@averoa/utilities/paths`
  (`AVEROA_ROOT` env, or the nearest `package.json` above `cwd`). Missing `config/*.js` files
  fall back to env (`DB_*`, `MAIL_*`, `RABBITMQ_SERVER`, `FETCH_BASE_URL`/`FETCH_TIMEOUT`).
  `config/*.js` may export an object or a function `(process) => object`.
- **HTTP status codes in crud middleware.** `validationRouter` responds **422**
  `{ status:false, data:{ column, message } }`; `checkParamId` responds **404**
  `{ status:false, message }` (it used to be 200 for both).
- **Soft delete is enforced** for every model with `timestamp !== false`: listing, `findOne`,
  `checkParamId`, `update`, `delete`, unique checks and fetched relations ignore rows with
  `deleted_at` set. `$withTrashed=1` only works when the model sets `static allowWithTrashed = true`.
  `Crud.delete` hard-deletes models with `timestamp: false`.
- **`static hidden = []`** on models: hidden columns are stripped from JSON, cannot be used in
  `$select`, filters or `orderBy`, and are not writable from requests (crud routes or a raw
  `req.body`) unless flagged `writable: true`.
- **`$select`** only accepts the model's columns (+ timestamp columns) minus hidden; anything else
  returns `{ status:false, message }`.
- **`$relations`** is validated against `static allowGraph` (default: the model's own
  `relationMappings` keys, depth 1). Models without relations reject `$relations`.
- **Filters are strict where it matters:** `col:op` filters on unknown/hidden columns, unknown
  operators on known columns, non-scalar values and invalid `limit`/`page` return
  `{ status:false, message }`. Query keys that are not filters at all (`_`, `utm_*`, DataTables'
  `draw`/`columns[...]`, a bare hidden column such as `?password=x`) are ignored, never applied.
  `orderBy`/`groupBy` only accept the model's own columns.
- **`limit`** is capped by `config.maxLimit` (default 1000); `limit=0` means "all, up to maxLimit".
  `limit` must be an integer >= 0 and `page` an integer >= 1.
- **`:like`** is parameterized (`?? like binary ?` on MySQL, `like` elsewhere); `:ilike` uses
  `ilike` on PostgreSQL. `:search` uses `ilike` on PostgreSQL.
- **`$relations-type=join`** now paginates on root rows (not joined rows) and counts correctly.
- **Crud:** `create`/`update` from a raw `req.body` only write known, non-hidden model columns
  (no primary key, no `created_*`/`updated_*`/`deleted_*`). `req.dataReq` is still trusted.
  `update` never overwrites `created_by`/`created_at` and sets `updated_at`/`updated_by`.
  `delete` stores a correct 24h timestamp (`new Date()`, was `moment().format('hh')`) and sets
  `deleted_by`. Models are loaded from `app/Models/index.js` (no more `@averoa/models`).
  `moment` is no longer a dependency.
- **`validationRouter`** strips the primary key (unless `flag.fillable: true`), audit columns and
  hidden columns (unless `flag.writable: true`) from `req.body`; upload columns are required only on create; `req.body` may be undefined.
- **Queue:** one lazy AMQP connection + confirm channel (was a new connection per message),
  durable queues, persistent messages; `Queue()` now resolves after the broker confirm.
  New `closeQueue()`, `configureQueue()`.
- **MailWorker:** the demo that sent 3 fake mails is gone. Default export / `startMailWorker({ queue,
  prefetch, maxRetries, transporter })` consumes the mail queue and returns `{ stop() }`.
- **Mail:** one shared transporter; `.queue()` with no name uses `config/mail.js` `queue`,
  env `MAIL_QUEUE`, or `'mail'`; `send()` awaits the enqueue. View render errors are logged and
  thrown (they used to be swallowed). Strings containing `<` are used as raw HTML.
- **Model seeders** load `@faker-js/faker` lazily; `seederCustom` no longer opens a second knex
  pool. `migrationUp` only uses `ON UPDATE CURRENT_TIMESTAMP` on MySQL.
- **AuthSandbox** is a per-request factory `Auth(req)` (was a shared singleton that leaked
  `req` between concurrent requests).
- **View** is the single Edge instance (mounted at `<app>/resources/views`, cache on in production).
- **Log** writes to `<app>/storages/logs/averoa.log` (created if missing); level from `LOG_LEVEL`.

### Fixes from the v2 review (still 2.0.0)

- **Config files must not import the root package.** `config/database.js` / `config/fetch.js`
  that `import ... from '@averoa/utilities'` used to deadlock the top-level await in `DB.js` /
  `Fetch.js` (node exited with code 13 and no message). Import helpers from
  **`@averoa/utilities/paths`** in config files. It no longer hangs either way:
  - no `config/database.js` → `DB` is built synchronously from env;
  - a config that imports the root package → loaded lazily, with a warning;
  - any other config → awaited at import time as before, for at most 2 s
    (`AVEROA_CONFIG_WAIT_MS`), then loading continues in the background.
  `DB` is now a callable proxy over the knex instance (`DB('t')`, `DB.raw`, `DB.transaction`,
  `Model.knex(DB)` keep working). New `getDB()` / `DB.ready` (resolve to the knex instance) and
  `isDBReady()`; code that can run before the config has loaded should `await getDB()`.
  `databaseConfig` is now a live binding (`null` until loaded). `Fetch` loads `config/fetch.js`
  in the background; requests made before that wait for it (`Fetch.ready`, `fetchReady`).
- **No SQL in error responses.** `Crud.*` and `FilterSearch.model/knex` return
  `{ status:false, message:'Database error' }` (or `'Internal error'`) instead of the driver
  message, which contained the interpolated SQL and values (e.g. password hashes). The full error
  is logged with `Log.error`. Filter (`FilterSearchError`), Objection validation and `PublicError`
  messages are still returned.
- **`$relations-type=join`** uses a LEFT JOIN (as in 1.x) for counting/filtering, and soft-deleted
  related rows are excluded inside the join: they can't be matched by `relation.col` filters and
  parents without live children are kept.
- **`FilterSearch.knex`** counts on a copy of the builder without its `select`/`orderBy` (valid
  SQL on PostgreSQL and MySQL `ONLY_FULL_GROUP_BY`), and accepts qualified whitelist columns
  (`column: ['u.id', 'p.title']`, `?u.id:eq=1`).
- **`Crud.findAll(model, req, option)`** passes `option` (`maxLimit`, `limit`, `page`) on:
  `Model.filterSearch(req, config)` now takes the FilterSearch config.
- **Objects/arrays are rejected** by `validationRouter` (422 `must be a scalar value`) and
  `Model.validation` unless the column has `flag: { json: true }`; validators of json columns get
  `JSON.stringify(value)`.
- **Hidden columns are not writable from requests** — through crud routes (`validationRouter` drops
  them from `req.body`) or a raw body (`Crud.create/update`) — unless the column has
  `flag: { writable: true }`. To accept a password from clients, either mark the column
  `writable: true` (its validators and `required` then apply; hash it in `$beforeInsert` /
  `$beforeUpdate`), or set it yourself in app code via `req.dataReq` / the model.
- **MailWorker** survives broker restarts: it listens to channel and connection `close`/`error`
  (a channel error no longer crashes the process) and re-creates the consumer with exponential
  backoff (`reconnectDelay` 1000 ms doubling to `maxReconnectDelay` 30000 ms); `stop()` cancels
  pending reconnects. The ack after a successful send is outside the send `try`: an ack failure is
  logged and never re-publishes the mail (no duplicate). `consumerTag` reflects the current consumer.
- `npm test` runs `test/*.test.js` only (fixtures are no longer executed as tests).

### Added

- `index.js` exports `appRoot, appPath, appHas, importApp, importAppDefault, resetAppRoot`,
  `startMailWorker`, `MailWorker`, `closeQueue`, `FilterSearchError`, `getDB`, `isDBReady`,
  `fetchReady`. `FilterSearch.js` also exports `PublicError`, `errorResult`, `leftJoinRelations`.
- `package.json` `exports`: `.`, `./paths`, `./*` (old deep imports keep working).
- Tests (`npm test`, node:test + better-sqlite3).
