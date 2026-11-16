<div align="center">

<h1>@averoa/utilities</h1>

<p>The data and services layer of AveroaJS: self-describing Objection models, one-line CRUD, a query-string filter language, and shared DB, mail, queue, view, log and HTTP clients.</p>

<p>
  <a href="https://www.npmjs.com/package/@averoa/utilities"><img src="https://img.shields.io/npm/v/@averoa/utilities" alt="npm version"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933" alt="Node.js >= 20">
  <a href="https://github.com/budiherma1/averoajs"><img src="https://img.shields.io/badge/part%20of-AveroaJS-6f42c1" alt="Part of AveroaJS"></a>
</p>

</div>

## Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Exports](#exports)
- [TypeScript](#typescript)
- [Application files](#application-files)
- [Model](#model)
- [Crud](#crud)
- [FilterSearch](#filtersearch)
- [Request validation](#request-validation)
- [DB](#db)
- [Mail and the mail worker](#mail-and-the-mail-worker)
- [Queue](#queue)
- [Jobs and the scheduler](#jobs-and-the-scheduler)
- [View, Log, Fetch and Validator](#view-log-fetch-and-validator)
- [AuthSandbox](#authsandbox)
- [Authorization (Gate)](#authorization-gate)
- [Path helpers](#path-helpers)
- [Configuration](#configuration)
- [Security notes](#security-notes)
- [Testing](#testing)
- [Upgrading](#upgrading)
- [Related packages](#related-packages)
- [Contributing](#contributing)
- [License](#license)

## Overview

`@averoa/utilities` is the package an AveroaJS application imports for everything below the HTTP layer:

- **`Model`**: an [Objection](https://vincit.github.io/objection.js/) model whose `static column` map drives
  migrations, seeders and request validation, with hidden columns, soft delete and a relation whitelist.
- **`Crud`**: `create`, `findAll`, `findOne`, `update` and `delete` for a model in one call each, with
  mass-assignment protection and audit columns.
- **`FilterSearch`**: a query-string filter language (`?saldo:gte=1000&orderByDesc=id&$relations=[rooms]`) checked
  against the model's columns, with pagination metadata.
- **`validate()`**: request validation middleware for non-model input (body, query, params, headers) with any
  Standard Schema validator (zod, valibot, arktype) or Model-style field definitions.
- **Jobs**: `Job` classes dispatched to RabbitMQ (with delays, retries, backoff and timeouts), a job worker and a
  cron `Schedule`.
- **Services**: `DB` (the app's knex instance), `Mail` and a mail queue worker, `Queue` (RabbitMQ), `View` (Edge),
  `Log` (winston), `Fetch` (axios), `Validator` (validator.js), a per-request auth helper and app-root path helpers.

The package finds the application through its root directory (see [Path helpers](#path-helpers)), reads optional
`config/*.js` files from it and falls back to environment variables when they are missing.

Most applications get it through the [AveroaJS boilerplate](https://github.com/budiherma1/averoajs), where
[`@averoa/core`](https://github.com/budiherma1/AveroaCore) binds the models to the database and uses `View` as the
Express render engine, and [`@averoa/routes`](https://github.com/budiherma1/AveroaRoute) attaches the model's
validation hooks to `crud()` routes. This page is the reference for the package itself.

## Installation

```bash
npm install @averoa/utilities knex objection edge.js mysql2
npm install --save-dev @faker-js/faker   # only needed for seeders
```

| Requirement | Version |
| --- | --- |
| Node.js | `>= 20` |
| Module format | ESM only (`import`) |
| Peer: `knex` | `^3.0.0` |
| Peer: `objection` | `^3.0.0` |
| Peer: `edge.js` | `^5.0.0` |
| Optional peer: `@faker-js/faker` | `>= 10.5.0` (seeders only) |
| Optional peer: `croner` | `^10.0.0` (the scheduler only) |
| Database driver | the one your knex client needs: `mysql2` (the default client), `pg`, `better-sqlite3`, ... |

`amqplib`, `axios`, `nodemailer`, `validator` and `winston` are regular dependencies and are installed for you.
RabbitMQ is only contacted when you publish to a queue, dispatch a job or start a worker.

## Quick start

A model, its migration and a controller that exposes it:

```js
// app/Models/Users.js
import { Model } from '@averoa/utilities';
import Posts from './Posts.js';

export default class Users extends Model {
  static tableName = 'users';
  static timestamp = true;            // audit columns + soft delete (the default)
  static hidden = ['password'];       // never serialized, selectable, filterable or orderable

  static column = {
    id: {
      migration: (m) => m.table.increments(m.column).primary(),
      flag: { required: false },
    },
    name: {
      migration: (m) => m.table.string(m.column, 50),
      seed: (f) => f.person.firstName(),
      flag: { required: true },
    },
    email: {
      migration: (m) => m.table.string(m.column, 100),
      seed: (f) => f.internet.email(),
      validation: [{ run: (v) => v.validator.isEmail(v.value), msg: 'email format required' }],
      flag: { required: true, unique: true },
    },
    password: {
      migration: (m) => m.table.string(m.column, 100),
      flag: { required: false },
    },
  };

  static relationMappings = () => ({
    posts: { relation: Model.HasManyRelation, modelClass: Posts, join: { from: 'users.id', to: 'posts.user_id' } },
  });
}
```

```js
// app/Models/index.js — Crud resolves model names from here
export { default as Users } from './Users.js';
export { default as Posts } from './Posts.js';
```

```js
// database/migrations/20240101000000_users.js
import { Users } from '#models'; // package.json "imports": { "#models": "./app/Models/index.js" }

export const up = Users.migrationUp.bind(Users);
export const down = Users.migrationDown.bind(Users);
```

```js
// app/Controllers/UserController.js
import { Crud } from '@averoa/utilities';

export default class UserController {
  async findAll(req, res) { res.json(await Crud.findAll('Users', req)); }
  async findOne(req, res) { res.json(await Crud.findOne('Users', req)); }
  async create(req, res)  { res.json(await Crud.create('Users', req)); }
  async update(req, res)  { res.json(await Crud.update('Users', req)); }
  async delete(req, res)  { res.json(await Crud.delete('Users', req)); }
}
```

Bind the models to the database once at startup. `@averoa/core` does this for you; elsewhere (scripts, tests):

```js
import { Model, getDB } from '@averoa/utilities';

Model.knex(await getDB());
```

With [`@averoa/routes`](https://github.com/budiherma1/AveroaRoute), `crud()` attaches the model's validation hooks
to the routes:

```js
// routes/api.js
router.crud('Users', 'users', () => {
  router.get('/', 'UserController@findAll');
  router.get('/:id', 'UserController@findOne');
  router.post('/', 'UserController@create');
  router.put('/:id', 'UserController@update');
  router.delete('/:id', 'UserController@delete');
});
```

A client can then call `GET /api/users?name:like=A%25&orderByDesc=id&limit=20&$relations=posts` (`@averoa/core`
mounts `routes/api.js` under `/api`).

## Exports

```js
import {
  Model, Crud, FilterSearch, FilterSearchError,
  DB, getDB, isDBReady,
  Mail, MailWorker, startMailWorker, Queue, closeQueue,
  Job, JobTimeoutError, fakeJobs, exponentialBackoff, startJobWorker, retryFailedJobs,
  Schedule, ScheduledEvent, startScheduler, runScheduleOnce,
  View, Log, Fetch, fetchReady, Validator,
  validate, describeValidation, isStandardSchema, VALIDATE,
  createLogger, logSettings, logFormat, redact, REDACTED,
  requestContext, runWithContext, getContext, getRequestId, addLogContext,
  Gate, AccessGate, GateResponse, AuthorizationError, can,
  appRoot, appPath, appHas, importApp, importAppDefault, resetAppRoot,
} from '@averoa/utilities';

import { appPath } from '@averoa/utilities/paths';         // path helpers only, safe in config files
import { getRequestId } from '@averoa/utilities/context';   // request context only (Node built-ins)
import Auth from '@averoa/utilities/AuthSandbox.js';        // per-request auth helper
```

| Export | Description |
| --- | --- |
| `Model` | Objection `Model` subclass with column definitions, migrations, seeders, validation hooks, hidden columns and soft delete. |
| `Crud` | Static `create`, `findAll`, `findOne`, `update`, `delete` for a model name or class. |
| `FilterSearch` | `FilterSearch.model(Model, req, config?)` and `FilterSearch.knex(builder, req, config)`. |
| `FilterSearchError` | Error class for invalid client filters; its message is safe to return to clients. |
| `DB` | Callable proxy over the application's knex instance (`DB('users')`, `DB.raw()`, `DB.transaction()`). |
| `getDB()` | Promise of the knex instance once `config/database.js` has loaded. Same promise as `DB.ready`. |
| `isDBReady()` | `true` once the knex instance exists. |
| `Mail` | Fluent nodemailer message builder; sends directly or through the mail queue. |
| `startMailWorker(options?)` | Consumes the mail queue and sends each message. Resolves to `{ queue, consumerTag, stop() }`. |
| `MailWorker` | The same function as `startMailWorker` (kept for the default-export style). |
| `Queue(name, data, options?)` | Publishes a persistent message to a durable RabbitMQ queue and waits for the broker confirm. |
| `closeQueue()` | Closes the shared AMQP channel and connection. |
| `Job` | Base class for background jobs: `dispatch()`, `dispatchSync()`, `handle()`, `failed()`. See [Jobs and the scheduler](#jobs-and-the-scheduler). |
| `JobTimeoutError` | Error of an attempt that ran longer than the job's `timeout`. |
| `fakeJobs()` | Makes `dispatch()` record instead of publish (tests). Returns `{ dispatched, restore() }`. |
| `exponentialBackoff(base?, max?)` | Backoff function for `static backoff`. |
| `startJobWorker(options?)` | Consumes job queues and runs the jobs. Resolves to `{ queues, jobs, consumerTags, stop() }`. |
| `retryFailedJobs(options?)` | Moves failed job records back to their queue. |
| `Schedule`, `ScheduledEvent` | Scheduled task definitions. |
| `startScheduler(options?)` | Runs a schedule until `stop()`. Needs the optional peer `croner`. |
| `runScheduleOnce(options?)` | Runs the events due in the current minute once. |
| `View` | The application's single Edge instance, mounted at `<app>/resources/views`. |
| `Log` | winston logger: JSON lines to `<app>/storages/logs/averoa.log` and/or the console, with `requestId` and redaction. See [Log](#log). |
| `createLogger(options?)`, `logSettings(env?)`, `logFormat(options?)` | Build another logger / read the logging settings / the format chain `Log` uses. |
| `redact(value, { keys? })`, `REDACTED` | Redacted deep copy of a value, and the replacement string `'[REDACTED]'`. |
| `requestContext`, `runWithContext(ctx, fn)`, `getContext()`, `getRequestId()`, `addLogContext(fields)` | The per-request `AsyncLocalStorage` context that `@averoa/core` opens for every request. |
| `Fetch` | axios instance configured from `config/fetch.js` or env. |
| `fetchReady` | Promise that settles once `config/fetch.js` has been applied. Same as `Fetch.ready`. |
| `Validator` | The [validator](https://www.npmjs.com/package/validator) package. |
| `validate(schemas, options?)` | Express middleware that validates `body`, `query`, `params` and `headers` with a Standard Schema validator (zod, valibot, arktype, ...) or Model-style field definitions. See [Request validation](#request-validation). |
| `describeValidation(fn)` | JSON Schema of the sections a `validate()` middleware checks (used for OpenAPI generation), or `null`. |
| `isStandardSchema(value)` | `true` for an object implementing [Standard Schema v1](https://standardschema.dev) (`~standard`). |
| `VALIDATE` | `Symbol.for('averoa.validate')`, the property holding `{ schemas, options }` on a `validate()` middleware. |
| `Gate` | The application's authorization gate (an `AccessGate`): abilities, model policies, `allows` / `denies` / `authorize`. |
| `AccessGate` | The gate class, for an isolated gate (tests, multi-tenant setups). |
| `GateResponse` | Optional result of an ability or policy method: `allow()`, `deny(message, statusCode)`, `denyAsNotFound()`. |
| `AuthorizationError` | Thrown by `authorize()`: `statusCode` 403 (or the denial's own), `expose: true`. |
| `can(ability, resource?, options?)` | Express middleware: 401 without a user, 403 when denied, 404 when the resource loader finds nothing. |
| `appRoot`, `appPath`, `appHas`, `importApp`, `importAppDefault`, `resetAppRoot` | App-root helpers, also available from `@averoa/utilities/paths`. |

The `exports` map also allows deep imports of any module file (`@averoa/utilities/<File>.js`). Named exports that
are not re-exported from the root but are useful in tests or custom setups:

| Module | Named exports |
| --- | --- |
| `AuthSandbox.js` | `default` (`Auth(req)`), `AuthContext` |
| `Queue.js` | `configureQueue({ url, heartbeat, driver })`, `publish`, `getConnection`, `getChannel` |
| `Job.js` | `defaultJobQueue`, `resetJobConfig`, `validateQueueName`, `isJobClass`, `jobNameOf`, `normaliseDelay`, `backoffDelay`, `sendJob`, `failedQueueOf`, `MAX_DELAY` |
| `JobWorker.js` | `loadJobs` |
| `Schedule.js` | `loadSchedule` |
| `Mail.js` | `setTransporter`, `getTransporter`, `loadMailConfig`, `defaultMailQueue`, `envMailConfig` |
| `DB.js` | `databaseConfig` (live binding, `null` until loaded), `envDatabaseConfig`, `configImportsRoot` |
| `Fetch.js` | `envFetchConfig` |
| `FilterSearch.js` | `PublicError`, `errorResult`, `leftJoinRelations` |
| `Log.js` | `contextFormat`, `redactFormat`, `redactionMatcher`, `DEFAULT_REDACT_KEYS` |

## TypeScript

The package is plain JavaScript and ships hand-written declaration files (`*.d.ts`), so TypeScript and editors type
the root package, the `paths`, `context` and `Log` entry points and every deep import (`@averoa/utilities/Job.js`)
without extra packages. Use `"moduleResolution": "nodenext"` (or `"bundler"`).

```ts
import { Model, Crud, Job, validate, Gate } from '@averoa/utilities';
import type { ColumnMap, JobContext, Middleware } from '@averoa/utilities';

class Users extends Model {
  static tableName = 'users';
  static column: ColumnMap = {               // annotate it, so the callbacks are typed
    email: { flag: { unique: true }, validation: [{ run: (v) => v.validator.isEmail(v.value), msg: 'invalid' }] },
  };
}

class SendReportJob extends Job {
  async handle(payload: { reportId: number }, context: JobContext) { /* ... */ }
}
await SendReportJob.dispatch({ reportId: 1 });      // the payload type comes from handle()
const result = await Crud.findOne(Users, req);      // { status: true, data: Users } | { status: false, message, statusCode }
```

- `req`, `res` and `next` are typed with small structural types (`RequestLike`, `HttpRequest`, `HttpResponse`,
  `NextFunction`, `Middleware`) that Express 4 and 5 objects satisfy, so `@types/express` is not needed. Properties
  this package adds to `req` (`req.validated`, `req.dataReq`, ...) are on these types, not on Express' `Request`.
- `DB`, `Model` and `Crud` use the types that `knex` and `objection` ship (which need `@types/node`); `Fetch` is an
  axios instance and `View` an Edge instance. `Log` (a winston logger), the nodemailer transporter, the AMQP
  connection and `Validator` are typed structurally with the members this package documents; install
  `@types/validator` and import `validator` yourself if you need every validator.js function typed.


All of these are optional. Each `config/*.js` file may export an object or a function `(process) => object`; when
the file is missing (or exports nothing) the environment fallback applies.

| File | Used by | Fallback |
| --- | --- | --- |
| `config/database.js` (knex config) | `DB` | `DB_CLIENT`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME` |
| `config/mail.js` (nodemailer transport options, plus `queue`) | `Mail`, `startMailWorker` | `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_QUEUE` |
| `config/queue.js` (`{ amqp, heartbeat, jobsQueue }`) | `Queue`, `startMailWorker`, `Job`, `startJobWorker` | `RABBITMQ_SERVER`, `JOBS_QUEUE` |
| `config/fetch.js` (axios request config) | `Fetch` | `FETCH_BASE_URL`, `FETCH_TIMEOUT` |
| `app/Models/index.js` (named model exports) | `Crud` (model names) | none: required when you pass names |
| `app/Providers/index.js` (`UploadProvider`) | `Crud` uploads | none: required when a request carries upload files |
| `app/Jobs/index.js` (named `Job` subclass exports) | `startJobWorker()` without `jobs` | none: pass `jobs` instead |
| `app/Console/Kernel.js` (default export: the schedule) | `startScheduler()` / `runScheduleOnce()` without `schedule` | none: pass `schedule` instead |
| `resources/views/**/*.edge` | `View`, `Mail.html()` | none |
| `storages/logs/` | `Log` | created when missing (not with `LOG_CHANNEL=stdout`) |

> **Config files must import helpers from `@averoa/utilities/paths`, never from `@averoa/utilities`.** The root
> package loads `config/database.js` while it is itself being imported, so a config file that imports the root
> package creates an import cycle. Since 2.0.0 the cycle no longer hangs (see [DB](#db)), but the database is then
> initialised lazily and a warning is printed.

## Model

`Model` extends Objection's `Model`. Everything Objection offers (`query()`, `relationMappings`, `$beforeInsert`,
transactions, ...) works as usual; this package adds the following static properties and methods.

### Static properties

| Property | Default | Description |
| --- | --- | --- |
| `tableName` | — | Table name (Objection). |
| `idColumn` | `'id'` | Primary key (Objection). |
| `column` | — | Column definitions, keyed by column name. See below. |
| `timestamp` | `undefined` (enabled) | Anything except `false` adds the audit columns and turns on soft delete. |
| `hidden` | `[]` | Columns removed from JSON output and refused in `$select`, filters, `orderBy` and `groupBy`. They are not writable from requests unless flagged `writable: true`. |
| `allowGraph` | `undefined` | Relation expression clients may request with `$relations`. `undefined`: the model's own `relationMappings` keys, depth 1. `false` or `''`: no relations. |
| `allowWithTrashed` | `false` | `true` lets clients include soft-deleted rows with `$withTrashed=1`. |

### Column definitions

```js
static column = {
  email: {
    migration: (m) => m.table.string(m.column, 100),
    seed: (f) => f.internet.email(),
    validation: [{ run: (v) => v.validator.isEmail(v.value), msg: 'email format required' }],
    flag: { required: true, unique: true },
  },
};
```

| Key | Signature | Used by |
| --- | --- | --- |
| `migration` | `({ table, knex, column }) => void` | `migrationUp()`. `table` is the knex table builder, `column` the column name. |
| `seed` | `(faker) => value` | `seeder()` and `seederCustom()`. Columns without `seed` are left to their database default. |
| `validation` | `[{ run: ({ validator, value }) => boolean, msg }]` | `validationRouter` and `validation()`. `run` returning a falsy value adds `msg` to the errors. `value` is always a string (`String(value)`, or `JSON.stringify(value)` for `json` columns); `validator` is validator.js. |
| `flag` | object | See the flag table. |

### Flags

| Flag | Default | Effect |
| --- | --- | --- |
| `required` | `true` | On create, the value must be present and not `''`, `null` or `undefined`. On update, it is only checked when the key is sent, and then may not be empty. Set `required: false` on the primary key. |
| `unique` | `false` | `validationRouter` rejects a value that already exists in a non-soft-deleted row (excluding `req.params.id` on update) with `duplicate value <value>`. |
| `upload` | `false` | The value comes from an uploaded file (`req.files`, field name = column name) instead of the body. When `required`, the file is only required on create. Uploads are stored by `Crud` through the app's `UploadProvider`. |
| `json` | `false` | Allows objects and arrays. Without it, `validationRouter` and `validation()` reject them with `must be a scalar value`. |
| `fillable` | `false` | Lets clients write the primary key. Without it the primary key is stripped from request bodies. |
| `writable` | `false` | Lets clients write a column listed in `static hidden` (for example a password that `$beforeInsert` hashes). Its `required` flag and validators then apply. |
| `search` | `true` | `false` excludes the column from the `Model.search()` helper. It does not affect the `:search` query operator. |

### Timestamps and soft delete

With `timestamp !== false`:

- `migrationUp()` adds `created_at` (default now), `created_by`, `updated_at`, `updated_by`, `deleted_at` and
  `deleted_by`. On MySQL `updated_at` also gets `ON UPDATE CURRENT_TIMESTAMP`; other databases get a plain default.
- Every read through this package ignores rows whose `deleted_at` is set: `FilterSearch`/`Crud.findAll`,
  `Crud.findOne`, `checkParamId`, `Crud.update`, `Crud.delete`, the `unique` check and fetched or joined relations.
- `Crud.delete` sets `deleted_at` and `deleted_by` instead of deleting the row.
- The six audit columns are never writable from a request body, and they become selectable, filterable and orderable.

With `timestamp: false`, no audit columns are created or set, and `Crud.delete` deletes the row.

Soft-delete filtering is applied by this package's helpers. Your own `Model.query()` calls are plain Objection
queries; add `.whereNull('deleted_at')` yourself where needed.

### Migrations

| Method | Description |
| --- | --- |
| `migrationUp(knex)` | `createTable(tableName)` running every column's `migration`, then the audit columns. Returns the schema builder. |
| `migrationDown(knex)` | `dropTable(tableName)`. |

### Seeders

| Method | Description |
| --- | --- |
| `seeder(number?, knex)` | **Deletes every row of the table**, then inserts `number` rows (default `1`) built from each column's `seed(faker)`. `knex` is always the last argument. |
| `seederCustom(number, cb, knex)` | Same, but `await cb()` runs for every row and its returned object overrides the generated values (only keys that are defined in `static column` are used; others are dropped). If no knex is bound to `Model` yet, `knex` is bound so that `cb` can query other models. |

```js
// database/seeds/1000-users.js
import { Users } from '#models';

export const seed = async (knex) => {
  await Users.seeder(10, knex); // 10 rows, every value from `seed`
};

// or: 10 rows whose `role` comes from the callback, the rest from `seed`
// await Users.seederCustom(10, async () => ({ role: 'member' }), knex);
```

Both methods empty the table first, so call only one of them per table and seed file.

`@faker-js/faker` is loaded lazily on the first seeder call, so it can stay a dev dependency. Version 10.5.0 or
later is required (earlier releases have a code-execution advisory in `helpers.fake`), and `seed` functions use the
faker 10 API (`f.person.firstName()`, `f.number.int()`, ...). When faker is not installed the seeder throws
`Model seeder needs @faker-js/faker (npm i -D @faker-js/faker)`.

### Validation and route hooks

`@averoa/routes` calls these three static methods for `crud()` routes. Each has the Express middleware signature
plus an `additional` object `{ type: 'json' | 'multipart', create: boolean, pref }`.

| Hook | Behaviour |
| --- | --- |
| `checkParamId(req, res, next)` | When `req.params.id` is set and no live row has that id, responds **404** `{ status: false, message: "ID 5 doesn't exist" }`. Otherwise calls `next()`. |
| `validationRouter(req, res, next, additional)` | Validates `req.body` against `writableColumns()` (create mode when `additional.create === true`). On failure responds **422** `{ status: false, data: { column, message } }`. On success replaces `req.body` with only the writable columns, keeps the original in `req.bodyRaw`, and puts matching upload files in `req.dataFiles`. A missing `req.body` is treated as `{}`. |
| `mapRequest(req, res, next, additional)` | Sets `req.dataReq = req.body`, `req.routeData = additional.pref` and, for multipart routes, `req.isFormData = true`. |

The 422 `message` is the string `'required'` or `'must be a scalar value'`, or an array with every failed rule's
`msg` and/or `duplicate value <value>`:

```json
{ "status": false, "data": { "column": "email", "message": ["email format required"] } }
```

`validationRouter` stops at the first failing column. Checks per column, in order: required, scalar (unless `json`),
`unique`, then the `validation` rules.

For your own code, `Model.validation(object, type = 'create')` applies the same required, scalar and rule checks to
a plain object (no `unique` check, no database access) and returns `{ status: true }` or
`{ status: false, data: { column, message } }`. In create mode it requires every column of `writableColumns()` whose
`required` is not `false`, the same set `validationRouter` checks: the primary key (unless `fillable`) and hidden columns
(unless `writable`) are not required.

### Other static methods

| Method | Description |
| --- | --- |
| `writableColumns()` | Columns a client may write: all of `column` except the audit columns, the primary key (unless `fillable`) and hidden columns (unless `writable`). |
| `isDuplicate(column, value, exceptId?)` | `true` when a live row already has `value` in `column`. |
| `filterSearch(req, config?)` | `FilterSearch.model(this, req, config)`. Override it to customise listing; `Crud.findAll` calls it. |
| `search(query, term)` | Adds `orWhere(col, 'like', '%term%')` to `query` for every non-hidden column whose `search` flag is not `false`. |

Hidden columns are removed in `$formatJson`, so they disappear from `toJSON()`, `JSON.stringify()` and `res.json()`
(including nested relations) but stay readable as properties in your code (`user.password`).

## Crud

```js
import { Crud } from '@averoa/utilities';

await Crud.findAll('Users', req);                        // list, filtered and paginated from req.query
await Crud.findOne('Users', req);                        // req.params.id
await Crud.create('Users', req, { insert: { role: 'member' } });
await Crud.update('Users', req, { update: { verified: true } }, trx);
await Crud.delete('Users', req);                         // soft or hard, depending on `timestamp`
```

`model` is either a name exported from `app/Models/index.js` or a model class.

| Method | `option` | Resolves to |
| --- | --- | --- |
| `findAll(model, req, option?)` | FilterSearch config: `maxLimit`, `limit` (default page size), `page` | `{ status: true, metadata, data }`, the DataTables shape (below), or `{ status: false, message, statusCode }` |
| `findOne(model, req, option?)` | unused | `{ status: true, data }`, or `{ status: false, message: "ID 5 doesn't exist", statusCode: 404 }` when the id does not exist or is soft-deleted |
| `create(model, req, option?, trx?)` | `insert`: object merged over the payload (its values win) | `{ status: true, data }` with the inserted model (hidden columns removed from JSON) |
| `update(model, req, option?, trx?)` | `update`: object merged over the payload (`created_by`/`created_at` are dropped from it) | `{ status: true }`, or the same 404 result as `findOne` when no live row matched `req.params.id` |
| `delete(model, req, option?, trx?)` | `update`: extra columns for the soft-delete patch (`created_by`/`created_at` are dropped from it) | `{ status: true }`, or the same 404 result as `findOne` when no live row matched |

`trx` is an optional Objection/knex transaction, passed to `Model.query(trx)` for every query the method runs
(including the read of the current row before an upload).

### What gets written

- **Payload.** When `req.dataReq` is an object (set by the `crud()` route hooks, or by your own code) it is trusted
  and written as is. Otherwise the payload is taken from `req.body`, keeping only `writableColumns()`: no unknown
  keys, no primary key (unless `fillable`), no audit columns, no hidden columns (unless `writable`).
- **Audit columns** (models with `timestamp !== false`):
  - `create` sets `created_by` and `updated_by` to `req.user.id` when `req.user` exists;
  - `update` drops `created_by`/`created_at` from the payload (even from `req.dataReq` and `option.update`), sets
    `updated_at` to now and `updated_by` to `req.user.id` when `req.user` exists;
  - `delete` sets `deleted_at` to now and `deleted_by` to `req.user?.id ?? null`;
  - `option.insert` on `create` may set `created_by`/`created_at`; `option.update` on `update` and `delete` cannot.
- **Soft-deleted rows** are never updated or deleted again.

### Uploads

When `req.dataFiles` is set (by `validationRouter`, from `upload` columns), `create` and `update` load
`UploadProvider` from `app/Providers/index.js` and store, for each file, the value returned by:

```js
await UploadProvider.upload(file, req.routeData);                // create
await UploadProvider.upload(file, req.routeData, oldValue);      // update: oldValue = the column's current value
```

`file` is the multer file object and `req.routeData` is the route's `pref` (set by `mapRequest`).

### DataTables mode

`findAll` with `?$datatable=1` (also `true`, `yes` or `on`, in any case, or a boolean `true` set in code) returns the
shape jQuery DataTables expects, echoing `?$draw=`:

```json
{ "draw": "3", "recordsTotal": 42, "recordsFiltered": 42, "data": [] }
```

Any other `$datatable` value, including `0` and `false`, gives a normal listing; `$datatable` and `$draw` are never
treated as filters. `recordsTotal` and `recordsFiltered` are both the filtered item count. Paging still uses `limit` and `page`;
DataTables' own `start`, `length`, `columns[...]` and `search[...]` parameters are ignored. The `_` cache buster is
always ignored. Errors keep the `{ status: false, message, statusCode }` shape.

### Error results

`Crud` methods do not throw for request or database problems; they resolve to
`{ status: false, message, statusCode }`:

| Cause | `message` | `statusCode` |
| --- | --- | --- |
| Invalid filter, `$select`, `$relations`, ... (`FilterSearchError`) | the specific reason, e.g. `column password is not selectable` | `400` |
| Objection `ValidationError` | the error's message | `422` |
| No live row with `req.params.id` (`findOne`, `update`, `delete`) | `ID <id> doesn't exist` (as `checkParamId`) | `404` |
| Objection `NotFoundError` | the error's message | `404` |
| Unknown model name (`PublicError`) | `Model Nope not found in app/Models/index.js` | `500` |
| Other `PublicError`, or any error with `expose === true` | the error's message | the error's `statusCode` (`400` when it has none) |
| Database / driver error | `'Database error'` | `500` |
| Anything else | `'Internal error'` | `500` |

Database and unexpected errors are logged in full with `Log.error`; the client never sees the driver message, which
can contain the SQL and bound values. `res.json()` alone always sends 200; use `statusCode` to send the matching
status:

```js
const result = await Crud.findAll('Users', req);
res.status(result.statusCode ?? 200).json(result);
```

Success results have no `statusCode`.

## FilterSearch

`FilterSearch` turns `req.query` into a filtered, ordered and paginated query. `Crud.findAll` uses it through
`Model.filterSearch()`. It works on a copy of `req.query` and never mutates it (Express 5 exposes `req.query` as a
getter).

### Operators

A filter key is `column`, `column:operator` or `col1|col2:operator`.

| Key | SQL | Value |
| --- | --- | --- |
| `col=v` | `col = v` | scalar |
| `col:eq=v` · `:neq` · `:lt` · `:lte` · `:gt` · `:gte` | `=` · `!=` · `<` · `<=` · `>` · `>=` | scalar |
| `col:like=v` | `col like v` (MySQL: `?? like binary ?`, case-sensitive) | pattern; add `%` wildcards yourself (`%25` in a URL) |
| `col:ilike=v` | `ilike` on PostgreSQL, `like` elsewhere | pattern |
| `col:in=a,b,c` | `col in (a, b, c)` | comma-separated list |
| `col:btwn=a,b` | `col between a and b` | exactly two comma-separated values |
| `col:isNull=` · `col:notNull=` | `is null` · `is not null` | ignored |
| `a\|b:search=w1 w2` | each word as `%word%` against each column, all joined with `OR` (`ilike` on PostgreSQL, `like` elsewhere) | space-separated words |
| `a\|b:op=v` | the operator applied to each column, joined with `OR` | as for `op` |

All values are bound as parameters. `:in` and `:btwn` also accept a repeated key (`?id:in=1&id:in=2`), but not an
object or a nested value; for every other operator any object or array value is rejected. Both are rejected as
`invalid value for <key>`. Object values only reach the filter when the app uses the `extended` query parser
(`?id:in[a]=1`, `?name[x]=1`). With Express 5's default `simple` parser those keys arrive literally:
`?name[x]=1` is an unknown key and is ignored, and `?id:in[a]=1` fails with `unknown operator in[a]`.

Several filters are combined with `AND`:

```text
/users?status=active&saldo:gte=100000&created_at:btwn=2024-01-01,2024-12-31
/users?name|email:search=ada%20london
/users?email:like=%25%40example.com&orderByDesc=created_at&limit=20&page=2
/users?deleted_by:isNull=&id:in=1,2,3
```

### Reserved parameters

| Parameter | Description |
| --- | --- |
| `limit` | Page size, an integer `>= 0`. Default `10` (or `config.limit`). `0` means "all, up to `maxLimit`"; larger values are capped at `maxLimit`. |
| `page` | Page number, an integer `>= 1`. Default `1` (or `config.page`). |
| `orderBy=col` · `orderByDesc=col` | Sort by one own column (ascending / descending). When both are present, `orderByDesc` wins. |
| `groupBy=col` | Group by one own column; the count becomes a distinct count of that column. |
| `$select=a,b` | Return only these columns. Allowed: the model's columns (plus the audit columns on soft-delete models), minus hidden ones. |
| `$relations=expr` | Load relations, as an Objection relation expression: `posts`, `[posts, profile]`, `posts.comments`. Validated against `static allowGraph`. |
| `$relations-type=join` | Use `withGraphJoined` instead of `withGraphFetched`, and allow filters on `relation.column`. Any other value means fetch. |
| `$withTrashed=1` | Include soft-deleted root rows (`1`, `true` or `yes`). Only on models with `static allowWithTrashed = true`; otherwise an error. Other values are ignored. |

`Crud.findAll` additionally consumes `$datatable` and `$draw`.

Column names may be qualified with the model's table (`users.id:gt=1`, `orderBy=users.name`).

### Relations

- `$relations` must fit `static allowGraph`: every relation name, nesting level, recursion and modifier in the
  request must be present in the allowed expression. By default only the model's direct relations are allowed;
  set `static allowGraph = '[posts.comments, profile]'` to allow more, or `false` to allow none. Models without
  relations reject `$relations` (`relations are not allowed on this resource`).
- Soft-deleted related rows are always excluded, at every level, and hidden columns of related models are removed
  from the JSON.
- With `$relations-type=join`, `relation.column` filters target a column of a directly requested relation (for
  example `?$relations=posts&$relations-type=join&posts.title:like=%25node%25`). The relations are LEFT JOINed with
  soft-deleted children excluded inside the join, so parents without live children are kept. Pagination and the
  count are computed on distinct root rows, then the joined graph is loaded for that page.

### Strict and ignored keys

| Query key | Result |
| --- | --- |
| `col:op=v` on an unknown or hidden column | error `column <col> doesn't exist` |
| `col:xyz=v` (unknown operator) on a known column | error `unknown operator xyz` |
| `x:y=v` where no listed column is known | ignored (tracking parameters and the like) |
| `col=v` on a known, non-hidden column | equality filter |
| `name=v` on an unknown or hidden column (`?password=x`, `utm_source`, DataTables' `draw`, `columns[...]`) | ignored |
| `_` | ignored |
| bad `limit` / `page`, unknown `$select` column, disallowed `$relations` / `$withTrashed`, non-scalar value | error |

Errors are returned as `{ status: false, message, statusCode }` (`400` for these), never thrown.

### Response

```json
{
  "status": true,
  "metadata": {
    "item_total": 42,
    "per_page": 10,
    "page_total": 5,
    "current_page": 2,
    "has_next_page": true,
    "has_prev_page": true
  },
  "data": []
}
```

`per_page` is the smaller of the effective limit and `item_total`; `page_total` is at least `1`. A page past the end
returns empty `data` with `has_next_page` and `has_prev_page` both `false`.

### Programmatic use

```js
import { FilterSearch, DB } from '@averoa/utilities';

// a model (what Crud.findAll does)
const result = await FilterSearch.model(Users, req, { maxLimit: 200 });

// any knex query builder, with an explicit column whitelist
const report = await FilterSearch.knex(
  DB('users as u').join('posts as p', 'p.user_id', 'u.id').select('u.id', 'u.name', 'p.title'),
  req,
  { column: ['u.id', 'u.name', 'p.title'], maxLimit: 500 },
);
```

| Config | Mode | Default | Description |
| --- | --- | --- | --- |
| `maxLimit` | both | `1000` | Upper bound for `limit` (a positive integer). |
| `limit` | both | `10` | Page size when the request has no `limit`. |
| `page` | both | `1` | Page when the request has no `page`. |
| `column` | knex | required | Whitelist of filterable/selectable/orderable columns. Entries may be qualified (`'u.id'`), and requests then use the same name (`?u.id:eq=1`). Without it the result is `{ status: false, message: 'need to define column array', statusCode: 500 }`. |
| `hidden` | knex | `[]` | Columns removed from the whitelist. When set and the request has no `$select`, the query selects the remaining whitelist columns explicitly. |
| `timestamp` | knex | `false` | `true` adds the six audit columns to the whitelist and filters `<table>.deleted_at IS NULL` on the base table. |
| `softDelete` | knex | `true` | With `timestamp: true`, `false` keeps the audit columns but skips the `deleted_at` filter. |
| `table` | knex | derived | Table name or alias that qualifies the soft-delete filter. By default it is taken from the builder's single `FROM` table: `DB('users')` gives `users`, `DB('users as u')` and `DB({ u: 'users' })` give `u`. |

Knex mode does not support `$relations` or `$withTrashed`. The builder you pass is cloned, not modified, and the count
runs on a copy without its `select` and `orderBy`, so it stays valid on PostgreSQL and MySQL `ONLY_FULL_GROUP_BY`.
The soft-delete filter is qualified with that table (`u.deleted_at`), so it stays unambiguous when the builder joins
other tables that have `deleted_at`; only the base table's rows are filtered. When the `FROM` is a raw expression or a
subquery and `table` is not set, the filter uses the unqualified `deleted_at`.

## Request validation

`Model` validates crud routes. For everything else (a login form, search parameters, a webhook), `validate()`
builds an Express middleware that checks `body`, `query`, `params` and `headers`:

```js
import Router from '@averoa/routes';
import { validate } from '@averoa/utilities';

const router = Router();

router.post('/auth/login', 'AuthController@login', [validate({
  body: {
    email: {
      type: 'string',
      validation: [{ run: (v) => v.validator.isEmail(v.value), msg: 'email format required' }],
    },
    password: { type: 'string' },
    remember: { type: 'boolean', required: false, default: false },
  },
})]);

router.get('/search', 'SearchController@index', [validate({
  query: {
    q: { type: 'string' },
    page: { type: 'integer', default: 1, validation: [{ run: (v) => v.raw >= 1, msg: 'must be >= 1' }] },
  },
})]);
```

Each section is either a [Standard Schema v1](https://standardschema.dev) validator or an object of field
definitions. Sections run in the order `params`, `query`, `headers`, `body`, and the first failure answers.

### Field definitions

The built-in format follows the Model column style, so rules are written the same way:

| Key | Description |
| --- | --- |
| `type` | `'string'`, `'integer'`, `'number'`, `'boolean'`, `'object'` or `'array'`. Optional. Strings are coerced where it is unambiguous (`'42'` is a valid integer, `'true'`/`'1'`/`'yes'`/`'on'` a valid boolean), so query strings, params and headers work. Numbers and booleans become strings for `type: 'string'`; objects and arrays are rejected unless the type says so. |
| `required` | Default `true`. `flag: { required: false }`, as in Model columns, is accepted too. |
| `default` | Value (or function returning one) used when the key is missing. |
| `enum` | Allowed values, compared after coercion. |
| `validation` | Array of `{ run, msg }`. `run({ validator, value, raw, data })` returns (or resolves to) a boolean; `value` is the string form (JSON for objects), `raw` the coerced value, `data` the whole section. Every failing rule's `msg` is reported. |
| `description`, `example`, `format`, `schema` | Documentation only: copied into the generated JSON Schema (`schema` is merged as is). |

A missing optional field is left out of the output; an optional field sent as `''` or `null` is kept as is and its
rules don't run. Header names are matched case-insensitively. Keys that are not declared are dropped from the output.

### Standard Schema validators

Any library implementing Standard Schema v1 works, without an adapter: [zod](https://zod.dev) (3.24+),
[valibot](https://valibot.dev) (1.0+), [arktype](https://arktype.io) (2.0+) and others.

```js
import { z } from 'zod';

router.post('/teachers/:id/notes', 'NoteController@create', [validate({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({ text: z.string().min(1).max(500), pinned: z.boolean().default(false) }),
})]);
```

The schema receives the raw section (`req.body`, `req.query`, ...), so use the library's coercion (`z.coerce`) for
query strings and params. Asynchronous schemas are awaited.

### Results

On success the parsed output (coerced, defaults applied, unknown keys removed) is in `req.validated`:

| Property | Content |
| --- | --- |
| `req.validated.body` | Parsed body. `req.body` is replaced with it, and the original is kept in `req.bodyRaw` (as `validationRouter` does). |
| `req.validated.query` | Parsed query. `req.query` is a getter in Express 5 and is left untouched. |
| `req.validated.params` | Parsed route parameters. `req.params` is left untouched. |
| `req.validated.headers` | Parsed headers. `req.headers` is left untouched. |

Several `validate()` middlewares on one route add to the same `req.validated`.

On failure the response is **422** with the shape `validationRouter` uses, plus the section in `in`:

```json
{ "status": false, "data": { "column": "email", "message": ["email format required"], "in": "body" } }
```

`message` is `'required'` for a missing value, otherwise an array: every failing rule's `msg`, or every Standard
Schema issue message for the first failing path. `column` is that path joined with dots (`user.name`), or `null` for
an issue on the section itself.

### Options

`validate(schemas, options)`:

| Option | Description |
| --- | --- |
| `status` | HTTP status on failure. Default `422`. |
| `jsonSchema` | Explicit JSON Schema per section (`{ body: {...} }`) for API documentation. Wins over everything else. |
| `toJSONSchema` | `(schema, section) => jsonSchema` for Standard Schema libraries that don't implement `~standard.jsonSchema`. |

### JSON Schema for API documentation

`describeValidation(middleware)` returns the JSON Schema of every section, which `@averoa/core` uses to document
the route in its OpenAPI document. Field definitions always convert. A Standard Schema converts when its library
implements [Standard JSON Schema](https://standardschema.dev) (`~standard.jsonSchema`, zod 4.2+), has a
`toJSONSchema()` method, or `options.toJSONSchema` / `options.jsonSchema` is given; otherwise that section is left
undocumented (validation still runs).

## DB

`DB` is the application's knex instance, built from `config/database.js` (a knex config object, or a function
`(process) => config`) or, when that file is missing, from env:

```js
{
  client: process.env.DB_CLIENT || 'mysql2',
  connection: { host: DB_HOST, port: Number(DB_PORT), user: DB_USER, password: DB_PASS, database: DB_NAME },
}

// DB_CLIENT=sqlite3 or better-sqlite3
{
  client: DB_CLIENT,
  connection: { filename: DB_NAME || ':memory:' }, // relative names resolve against the app root
  useNullAsDefault: true,
}
```

For any other option (pool, SSL, a computed path, ...), write `config/database.js`.

```js
// config/database.js
import { appPath } from '@averoa/utilities/paths'; // not '@averoa/utilities'

export default ({ env }) => ({
  client: 'better-sqlite3',
  connection: { filename: env.DB_NAME || appPath('storages', 'app.sqlite') },
  useNullAsDefault: true,
});
```

`DB` is a callable proxy: `DB('users')`, `DB.raw()`, `DB.transaction()`, `DB.schema`, `DB.destroy()` and
`Model.knex(DB)` all forward to the real instance.

### Readiness

How `config/database.js` is loaded decides when `DB` is usable:

| Situation | Behaviour |
| --- | --- |
| No `config/database.js` | `DB` is built synchronously from env while the package is imported. |
| The config file does not import `@averoa/utilities` | It is awaited while the package is imported, for at most `AVEROA_CONFIG_WAIT_MS` (default 2000 ms). Normally `DB` is ready as soon as the import resolves. |
| The config file imports `@averoa/utilities` (root) | Not awaited: `DB` is initialised in the background and a warning recommends `@averoa/utilities/paths`. |
| The wait times out (for example an indirect import cycle) | A warning is printed and loading continues in the background. |

Code that may run before the instance exists should wait for it:

```js
import { DB, getDB, isDBReady } from '@averoa/utilities';

const knex = await getDB();   // or: await DB.ready
isDBReady();                  // true once the instance exists
```

Before then, calling `DB()` or reading most of its properties throws
`DB is not ready yet (config/database.js is still loading)`; `DB.destroy()` waits for the instance instead. If the
config file fails to load, the error is printed as a warning, `getDB()` rejects with it, and using `DB` throws it.

If the driver package for a known client (`mysql2`, `pg`, `better-sqlite3`, `sqlite3`, `tedious`, `oracledb`, ...)
is not installed, a warning is printed and `DB` is a connection-less knex: the app still starts, building queries
works (`.toString()`), and running them fails.

## Mail and the mail worker

### Sending mail

```js
import { Mail } from '@averoa/utilities';

// send now
await Mail.init()
  .from('noreply@example.com')
  .to('ada@example.com')
  .subject('Welcome')
  .html('emails/welcome', { name: 'Ada' })   // resources/views/emails/welcome.edge
  .send();

// publish to the mail queue; a worker sends it
await Mail.init().to('ada@example.com').subject('Welcome').html('<p>Hi Ada</p>').queue().send();
```

| Method | Description |
| --- | --- |
| `Mail.init()` | New message builder. |
| `from(address)`, `to(address)`, `subject(text)`, `text(body)` | nodemailer message fields. |
| `html(viewOrHtml, variables?)` | An Edge template name rendered with `variables` through `View`, or a raw HTML string (any string containing `<` is used as is). Render errors are logged and make `send()` reject. |
| `attachments(list)` | nodemailer attachments. |
| `additional(options)` | Extra nodemailer message options, spread last (they override the fields above). |
| `queue(name?)` | Publish to a queue instead of sending. Without a name: `config/mail.js` `queue`, then env `MAIL_QUEUE`, then `'mail'`. |
| `build()` | Resolves to the nodemailer message options (HTML rendered). |
| `send()` | Direct: resolves to nodemailer's `sendMail` info. Queued: publishes the message options as JSON and resolves to `{ status: 'queued', channel, data }` after the broker confirm. |

The transporter is created once per process, on first use, from `config/mail.js` (nodemailer transport options; the
`queue` and `amqp` keys are removed) or from the `MAIL_*` env vars. `setTransporter()` from
`@averoa/utilities/Mail.js` replaces it (tests, custom transports).

### Running the worker

```js
import { startMailWorker, closeQueue } from '@averoa/utilities';

const worker = await startMailWorker({ prefetch: 5, maxRetries: 3 });

process.on('SIGTERM', async () => {
  await worker.stop();
  await closeQueue();
});
```

| Option | Default | Description |
| --- | --- | --- |
| `queue` | `config/mail.js` `queue`, env `MAIL_QUEUE`, `'mail'` | Queue to consume (declared durable). |
| `prefetch` | `1` | Unacknowledged messages handled at the same time. |
| `maxRetries` | `3` | Re-publishes after a failed send; a message gets at most `maxRetries + 1` attempts. |
| `transporter` | the shared transporter | Any object with `sendMail(options)`. |
| `reconnectDelay` | `1000` | First reconnect delay in ms. |
| `maxReconnectDelay` | `30000` | Reconnect delay cap in ms. |

It resolves to `{ queue, consumerTag, stop() }`. Behaviour:

- **Success:** the message is acked. The ack happens outside the send's error handling, so an ack failure is logged
  and never causes the mail to be sent twice.
- **Send failure:** the message is re-published to the end of the same queue with an `x-averoa-retries` header and
  the original is acked. After `maxRetries` re-publishes it is rejected without requeue (it goes to the queue's
  dead-letter exchange, if one is configured). If re-publishing itself fails, the original is requeued.
- **Malformed message** (not JSON): rejected without requeue.
- **Attachments:** `Buffer` contents survive the JSON round trip and are restored before sending.
- **Broker restarts and errors:** channel and connection `error`/`close` events are handled (a channel error does
  not crash the process) and the consumer is re-created with exponential backoff, from `reconnectDelay` doubling up
  to `maxReconnectDelay`. A consumer cancelled by the broker is re-created the same way. `consumerTag` always
  reflects the current consumer.
- **Startup:** if the first connection fails, `startMailWorker()` rejects and does not retry in the background.
- **`stop()`:** cancels pending reconnects and the consumer, waits for in-flight sends, then closes the worker's
  channel. The shared connection stays open; call `closeQueue()` to close it.

## Queue

```js
import { Queue, closeQueue } from '@averoa/utilities';

await Queue('reports', { reportId: 42 });                 // JSON, application/json
await Queue('logs', 'plain text');                        // text/plain
await Queue('images', buffer, { priority: 5 });           // raw Buffer, extra amqplib publish options
```

`Queue(name, data, options?)` declares `name` as a durable queue (once per channel), publishes `data` as a
persistent message on a confirm channel and resolves to `true` once the broker confirms. Strings are sent as
`text/plain`, Buffers as is, anything else as JSON. `options` are amqplib publish options and override the defaults.

The process shares one AMQP connection and one confirm channel, opened lazily on the first publish. Both are dropped
on `close`/`error` and re-opened on the next publish. `closeQueue()` closes them (graceful shutdown, tests).

| Setting | Source |
| --- | --- |
| Server URL | `config/queue.js` `amqp` (or `url`), then env `RABBITMQ_SERVER` |
| Heartbeat (seconds) | `config/queue.js` `heartbeat`, default `5` |

Without a URL, `Queue()` rejects with
``Queue: no AMQP server configured (config/queue.js `amqp` or env RABBITMQ_SERVER)``. For tests,
`configureQueue({ url, heartbeat, driver })` from `@averoa/utilities/Queue.js` overrides these settings or swaps the
amqplib driver.

## Jobs and the scheduler

Background jobs run on the same RabbitMQ connection as `Queue`. A job is a class with a `handle(payload)` method;
`dispatch()` publishes it, `startJobWorker()` runs it in another process with retries, backoff, timeouts and a record
of failures. `Schedule` dispatches jobs (or runs functions) on cron expressions.

### Defining and dispatching jobs

```js
import { Job, exponentialBackoff } from '@averoa/utilities';

export default class SendInvoiceJob extends Job {
  static queue = 'billing';                        // default: config/queue.js `jobsQueue`, JOBS_QUEUE or 'jobs'
  static tries = 5;                                // total attempts (default 1: no retry)
  static backoff = exponentialBackoff(1000, 60000); // or 5000, or [1000, 5000, 30000]
  static timeout = 30000;                          // ms per attempt (default: none)

  async handle({ invoiceId }, { attempt, signal }) {
    // ... honour `signal` (aborted on timeout) in long-running work
  }

  async failed({ invoiceId }, error) {
    // called once, after the last attempt failed
  }
}

await SendInvoiceJob.dispatch({ invoiceId: 7 });                                // run as soon as possible
await SendInvoiceJob.dispatch({ invoiceId: 7 }, { delay: 10 * 60 * 1000 });     // in 10 minutes
await SendInvoiceJob.dispatch({ invoiceId: 7 }, { delay: new Date('2026-12-01T09:00:00Z'), queue: 'urgent' });
await SendInvoiceJob.dispatchSync({ invoiceId: 7 });                            // now, in this process
```

| Static property | Default | Description |
| --- | --- | --- |
| `jobName` | the class name | Name the job is published and registered under. Must be unique per worker. Set it if your build minifies class names. |
| `queue` | `config/queue.js` `jobsQueue`, env `JOBS_QUEUE`, `'jobs'` | Queue name: letters, digits, `_ . : -`, at most 200 characters, not `amq.*`. |
| `tries` | worker `tries`, else `1` | Total attempts, including the first. |
| `backoff` | worker `backoff`, else `0` | Wait before a retry, in ms: a number, an array with one entry per retry (the last one repeats) or a function `(retry) => ms`. `exponentialBackoff(base, max)` returns `base`, `2 × base`, `4 × base`, ... capped at `max`. |
| `timeout` | worker `timeout`, else none | Maximum run time of one attempt, in ms. |

| Method | Description |
| --- | --- |
| `dispatch(payload?, { delay?, queue? })` | Publishes `{ id, job, payload, attempt: 0, dispatchedAt }` as a persistent JSON message and resolves to `{ id, job, queue, delay }` after the broker confirm. `delay` is ms or a `Date`. |
| `dispatchSync(payload?)` | Runs `handle()` once in the current process, without RabbitMQ, retries or timeout, and resolves to its return value. On an error, `failed()` is called and the error is re-thrown. |
| `handle(payload, context)` | The work. `context` is `{ id, name, queue, attempt, tries, signal }`; `attempt` starts at 1. |
| `failed(payload, error, context)` | Optional. Called once when the last attempt has failed. Its own errors are logged. |

**Payloads** must be JSON serialisable and should stay small: pass ids, not model instances. Both `dispatch()` and
`dispatchSync()` send the payload through `JSON.stringify` / `JSON.parse`, so `Date`s arrive as ISO strings and
`undefined` properties are dropped; a `BigInt` or a circular structure makes `dispatch()` reject before anything is
published.

**Delays** need no broker plugin. A delayed job is published to `<queue>.delay.<ms>`, a durable queue declared with
`x-message-ttl: <ms>` and the default exchange as dead-letter exchange with `<queue>` as routing key. When the TTL
expires, RabbitMQ moves the message to `<queue>`. All messages of a delay queue have the same TTL, so they expire in
order. Delays are rounded up to whole seconds (so a few queues serve every dispatch) and may be at most 30 days. A delay
queue deletes itself (`x-expires`) once it has not been declared for its delay plus 15 minutes; a process that
publishes to it re-declares it at least every 5 minutes, so it never expires while it still holds messages. Retries
with a backoff use the same delay queues.

**Tests.** `fakeJobs()` makes `dispatch()` record instead of publish:

```js
import { fakeJobs } from '@averoa/utilities';

const fake = fakeJobs();
await registerUser({ email: 'ada@example.com' });
assert.equal(fake.dispatched[0].job, 'SendWelcomeEmailJob');   // { id, job, payload, queue, delay }
fake.restore();
```

### Running a job worker

```js
import { startJobWorker, closeQueue } from '@averoa/utilities';

const worker = await startJobWorker({ concurrency: 5 });   // jobs: Job exports of app/Jobs/index.js

process.on('SIGTERM', async () => {
  await worker.stop();
  await closeQueue();
});
```

| Option | Default | Description |
| --- | --- | --- |
| `jobs` | the `Job` subclasses exported by `app/Jobs/index.js` | Job classes to run: an array, or an object such as `import * as jobs from '#jobs'` (exports that are not `Job` subclasses are ignored). |
| `queues` | the queues of those classes | Queues to consume (declared durable). |
| `concurrency` (or `prefetch`) | `1` | Jobs run at the same time per queue (AMQP prefetch). |
| `tries`, `backoff`, `timeout` | `1`, `0`, none | Defaults for job classes that do not set them. |
| `reconnectDelay` | `1000` | First reconnect delay in ms. |
| `maxReconnectDelay` | `30000` | Reconnect delay cap in ms. |

It resolves to `{ queues, jobs, consumerTags, stop() }`. Behaviour:

- **Lookup by name only.** A message names its job; the worker finds the class in a `Map` built at startup from the
  classes it was given. Message content never chooses a file to import or code to evaluate, and two classes with the
  same name are a startup error.
- **Success:** the message is acked.
- **Failure** (a thrown error, a rejected promise or a timeout): while `attempt < tries`, the message is re-published
  with `attempt + 1` after the job's `backoff` (directly to the queue when the backoff is 0) and the original is
  acked. After the last attempt, a record is published to `<queue>.failed`, the original is acked and `failed()` is
  called.
- **At least once:** a retry or failed record is published and confirmed before the original is acked. If that
  publish fails, the original is requeued and the attempt runs again. A worker that dies while a job runs leaves the
  message unacked, and RabbitMQ delivers it again. Write `handle()` so that running it twice is harmless.
- **Timeout:** the attempt fails with `JobTimeoutError` and `context.signal` is aborted. JavaScript cannot kill a
  running function: a handler that ignores the signal keeps running in the background while the retry is scheduled.
- **Unknown job names and malformed messages** are moved to `<queue>.failed` (unknown names stay retryable, for
  example after a deploy that adds the class). If even that publish fails, an unknown job is requeued and a malformed
  message is dropped.
- **Broker restarts and errors** are handled like the mail worker: the consumers are re-created with exponential
  backoff, a channel error does not crash the process, and `startJobWorker()` rejects if the first connection fails.
- **`stop()`:** cancels the consumers and pending reconnects, waits for the running jobs, then closes the worker's
  channel. The shared connection stays open; call `closeQueue()` to close it.

### Failed jobs

Jobs that failed for good are kept in RabbitMQ, in the durable queue `<queue>.failed`, as JSON records:

```json
{ "id": "…", "job": "SendInvoiceJob", "queue": "billing", "payload": { "invoiceId": 7 }, "attempt": 5,
  "failedAt": "2026-11-16T10:00:00.000Z", "error": { "name": "Error", "message": "…", "stack": "…" } }
```

A queue rather than a `failed_jobs` table: jobs already depend on RabbitMQ but not on a database (or a schema
migration), the record is written on the same confirm channel before the job is acked, and the queue can be inspected
and purged with the RabbitMQ management UI or `rabbitmqctl`. To keep failures in a database as well, insert a row in
the job's `failed()` hook.

`retryFailedJobs({ queue?, limit? })` moves records from `<queue>.failed` back to `<queue>` with a fresh attempt count
and resolves to the number moved. Records are always re-published to the queue they were read for, never to a queue
named in the record. Records of malformed messages stay in the failed queue.

### Scheduling

```js
// app/Console/Kernel.js
import { PruneSoftDeletedJob, SendReportJob } from '#jobs';

export default function schedule(schedule) {
  schedule.job(PruneSoftDeletedJob, { days: 30 }).dailyAt('03:00');
  schedule.job(SendReportJob).cron('0 8 * * 1-5').timezone('Asia/Jakarta');
  schedule.call(() => refreshCache(), 'refresh-cache').everyFiveMinutes().withoutOverlapping();
}
```

```js
import { startScheduler } from '@averoa/utilities';

const scheduler = await startScheduler();   // schedule: app/Console/Kernel.js
// later: await scheduler.stop();
```

| `Schedule` method | Description |
| --- | --- |
| `job(JobClass, payload?, { queue?, delay? }?)` | Dispatch the job on each occurrence. The job runs on a job worker, not in the scheduler. |
| `call(fn, name?)` | Run `fn()` (may be async) in the scheduler process. |

| Event method | Cron |
| --- | --- |
| `cron(expression)` | Any 5-field expression, or 6 fields with seconds first |
| `everyMinute()` (the default), `everyTwoMinutes()`, `everyFiveMinutes()`, `everyTenMinutes()`, `everyFifteenMinutes()`, `everyThirtyMinutes()` | `* * * * *`, `*/2 * * * *`, ... |
| `hourly()`, `hourlyAt(minute)` | `0 * * * *`, `<minute> * * * *` |
| `daily()`, `dailyAt('HH:MM')` | `0 0 * * *`, `<MM> <HH> * * *` |
| `weekly()`, `weeklyOn(day, 'HH:MM')` | Sunday 00:00; `day` 0 (Sunday) to 6 |
| `monthly()`, `monthlyOn(day, 'HH:MM')` | The 1st at 00:00; `day` 1 to 31 |
| `timezone(tz)` | IANA time zone of this event |
| `withoutOverlapping()` | Skip an occurrence while the previous run of this event is still running in this process. For `job()` events it only covers the dispatch, not the job itself. |
| `name(text)` | Name used in logs and passed to the `lock` hook (default: the job name or the function name) |

`startScheduler({ schedule?, timezone?, lock?, maxSleep? })`:

| Option | Default | Description |
| --- | --- | --- |
| `schedule` | the default export of `app/Console/Kernel.js` | A `Schedule`, a function `(schedule) => void`, or an object or class with a `schedule(schedule)` method. |
| `timezone` | env `SCHEDULE_TIMEZONE`, else the process time zone | Time zone of events that do not set one. |
| `lock` | none | `(event, scheduledAt) => boolean \| Promise<boolean>`, called before every run (`event.description` is the event name); a falsy result (or an error) skips it. |
| `maxSleep` | `60000` | Longest single wait in ms, so clock changes are noticed. |

It resolves to `{ events, stop() }`; `events` lists `{ name, expression, timezone, overlapping, nextRun }`. An invalid
expression or time zone makes `startScheduler()` reject and names the event. The scheduler sleeps until the next
due time, runs every event that is due, and logs (never throws) task errors. Occurrences missed while the process was
stopped or asleep are not caught up. `stop()` stops scheduling and waits for running tasks.

`runScheduleOnce({ schedule?, timezone?, lock?, at? })` runs the events due in the current minute once, waits for them
and resolves to their names. Use it when a system cron or a Kubernetes CronJob starts the process every minute instead
of keeping a scheduler running.

**Run one scheduler.** Every running scheduler fires every event, so run exactly one scheduler process per
application (job workers can be scaled freely). For more than one, for availability, pass a `lock` backed by a shared
store so only one of them runs each occurrence, for example with Redis:

```js
await startScheduler({
  lock: (event, at) => redis.set(`schedule:${event.description}:${at.getTime()}`, '1', { NX: true, PX: 60000 })
    .then((ok) => ok === 'OK'),
});
```

Cron expressions are parsed by [croner](https://github.com/hexagon/croner) (standard day-of-month **or** day-of-week
matching, IANA time zones, no dependencies). It is an optional peer dependency, loaded when the scheduler starts:
install it with `npm install croner` in applications that schedule tasks. Without it, `startScheduler()` rejects with
an error that says so. `Job` and the worker do not need it.

## View, Log, Fetch and Validator

### View

The application's single Edge instance. Templates are mounted from `<app>/resources/views`, and compiled templates
are cached when `NODE_ENV === 'production'`. `@averoa/core` registers it as the Express view engine and `Mail.html()`
renders with it.

```js
import { View } from '@averoa/utilities';

const html = await View.render('emails/welcome', { name: 'Ada' });
```

### Log

A [winston](https://github.com/winstonjs/winston) logger at level `LOG_LEVEL` (default `info`).

```js
import { Log } from '@averoa/utilities';

Log.info('user created', { id: 1 });
Log.warn('login failed', { email, password });   // password is logged as "[REDACTED]"
Log.error(err);                                  // message + stack
```

**Where** (`LOG_CHANNEL`):

| `LOG_CHANNEL` | `<app>/storages/logs/averoa.log` | Console (stdout) |
| --- | --- | --- |
| unset (default, as in 2.0) | yes | unless `NODE_ENV=production` |
| `file` | yes | no |
| `stdout` | no (the directory is not created) | yes |
| `both` | yes | yes |

If the log directory cannot be created (read-only filesystem), a warning is printed and the console is used
instead, in every environment. `@averoa/core` reads the same `LOG_CHANNEL` for its HTTP access log, so
`LOG_CHANNEL=stdout` makes a container write nothing to disk.

**Format.** The file always gets JSON lines. The console gets `LOG_FORMAT`: `json`, or `pretty` (one readable line,
colored on a TTY unless `NO_COLOR` is set). The default is `pretty` when `NODE_ENV` is `development` or `test`, and
`json` otherwise. Every line has `timestamp` (ISO 8601), `level` and `message`, plus `requestId` while a request is
being handled, plus the meta fields you pass (keys are sorted):

```json
{"email":"ada@example.com","level":"warn","message":"login failed","password":"[REDACTED]","requestId":"4b0d6c1e-8a5f-4c39-9d0e-2f1c7a1b9e55","timestamp":"2026-11-16T09:30:00.000Z"}
```

```text
2026-11-16T09:30:00.000Z warn [4b0d6c1e-8a5f-4c39-9d0e-2f1c7a1b9e55]: login failed {"email":"ada@example.com","password":"[REDACTED]"}
```

Errors (as the message or as meta) are logged with `message` and `stack`; an Error nested in meta becomes
`{ name, message, stack }`.

**Request context.** `@averoa/core` runs every request inside an `AsyncLocalStorage` context holding its request id,
and `Log` adds it as `requestId` to every line written while that request is handled, across `await`, promises and
timers, without passing `req` around. Outside a request there is no `requestId`. Related helpers:

```js
import { getRequestId, addLogContext, runWithContext } from '@averoa/utilities';

getRequestId();                       // the current request id, or undefined
addLogContext({ userId: req.user.id }); // added to every later line of this request
await runWithContext({ requestId: job.id }, () => handle(job)); // your own context, e.g. a queue job
```

The context lives on `globalThis` under a registered symbol, so `@averoa/core` and this package share it even when
they are different versions or installed twice. Explicit meta wins over context fields.

**Redaction.** Before a line is written, the values of sensitive keys are replaced with `[REDACTED]`, at any depth
and in arrays, without changing the object you passed. Keys are compared case-insensitively with everything but
letters and digits removed (`X-Api-Key` → `xapikey`). A key is sensitive when it contains `authorization`, `cookie`,
`password`, `passwd`, `passphrase`, `secret`, `token`, `apikey`, `privatekey`, `credential`, `sessionid` or `csrf`;
is `pass`, `pwd`, `jwt`, `otp`, `auth` or `sid`; or ends with `pass` or `pwd` (`DB_PASS`). `LOG_REDACT` adds keys
(comma separated, matched the same way: `LOG_REDACT=ssn,iban`). `Bearer` / `Basic` credentials inside strings
(messages, stacks, values) are masked too, circular references become `[Circular]` and nesting deeper than 8 levels
becomes `[Truncated]`. Redaction is a safety net, not a licence to log secrets: free text such as
`` `password is ${password}` `` cannot be detected.

`createLogger(options)` builds another logger with the same pipeline; every option defaults to the environment:
`{ level, format: 'json' | 'pretty', channel: 'stdout' | 'file' | 'both' | null, dir, filename, stream, colors, redactKeys }`
(`stream` writes the console output to any writable stream, which is handy in tests). `redact(value, { keys })`
returns a redacted copy of any value.

### Fetch

An [axios](https://axios-http.com/) instance. When `config/fetch.js` exists (an axios request config object, or a
function `(process) => config`) it is loaded in the background and merged into `Fetch.defaults`; request methods
(`Fetch()`, `get`, `post`, `put`, `patch`, `delete`, `head`, `options`, `request`, `postForm`, ...) called earlier
wait for it. `Fetch.ready` (also exported as `fetchReady`) settles once it has been applied. A config that fails to
load prints a warning and leaves the defaults unchanged.

Without `config/fetch.js`, `FETCH_BASE_URL` sets `baseURL` and `FETCH_TIMEOUT` sets `timeout` (ms).

```js
import { Fetch } from '@averoa/utilities';

const { data } = await Fetch.get('/users/1');
```

### Validator

The [validator](https://www.npmjs.com/package/validator) package, the same object column rules receive as
`v.validator`.

```js
import { Validator } from '@averoa/utilities';

Validator.isEmail('ada@example.com'); // true
```

## AuthSandbox

A per-request helper over [passport](https://www.passportjs.org/)'s request API. It is not re-exported from the root;
import it directly and create one per request:

```js
import Auth from '@averoa/utilities/AuthSandbox.js';

const auth = Auth(req);
if (auth.check()) {
  const user = auth.user();
}
await auth.logout();
```

| Method | Returns |
| --- | --- |
| `user()` | `req.user`, else `req.session.passport.user`, else `{}` |
| `check()` | `req.isAuthenticated()`, or `false` when passport is not set up |
| `logout()` | Promise that resolves once `req.logOut()` has finished (passport >= 0.6 callback style) |

## Authorization (Gate)

`Gate` decides whether a user may perform an action, in the spirit of Laravel's gates and policies. It is plain
JavaScript: it does not know how users are authenticated, it only needs the user object (usually `req.user`).

### Abilities

```js
import { Gate } from '@averoa/utilities';

Gate.define('view-reports', (user) => user.is_admin === true);
Gate.define('edit-settings', async (user, team) => team.owner_id === user.id);

await Gate.allows(req.user, 'view-reports');        // true | false
await Gate.denies(req.user, 'edit-settings', team); // extra arguments reach the callback
```

### Policies

A policy groups the abilities of one model. Register it for the model class; checks that receive an instance (or the
class itself, for `create`) are dispatched to the method named after the ability:

```js
// app/Policies/PostPolicy.js
export default class PostPolicy {
  // optional: runs first, a non-undefined result decides (e.g. an admin bypass)
  before(user, ability) {
    if (user.is_admin) return true;
    return undefined;
  }

  view() { return true; }

  create(user) { return user.email_verified_at != null; }

  update(user, post) { return post.user_id === user.id; }

  delete(user, post) { return post.user_id === user.id; }
}
```

```js
import { Gate } from '@averoa/utilities';
import { Posts } from '#models';
import PostPolicy from '#app/Policies/PostPolicy.js';

Gate.policy(Posts, PostPolicy);  // a class (instantiated once) or a plain object

await Gate.allows(req.user, 'update', post);   // PostPolicy#update(user, post)
await Gate.allows(req.user, 'create', Posts);  // PostPolicy#create(user, Posts)
```

Subclasses of a registered model use its policy. When the policy has no method for an ability, a `define()`d ability
of the same name is used; when there is neither, the check is denied.

### Checking

| Method | Result |
| --- | --- |
| `allows(user, ability, ...args)` | `Promise<boolean>` |
| `denies(user, ability, ...args)` | `Promise<boolean>` |
| `check(user, [abilities], ...args)` | `true` when every ability is allowed |
| `any(user, [abilities], ...args)` | `true` when at least one ability is allowed |
| `inspect(user, ability, ...args)` | the `GateResponse` (`allowed`, `message`, `statusCode`) |
| `authorize(user, ability, ...args)` | resolves the `GateResponse`, or rejects with an `AuthorizationError` |
| `forUser(user)` | the same methods bound to one user: `Gate.forUser(req.user).allows('update', post)` |

`authorize()` throws an `AuthorizationError` with `statusCode`/`status` 403 and `expose: true`, so it follows the
package's error conventions: `@averoa/core`'s error handler answers `403 { status: false, message }`, and
`errorResult(err)` (see [Error results](#error-results)) gives `{ status: false, message, statusCode: 403 }`.

```js
async update(req, res) {
  const post = await Posts.query().findById(req.params.id);
  await Gate.authorize(req.user, 'update', post); // 403 for anyone but the author
  // ...
}
```

Callbacks and policy methods may return a `GateResponse` instead of a boolean to give a reason or another status:

```js
import { GateResponse } from '@averoa/utilities';

export default class PostPolicy {
  delete(user, post) {
    if (post.user_id === user.id) return true;
    return GateResponse.deny('Only the author can delete this post'); // 403 with this message
    // GateResponse.denyAsNotFound() -> 404, hides that the post exists
  }
}
```

### Global callbacks

```js
Gate.before((user, ability, ...args) => (user?.is_super_admin ? true : undefined)); // first non-undefined decides
Gate.after((user, ability, response, ...args) => audit(user, ability, response.allowed)); // return value ignored
```

`before` callbacks run for every check, also for guests (`user` is `null`).

### Middleware

`can(ability, resource?, options?)` builds an Express middleware for route middleware arrays
([`@averoa/routes`](https://github.com/budiherma1/AveroaRoute) accepts functions next to middleware names). Put it
after the middleware that authenticates the request:

```js
import Router from '@averoa/routes';
import { can } from '@averoa/utilities';
import { Posts } from '#models';

const findPost = (req) => Posts.query().findById(req.params.id).whereNull('deleted_at');

router.get('/reports', 'ReportController@index', ['AuthMiddleware', can('view-reports')]);
router.post('/posts', 'PostController@create', ['AuthMiddleware', can('create', Posts)]);
router.put('/posts/:id', 'PostController@update', ['AuthMiddleware', can('update', findPost)]);
```

| Situation | Response |
| --- | --- |
| No user (`req.user` empty) | `401 { status: false, message: 'Unauthenticated' }` |
| The loader returns `null` / `undefined` | `404 { status: false, message: 'Not Found' }` |
| Denied | `403 { status: false, message }` (or the `GateResponse`'s status, message and `code`) |
| Allowed | `next()`; the resource is kept on `res.locals.resource` |
| The loader or a callback throws | `next(err)` |

`resource` is a model class (passed as is), a loader function `(req, res) => resource | Promise<resource>` (an array
result is spread into several arguments), or any other value (passed as is). Options:

| Option | Default | Description |
| --- | --- | --- |
| `gate` | the `Gate` singleton | Another `AccessGate`. |
| `user` | `(req) => req.user` | Where the user comes from. |
| `notFoundMessage` | `'Not Found'` | Message of the 404 answer. |

### Defaults

Every check fails closed: unknown abilities, missing policy methods and callbacks that return anything but `true` (or
an allowing `GateResponse`) deny. Guests (`user` `null` or `undefined`) are denied without calling the ability, unless
it was defined with `Gate.define(name, callback, { guests: true })`, or the policy sets `allowGuests = true` (static or
instance property). Errors thrown by callbacks are not swallowed. `Gate.reset()` removes every ability, policy and
callback (useful in tests); `new AccessGate()` gives an isolated gate.

## Path helpers

```js
import { appRoot, appPath, appHas, importApp, importAppDefault } from '@averoa/utilities/paths';

appPath('config', 'database.js');                                   // absolute path inside the app
appHas('app', 'Providers', 'index.js');                             // true / false
const models = await importApp('app/Models/index.js');              // module namespace
const config = await importAppDefault('config/mail.js', { optional: true }); // default export, or null when missing
```

`appRoot()` resolves, once per process, to:

1. `AVEROA_ROOT`, resolved against the current directory when relative;
2. otherwise the nearest directory, walking up from `process.cwd()`, that contains a `package.json` and is not inside
   `node_modules`;
3. otherwise `process.cwd()`.

The result is cached; `resetAppRoot()` clears it (for tests that change `AVEROA_ROOT`). This replaces the
`./../../../` imports of 1.x, so the package works with pnpm, npm workspaces, symlinks and monorepos. Set
`AVEROA_ROOT` when the process does not start inside the project folder.

| Function | Description |
| --- | --- |
| `appRoot()` | The application root directory. |
| `appPath(...segments)` | `path.join(appRoot(), ...segments)`. |
| `appHas(...segments)` | `true` when that app-relative file or directory exists. |
| `importApp(relativePath, { optional })` | Dynamic `import()` of an app file. With `optional: true`, resolves to `null` when the file does not exist instead of rejecting. |
| `importAppDefault(relativePath, options)` | Like `importApp`, resolving to the default export (or `null`). |
| `resetAppRoot()` | Forgets the cached root. |

`@averoa/utilities/paths` only depends on Node built-ins. It is the entry point to use from `config/*.js` files and
from any module that the root package itself loads.

## Configuration

Environment variables read by this package. The `DB_*`, `MAIL_*` (except `MAIL_QUEUE`) and `FETCH_*` variables are
only used when the matching `config/*.js` file does not exist or exports nothing.

| Variable | Default | Description |
| --- | --- | --- |
| `AVEROA_ROOT` | nearest `package.json` at or above the cwd | Application root. |
| `AVEROA_CONFIG_WAIT_MS` | `2000` | Maximum time to wait for `config/database.js` while the package is imported. |
| `DB_CLIENT` | `mysql2` | knex client. |
| `DB_HOST` | — | Database host (not used for SQLite). |
| `DB_PORT` | — | Database port. |
| `DB_USER` | — | Database user. |
| `DB_PASS` | — | Database password. |
| `DB_NAME` | — | Database name; the database file for `sqlite3`/`better-sqlite3` (default `:memory:`; a relative path is resolved against the app root, like `@averoa/core`'s knexfile). |
| `DB_TIMEZONE` | `Z` | `mysql`/`mysql2` only: `Z`/`UTC`, an offset such as `+07:00`, or `local`. Sets both the driver `timezone` and the session `time_zone`, so `created_at` (filled by MySQL) and `deleted_at` (written from a JS `Date`) use the same zone. `local` keeps the driver default (Node.js time zone) and leaves the session alone. |
| `MAIL_HOST` | — | SMTP host. |
| `MAIL_PORT` | — | SMTP port. |
| `MAIL_SECURE` | — | `true` for implicit TLS; any other value means `false`. Unset leaves nodemailer's default. |
| `MAIL_USERNAME` | — | SMTP user; when unset, no auth is configured. |
| `MAIL_PASSWORD` | — | SMTP password. |
| `MAIL_QUEUE` | `mail` | Default mail queue, used when `config/mail.js` has no `queue`. |
| `RABBITMQ_SERVER` | — | AMQP URL, used when `config/queue.js` has no `amqp`/`url`. Required for `Queue`, jobs and the workers. |
| `JOBS_QUEUE` | `jobs` | Default job queue, used when `config/queue.js` has no `jobsQueue`. |
| `SCHEDULE_TIMEZONE` | the process time zone | Default IANA time zone of the scheduler. |
| `FETCH_BASE_URL` | — | axios `baseURL`. |
| `FETCH_TIMEOUT` | — | axios `timeout` in ms. |
| `LOG_LEVEL` | `info` | winston level: `error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly`. |
| `LOG_CHANNEL` | — | `stdout`, `file` or `both`. Unset: the file, plus the console unless `NODE_ENV=production`. |
| `LOG_FORMAT` | `pretty` in `development` / `test`, else `json` | Console format of `Log`: `json` or `pretty`. Files are always JSON. |
| `LOG_REDACT` | — | Extra sensitive keys for log redaction, comma separated. |
| `NO_COLOR` | — | Any value disables colors in the `pretty` format. |
| `NODE_ENV` | — | `production` turns on the Edge template cache and, with `LOG_CHANNEL` unset, turns off the console log transport. |

## Security notes

- **Error messages.** `Crud` and `FilterSearch` never return database driver messages (they contain the SQL and
  bound values, such as password hashes). Clients get `'Database error'` or `'Internal error'`, and the full error is
  logged. Messages of `FilterSearchError`, `PublicError` (or any error with `expose === true`) and Objection
  validation errors are returned as is.
- **Mass assignment.** A raw `req.body` can only write `writableColumns()`. `req.dataReq` is trusted, so only set it
  from validated data.
- **Hidden columns** are excluded from JSON, `$select`, filters, `orderBy`, `groupBy`, relation filters and request
  writes (unless `writable`).
- **Queries.** Every filter value is a bound parameter, and every column name is checked against a whitelist before
  it reaches the query.
- **Result size.** `limit` is capped by `maxLimit` (default 1000), including `limit=0`.
- **Soft-deleted data** is not readable or writable through `Crud`/`FilterSearch` unless the model opts into
  `$withTrashed`.
- **Authorization** fails closed: `Gate` denies unknown abilities, missing policy methods, guests and any callback
  result other than `true`.
- **Jobs** are resolved by name from the classes a worker was started with; message content is never used to import
  a module or evaluate code. Queue names are validated, and failed records are only re-queued to the queue they were
  read from.
- **Relations** are limited to `static allowGraph`; deeper graphs, recursion and modifiers must be allowed
  explicitly.

## Testing

```bash
npm install
npm test             # node:test suite
npm run lint         # ESLint (eslint.config.js)
npm run typecheck    # tsc: the *.d.ts files and test/types/*.ts
```

The suite covers models, CRUD, filters, the DB loader, the queue, logging (format, channels, request context,
redaction), config import cycles and that every `.d.ts` declares exactly its module's runtime exports. It uses `node:test` and an in-memory `better-sqlite3` database with the fixture app in `test/fixtures/`. AMQP
and SMTP are replaced by in-process fakes, so no MySQL, RabbitMQ or mail server is needed.

### Integration tests

`test/integration/` runs `Model`, `Crud` and `FilterSearch` against a real MySQL and PostgreSQL server, using the
fixture app in `test/fixtures/integration-app` (no `config/database.js`, so `DB` is built from the `DB_*` variables).
Each dialect is skipped unless its URL is set. Use a throwaway database: the suite drops and recreates its `it_*`
tables.

```bash
AVEROA_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/averoa_test \
AVEROA_TEST_PG_URL=postgres://user:pass@127.0.0.1:5432/averoa_test \
npm run test:integration
```

### Continuous integration

`.github/workflows/ci.yml` runs `npm test` on Node.js 20, 22 and 24 (plus `npm run lint` and `npm run typecheck` on
Node.js 24), and `npm run test:integration` against MySQL
8.0 / 8.4 and PostgreSQL 16 / 17 service containers (with `TZ=Asia/Jakarta`, so the Node.js and server time zones
differ). `.github/workflows/release.yml` publishes to npm when a `vX.Y.Z` tag matching `package.json` is pushed,
after the same checks; it needs an `NPM_TOKEN` repository secret.


`test/jobs.integration.test.js` runs the jobs, delays, retries, failed queue and scheduler against a real RabbitMQ.
It is skipped unless `RABBITMQ_TEST_SERVER` is set:

```bash
docker run -d --rm --name averoa-rabbitmq -p 127.0.0.1:35672:5672 rabbitmq:4.1-alpine
RABBITMQ_TEST_SERVER=amqp://guest:guest@127.0.0.1:35672 npm test
```

## Upgrading

The full list of changes is in [CHANGELOG.md](./CHANGELOG.md).

**2.0.2** (patch release)

- `Crud` and `FilterSearch` error results now include `statusCode` (`400`, `404`, `422` or `500`); send it with
  `res.status(result.statusCode ?? 200)`. Tests that compare a whole error result with `deepEqual` need the new key.
- `?$datatable=0` / `false` no longer switch on DataTables mode; only `1`, `true`, `yes`, `on`.
- `Crud.findAll` resolves `{ status: false, ... }` for an unknown model name instead of rejecting.
- `Crud.findOne` answers `{ status: false, message, statusCode: 404 }` for a missing or soft-deleted id (it was
  `{ status: true, data: null }`); `update`/`delete` with no matching row answer the same (they were `{ status: false }`).
- `Model.validation()` in create mode no longer requires the primary key or non-writable hidden columns.
- Knex-mode soft delete is qualified with the base table; a `FROM` table without `deleted_at` whose joined table has
  it now errors instead of filtering the joined table (set `softDelete: false` there).
- `DB_CLIENT=sqlite3`/`better-sqlite3` without `config/database.js` now works (`DB_NAME` is the file; a relative path is resolved against the app root, so the app and the migrate/seed scripts open the same file).

**2.0.1** (security release)

- `nodemailer` upgraded from ^6.9 to ^10.3.1, which requires **Node.js >= 20**.
- The optional `@faker-js/faker` peer now requires **>= 10.5.0**; seeders must use the faker 10 API
  (`f.person.*`, `f.number.int`, ...).

**From 1.x to 2.0**

- ESM only. Peer dependencies `knex`, `objection` and `edge.js` are installed by the application.
- App files are found through the app root (`AVEROA_ROOT` or the nearest `package.json`) instead of `./../../../`
  imports. Models load from `app/Models/index.js` (no more `@averoa/models`). Config files fall back to env.
- `validationRouter` responds **422** and `checkParamId` responds **404** (both were 200).
- Soft delete is enforced for every model with `timestamp !== false`; `Crud.delete` hard-deletes models with
  `timestamp: false`.
- New `static hidden`, `static allowGraph` and `static allowWithTrashed`; `$select` and `$relations` are validated.
- Filters are strict: unknown columns or operators and invalid values return `{ status: false, message }`.
- `limit` is capped by `maxLimit`; `limit=0` means "all, up to `maxLimit`".
- `:like` is parameterized; `:ilike` and `:search` use `ilike` on PostgreSQL. `$relations-type=join` paginates on root
  rows.
- `Crud` writes only known columns from a raw body. `moment` was removed.
- `Queue` uses one lazy connection, durable queues and persistent messages, and resolves after the broker confirm.
- The mail worker is a real consumer: `startMailWorker()` returns `{ stop() }`.
- `AuthSandbox` is a per-request factory `Auth(req)`.
- `View` is the single Edge instance; `Log` writes to `<app>/storages/logs/averoa.log`.
- Config files must import helpers from `@averoa/utilities/paths`; `DB` is a proxy with `getDB()` / `DB.ready`.

## Related packages

| Package | Description | npm | Repository |
| --- | --- | --- | --- |
| `@averoa/core` | Builds the Express 5 app and provides the `averoa` CLI. | [npm](https://www.npmjs.com/package/@averoa/core) | [budiherma1/AveroaCore](https://github.com/budiherma1/AveroaCore) |
| `@averoa/utilities` | This package. | [npm](https://www.npmjs.com/package/@averoa/utilities) | [budiherma1/AveroaUtilities](https://github.com/budiherma1/AveroaUtilities) |
| `@averoa/routes` | Laravel-style router with `crud()` model hooks. | [npm](https://www.npmjs.com/package/@averoa/routes) | [budiherma1/AveroaRoute](https://github.com/budiherma1/AveroaRoute) |
| `averoajs` | The application boilerplate; start new projects here. | not published | [budiherma1/averoajs](https://github.com/budiherma1/averoajs) |

## Contributing

Issues and pull requests are welcome at
[github.com/budiherma1/AveroaUtilities](https://github.com/budiherma1/AveroaUtilities). Please run `npm test`,
`npm run lint` and `npm run typecheck` before opening a pull request.

## License

MIT © Budi Hermawan
