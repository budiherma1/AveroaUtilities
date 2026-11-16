import { Model as Objection } from 'objection';
import validator from 'validator';
import FilterSearch, {
  TIMESTAMP_COLUMNS, applySoftDelete, hiddenColumns,
} from './FilterSearch.js';
import { dialectOfKnex } from './config.js';

// @faker-js/faker is a devDependency of apps: load it only when seeding.
async function loadFaker() {
  try {
    const mod = await import('@faker-js/faker');
    return mod.faker ?? mod.default?.faker ?? mod.default;
  } catch (e) {
    throw new Error(`Model seeder needs @faker-js/faker (npm i -D @faker-js/faker): ${e.message}`);
  }
}

const isEmpty = (v) => v === '' || v === undefined || v === null;

/** Objects/arrays are only accepted for columns flagged `json: true`. */
const isStructured = (v) => v !== null && typeof v === 'object';

/** The string validators see: JSON for json columns, String(value) otherwise. */
const ruleValue = (def, v) => (def?.flag?.json === true && isStructured(v) ? JSON.stringify(v) : `${v}`);

class Model extends Objection {
  /** Columns never serialized (toJSON / res.send) nor selectable via `$select`. */
  static hidden = [];

  /**
   * Relation expression clients may request with `$relations`.
   * Default (undefined): the model's own relationMappings keys, depth 1.
   * Set `false` to disable relations entirely.
   */
  static allowGraph = undefined;

  /** Allow `$withTrashed=1` to include soft-deleted rows. */
  static allowWithTrashed = false;

  $formatJson(json) {
    const out = super.$formatJson(json);
    for (const column of hiddenColumns(this.constructor)) delete out[column];
    return out;
  }

  static migrationUp(knex) {
    return knex.schema.createTable(this.tableName, (table) => {
      for (const key in this.column) {
        if (typeof this.column[key].migration === 'function') {
          this.column[key].migration({ table, knex, column: key });
        }
      }
      if (this.timestamp !== false) {
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.bigint('created_by', 14).nullable();

        if (dialectOfKnex(knex) === 'mysql') {
          table.timestamp('updated_at').defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')).nullable();
        } else {
          table.timestamp('updated_at').defaultTo(knex.fn.now()).nullable();
        }

        table.bigint('updated_by', 14).nullable();
        table.timestamp('deleted_at').nullable();
        table.bigint('deleted_by', 14).nullable();
      }
    });
  }

  static migrationDown(knex) {
    return knex.schema.dropTable(this.tableName);
  }

  // seeder(number?, knex) — knex is always the last argument
  static async seeder(...args) {
    const knex = args[args.length - 1];
    const number = typeof args[0] === 'number' ? args[0] : 1;
    const faker = await loadFaker();
    await knex(this.tableName).del();
    const data = [];

    for (let i = 1; i <= number; i++) {
      const seeds = {};
      const column = { ...this.column };

      for (const key in column) {
        if (typeof column[key].seed === 'function') {
          const seed = column[key].seed(faker);
          seeds[key] = seed;
          column[key].value = seed;
        }
      }

      data.push(seeds);
    }

    if (data.length) await knex(this.tableName).insert(data);
  }

  // seederCustom(number, cb, knex)
  static async seederCustom(number, cb, knex) {
    const faker = await loadFaker();
    await knex(this.tableName).del();
    const data = [];

    // let `cb` query other models without opening a second pool
    if (!Objection.knex()) Objection.knex(knex);

    for (let i = 1; i <= number; i++) {
      const seeds = {};
      const column = { ...this.column };
      const custom = (await cb()) ?? {};
      for (const key in column) {
        if (key in custom) {
          seeds[key] = custom[key];
          column[key].value = custom[key];
        } else if (typeof column[key].seed === 'function') {
          const seed = column[key].seed(faker);
          seeds[key] = seed;
          column[key].value = seed;
        }
      }

      data.push(seeds);
    }

    if (data.length) await knex(this.tableName).insert(data);
  }

  /**
   * Columns the client may write through crud routes / a raw req.body:
   * no pk unless `flag.fillable`, no audit columns, no hidden columns unless
   * `flag.writable: true` (e.g. a password column that `$beforeInsert` hashes).
   */
  static writableColumns() {
    const ids = [].concat(this.idColumn);
    const hidden = hiddenColumns(this);
    return Object.keys(this.column ?? {}).filter((key) => {
      const flag = this.column[key]?.flag;
      if (TIMESTAMP_COLUMNS.includes(key)) return false;
      if (ids.includes(key) && flag?.fillable !== true) return false;
      if (hidden.includes(key) && flag?.writable !== true) return false;
      return true;
    });
  }

  static async isDuplicate(column, value, exceptId) {
    const query = this.query().where(`${this.tableName}.${column}`, value);
    applySoftDelete(query, this);
    if (exceptId !== undefined && exceptId !== null) {
      query.whereNot(`${this.tableName}.${[].concat(this.idColumn)[0]}`, exceptId);
    }
    return (await query.resultSize()) > 0;
  }

  /**
   * Crud route middleware: validates and sanitizes req.body.
   * `additional = { type: 'json'|'multipart', create: boolean, pref }`.
   * Responds 422 `{ status:false, data:{ column, message } }` on failure.
   */
  static async validationRouter(req, res, next, additional = {}) {
    const data = req.body ?? {};
    const create = additional?.create === true;
    const sanitized = {};
    const dataFiles = {};
    const fail = (column, message) => res.status(422).send({ status: false, data: { column, message } });

    if (Array.isArray(req.files)) {
      for (const file of req.files) {
        if (this.column?.[file.fieldname]?.flag?.upload === true) {
          dataFiles[file.fieldname] = file;
        }
      }
    }

    for (const key of this.writableColumns()) {
      const def = this.column[key] ?? {};
      const required = def.flag?.required !== false;

      if (def.flag?.upload === true) {
        if (create && required && !(key in dataFiles)) return fail(key, 'required');
        continue;
      }

      if (create && required && isEmpty(data[key])) return fail(key, 'required');
      if (!(key in data)) continue;
      if (!create && required && isEmpty(data[key])) return fail(key, 'required');
      if (isStructured(data[key]) && def.flag?.json !== true) return fail(key, 'must be a scalar value');

      const messages = [];
      sanitized[key] = data[key];

      if (def.flag?.unique === true && !isEmpty(data[key])) {
        if (await this.isDuplicate(key, data[key], create ? undefined : req.params?.id)) {
          messages.push(`duplicate value ${data[key]}`);
        }
      }

      const rules = Array.isArray(def.validation) ? def.validation : [];
      for (const rule of rules) {
        if (typeof rule.run === 'function' && !rule.run({ validator, value: ruleValue(def, data[key]) })) {
          messages.push(rule.msg);
        }
      }

      if (messages.length) return fail(key, messages);
    }

    req.bodyRaw = { ...data };
    req.body = sanitized;
    if (Object.keys(dataFiles).length > 0) {
      req.dataFiles = dataFiles;
    }
    return next();
  }

  // Map req.body into req.dataReq
  static mapRequest(req, res, next, additional = {}) {
    if (additional?.type === 'multipart') {
      req.isFormData = true;
    }
    if (additional?.pref) {
      req.routeData = additional.pref;
    }
    req.dataReq = req.body ?? {};
    return next();
  }

  /** `config`: FilterSearch options (`maxLimit`, `limit`, `page`). */
  static filterSearch(req, config = {}) {
    return FilterSearch.model(this, req, config);
  }

  /** Crud route middleware: 404 `{ status:false, message }` when req.params.id doesn't exist (or is soft-deleted). */
  static async checkParamId(req, res, next) {
    const id = req.params?.id;
    if (id === undefined) return next();
    const query = this.query().findById(id).select([].concat(this.idColumn).map((c) => `${this.tableName}.${c}`));
    applySoftDelete(query, this);
    const row = await query;
    if (row) return next();
    return res.status(404).send({ status: false, message: `ID ${id} doesn't exist` });
  }

  /**
   * Validate a plain object. Returns `{ status:true }` or `{ status:false, data:{ column, message } }`.
   * Create mode requires the `writableColumns()` whose `required` is not false
   * (so not the pk unless `fillable`, nor hidden columns unless `writable`).
   */
  static validation(request = {}, type = 'create') {
    if (type === 'create') {
      for (const col of this.writableColumns()) {
        if (this.column[col]?.flag?.required !== false && isEmpty(request[col])) {
          return { status: false, data: { column: col, message: 'required' } };
        }
      }
    }

    for (const key in request) {
      if (!(key in this.column)) continue;
      const messages = [];

      if (type !== 'create' && this.column[key].flag?.required !== false && isEmpty(request[key])) {
        messages.push('required');
      }
      if (isStructured(request[key]) && this.column[key].flag?.json !== true) {
        return { status: false, data: { column: key, message: 'must be a scalar value' } };
      }

      const rules = Array.isArray(this.column[key].validation) ? this.column[key].validation : [];
      for (const rule of rules) {
        if (typeof rule.run === 'function' && !rule.run({ validator, value: ruleValue(this.column[key], request[key]) })) {
          messages.push(rule.msg);
        }
      }

      if (messages.length) return { status: false, data: { column: key, message: messages } };
    }

    return { status: true };
  }

  static search(query, search) {
    for (const key in this.column) {
      if (this.column[key].flag?.search !== false && !hiddenColumns(this).includes(key)) {
        query = query.orWhere(key, 'like', `%${search}%`);
      }
    }
    return query;
  }
}

export default Model;
