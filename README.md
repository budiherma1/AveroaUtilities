<h1 align="center">@averoa/utilities</h1>

<p align="center">
  <b>Models, one-line CRUD and a query-string filter language for <a href="https://github.com/budiherma1/averoajs">AveroaJS</a>.</b><br>
  Plus DB (Knex), Mail, Queue (RabbitMQ), View (Edge), Fetch (axios), Log (winston) and Validator.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@averoa/utilities"><img src="https://img.shields.io/npm/v/@averoa/utilities?color=cb3837&logo=npm" alt="npm version"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18.17-339933?logo=node.js&logoColor=white" alt="Node.js >= 18.17">
  <img src="https://img.shields.io/badge/express-5-000000?logo=express&logoColor=white" alt="Express 5">
  <img src="https://img.shields.io/badge/module-ESM-f7df1e" alt="ESM only">
</p>

---

> **Starting a new project?** Use the [AveroaJS boilerplate](https://github.com/budiherma1/averoajs). It already
> uses this package. This page is the reference for the package itself.

## ✨ Highlights

| | |
| --- | --- |
| 🧱 **Models that describe themselves**<br>One `static column` map drives migrations, seeders and request validation. | 🔎 **FilterSearch**<br>`?saldo:gte=1000&orderByDesc=id&$relations=[rooms]`, checked against the model's columns. |
| ⚡ **Crud in one line**<br>`Crud.findAll('Teacher', req)` returns filtered, paginated JSON. Soft delete is built in. | 🙈 **Hidden columns**<br>`static hidden = ['password']` keeps a column out of JSON, `$select`, filters and `orderBy`. |
| 📬 **Mail + queue**<br>Edge-templated mail, sent directly or queued, and a worker that retries failed sends. | 🧭 **Finds your app**<br>Locates the app root without `../../..` paths, so it works with pnpm, workspaces and monorepos. |

## 📦 Install

```sh
npm i @averoa/utilities knex objection edge.js mysql2
npm i -D @faker-js/faker   # only for seeders
```

`knex` ^3, `objection` ^3 and `edge.js` ^5 are peer dependencies. `@faker-js/faker` is an optional peer, needed only
for seeders. ESM only, Node >= 18.17.

```js
import {
  Model, Crud, FilterSearch, DB, Mail, Queue, closeQueue, startMailWorker,
  Fetch, Log, View, Validator, appPath, importApp,
} from '@averoa/utilities';
import { appRoot } from '@averoa/utilities/paths'; // paths only, no knex/config
```

<details>
<summary><b>All exports</b></summary>

| Export | What it is |
| --- | --- |
| `Model` | Objection `Model` subclass with column definitions, migrations, seeders, validation and crud hooks |
| `Crud` | `create`, `findAll`, `findOne`, `update`, `delete` for a model |
| `FilterSearch`, `FilterSearchError` | query-string filtering and pagination for models or Knex builders |
| `DB` | the app's Knex instance |
| `Mail` | fluent nodemailer builder (direct or queued) |
| `Queue`, `closeQueue` | publish to a durable RabbitMQ queue / close the shared connection |
| `startMailWorker`, `MailWorker` | mail queue consumer |
| `Fetch` | axios instance |
| `Log` | winston logger |
| `View` | the app's single Edge instance |
| `Validator` | the [validator](https://www.npmjs.com/package/validator) package |
| `appRoot`, `appPath`, `appHas`, `importApp`, `importAppDefault`, `resetAppRoot` | app-root helpers (also at `@averoa/utilities/paths`) |

</details>

## 📁 App files

The app root is `AVEROA_ROOT`, or the nearest `package.json` above `process.cwd()`.
These files are optional. The env fallbacks apply when a file is missing:

| file | used by | fallback |
|---|---|---|
| `config/database.js` | `DB` | `DB_CLIENT` (mysql2), `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME` |
| `config/mail.js` | `Mail`, `startMailWorker` | `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_QUEUE` |
| `config/queue.js` (`{ amqp, heartbeat }`) | `Queue` | `RABBITMQ_SERVER` |
| `config/fetch.js` (axios config) | `Fetch` | `FETCH_BASE_URL`, `FETCH_TIMEOUT` |
| `app/Models/index.js` | `Crud` | — |
| `app/Providers/index.js` (`UploadProvider`) | `Crud` uploads | — |
| `resources/views/*.edge` | `View`, `Mail.html()` | — |

Config files may export an object or a function `(process) => object`. `Log` writes to
`<app>/storages/logs/averoa.log` (created if missing) at level `LOG_LEVEL`.

## 🧱 Models

```js
import { Model } from '@averoa/utilities';
import Posts from './Posts.js';

export default class Users extends Model {
  static tableName = 'users';
  static timestamp = true;            // adds created_*/updated_*/deleted_* + soft delete
  static hidden = ['password'];       // never serialized, never selectable/filterable
  static allowGraph = '[posts]';      // optional; default = own relations, depth 1; false = none
  static allowWithTrashed = false;    // allow ?$withTrashed=1

  static column = {
    id: { migration: (m) => m.table.increments(m.column).primary(), flag: { required: false } },
    email: {
      migration: (m) => m.table.string(m.column, 100),
      seed: (f) => f.internet.email(),
      flag: { required: true, unique: true },
      validation: [{ run: (v) => v.validator.isEmail(v.value), msg: 'email format required' }],
    },
    password: { migration: (m) => m.table.string(m.column), flag: { required: true } },
  };

  static relationMappings = () => ({
    posts: { relation: Model.HasManyRelation, modelClass: Posts, join: { from: 'users.id', to: 'posts.user_id' } },
  });
}
```

Bind knex once at startup (`@averoa/core` does this): `Model.knex(DB)`.

| Column key | Purpose |
| --- | --- |
| `migration: (m) => ...` | `m.table`, `m.column`, `m.knex`, used by `Model.migrationUp(knex)` |
| `seed: (f) => ...` | `f` is faker, used by `Model.seeder(number?, knex)` / `Model.seederCustom(number, cb, knex)` |
| `validation: [{ run, msg }]` | `run({ validator, value })` returns `false` to fail with `msg` |
| `flag` | `required` (default true), `unique`, `upload`, `search` (default true), `fillable` (allow writing the primary key from the request) |

```js
// database/migrations/xxxx_users.js
import { Users } from '#models';

export const up = Users.migrationUp.bind(Users);
export const down = Users.migrationDown.bind(Users);
```

With `timestamp !== false`, `migrationUp` adds `created_at`, `created_by`, `updated_at`, `updated_by`, `deleted_at`
and `deleted_by` (using `ON UPDATE CURRENT_TIMESTAMP` on MySQL only), and every read skips soft-deleted rows.

**Crud route middleware** (used by `@averoa/routes`): `checkParamId` (404), `validationRouter` (422),
`mapRequest`. For your own code there is also `Model.validation(object, 'create' | 'update')`, which returns
`{ status: true }` or `{ status: false, data: { column, message } }`.

## ⚡ Crud

```js
import { Crud } from '@averoa/utilities';

class TeacherController {
  async findAll(req, res) { res.json(await Crud.findAll('Teacher', req)); }
  async findOne(req, res) { res.json(await Crud.findOne('Teacher', req)); }
  async create(req, res)  { res.json(await Crud.create('Teacher', req)); }
  async update(req, res)  { res.json(await Crud.update('Teacher', req)); }
  async delete(req, res)  { res.json(await Crud.delete('Teacher', req)); }
}
```

| Method | Returns |
| --- | --- |
| `Crud.findAll(model, req)` | `{ status, metadata, data }` via FilterSearch. With `?$datatable=1` (and `$draw`), it returns the DataTables shape `{ draw, recordsTotal, recordsFiltered, data }` |
| `Crud.findOne(model, req)` | `{ status: true, data }`. Supports `$select` and `$relations` |
| `Crud.create(model, req, { insert }?, trx?)` | `{ status: true, data }`. Uploads from `req.dataFiles` go through `UploadProvider` |
| `Crud.update(model, req, { update }?, trx?)` | `{ status }`. Never overwrites `created_by` / `created_at`, sets `updated_at` / `updated_by` |
| `Crud.delete(model, req, { update }?, trx?)` | `{ status }`. A soft delete (`deleted_at`, `deleted_by`), or a hard delete when `timestamp: false` |

`model` is a name from `app/Models/index.js` or a model class. Failures resolve to `{ status: false, message }`.
`create`/`update` from a raw `req.body` only write known, non-hidden model columns. `req.dataReq`, which the crud route
middleware sets, is trusted. `created_by` / `updated_by` / `deleted_by` come from `req.user.id`.

## 🔎 Query string (FilterSearch / `Crud.findAll`)

| Parameter | Meaning |
| --- | --- |
| `col=v` | equals |
| `col:eq` · `:neq` · `:lt` · `:lte` · `:gt` · `:gte` `=v` | `=`, `!=`, `<`, `<=`, `>`, `>=` |
| `col:like=v` | `like`, parameterized (`?? like binary ?` on MySQL) |
| `col:ilike=v` | `ilike` on PostgreSQL, `like` elsewhere |
| `col:in=a,b` | `in` |
| `col:btwn=a,b` | `between` (exactly two values) |
| `col:isNull=` · `col:notNull=` | `is null` / `is not null` |
| `a\|b:search=words` | each word as `%word%` in any of the columns (`ilike` on PostgreSQL) |
| `a\|b:op=v` | the operator on several columns, joined with `OR` |
| `orderBy=col` · `orderByDesc=col` | sort (own columns only) |
| `groupBy=col` | group (own columns only) |
| `limit` | page size, default 10. `0` = all, up to `maxLimit` (default 1000) |
| `page` | page number, >= 1 |
| `$select=a,b` | columns (+ timestamp columns), minus hidden |
| `$relations=[posts]` | relations, validated against `static allowGraph` |
| `$relations-type=join` | join instead of fetch. Then `posts.title=x` filters on the relation |
| `$withTrashed=1` | include soft-deleted rows, only with `static allowWithTrashed = true` |

Examples:

```text
/api/teachers?saldo:gte=100000&orderByDesc=created_at&limit=20&page=2
/api/teachers?teacher_name|address:search=ada%20london
/api/teachers?$select=id,teacher_name&$relations=[rooms]
```

Unknown columns or operators, non-scalar values and invalid `limit` / `page` return `{ status:false, message }`
instead of being silently ignored.

Response: `{ status, metadata: { item_total, per_page, page_total, current_page, has_next_page, has_prev_page }, data }`
or `{ status:false, message }`.

Knex mode: `FilterSearch.knex(DB('users'), req, { column: [...], hidden: [...], timestamp: true, maxLimit })`.

## 📬 Mail & queue

```js
await Mail.init().to('a@b.c').subject('Hi').html('emails/welcome', { name }).send();         // direct
await Mail.init().to('a@b.c').subject('Hi').html('emails/welcome', { name }).queue().send(); // queued

const worker = await startMailWorker({ prefetch: 5, maxRetries: 3 });
process.on('SIGTERM', async () => { await worker.stop(); await closeQueue(); });

await Queue('jobs', { any: 'json' }); // durable queue, persistent message, waits for confirm
```

`Mail` methods: `from`, `to`, `subject`, `html(viewOrHtml, vars)` (strings containing `<` are used as raw HTML),
`text`, `attachments`, `additional`, `queue(name?)` and `send()`. `.queue()` with no name uses `config/mail.js`
`queue`, env `MAIL_QUEUE`, or `'mail'`. The worker re-publishes a failed send up to `maxRetries` times, then rejects it,
and drops malformed messages.

## 🔑 Auth helper

```js
import Auth from '@averoa/utilities/AuthSandbox.js';

const auth = Auth(req); // one per request
if (auth.check()) auth.user();
await auth.logout();
```

## 🧪 Tests

`npm test` (node:test + better-sqlite3, no MySQL/RabbitMQ needed).

## 🆙 Upgrading from 1.x

2.0.0 requires Node >= 18.17 and is ESM only. The full list of breaking changes is in
[CHANGELOG.md](./CHANGELOG.md).

<details>
<summary><b>Highlights</b></summary>

- **No more `./../../../` imports.** App files are found through `@averoa/utilities/paths`.
- **HTTP status codes** in crud middleware: `validationRouter` → **422**, `checkParamId` → **404** (both were 200).
- **Soft delete is enforced** for every model with `timestamp !== false`. `Crud.delete` hard-deletes models with
  `timestamp: false`.
- **`static hidden`**, a strict **`$select`**, and **`$relations`** validated against `static allowGraph`.
- **Filters are strict**: unknown columns, operators and bad values return `{ status:false, message }`.
- **`limit`** is capped by `maxLimit` (default 1000). `limit=0` means "all, up to maxLimit".
- **`:like`** is parameterized. `:ilike` and `:search` use `ilike` on PostgreSQL.
- **`$relations-type=join`** paginates on root rows.
- **Crud** writes only known columns from a raw body, and models load from `app/Models/index.js` (no more
  `@averoa/models`). `moment` was removed.
- **Queue** uses one lazy connection, durable queues and persistent messages. `Queue()` resolves after the broker
  confirm.
- **MailWorker** is a real consumer: `startMailWorker()` returns `{ stop() }`.
- **AuthSandbox** is a per-request factory `Auth(req)`.
- **View** is the single Edge instance. **Log** writes to `<app>/storages/logs/averoa.log`.

</details>

## 🧩 Ecosystem

| Package | What it does |
| --- | --- |
| [averoajs](https://github.com/budiherma1/averoajs) | the boilerplate: start here |
| [@averoa/core](https://github.com/budiherma1/AveroaCore) | builds the Express 5 app and the `averoa` CLI |
| **[@averoa/utilities](https://github.com/budiherma1/AveroaUtilities)** | this package |
| [@averoa/routes](https://github.com/budiherma1/AveroaRoute) | Laravel-style router with `crud()` model hooks |

## 🤝 Contributing

Issues and pull requests are welcome at
[github.com/budiherma1/AveroaUtilities](https://github.com/budiherma1/AveroaUtilities). Please run `npm test` before
you open a pull request.

## License

MIT © Budi Hermawan
