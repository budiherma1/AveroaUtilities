import { dialectOf, dialectOfKnex } from './config.js';
import Log from './Log.js';

export const TIMESTAMP_COLUMNS = ['created_at', 'created_by', 'updated_at', 'updated_by', 'deleted_at', 'deleted_by'];

const RESERVED = new Set(['limit', 'page', '$relations', '$relations-type', '$select', '$withTrashed', 'orderBy', 'orderByDesc', 'groupBy']);
/** Query keys that are never filters (jQuery/DataTables cache buster). */
const IGNORED = new Set(['_']);
const OPERATORS = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'like', 'ilike', 'in', 'notNull', 'isNull', 'btwn', 'search']);
const COMPARE = {
  eq: '=', neq: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=',
};

/** Thrown for invalid client filters; FilterSearch.model/knex turn it into `{ status:false, message, statusCode: 400 }`. */
export class FilterSearchError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'FilterSearchError';
    this.statusCode = statusCode;
  }
}

/** Error whose message is safe to show to API clients (e.g. "Model X not found"). */
export class PublicError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'PublicError';
    this.statusCode = statusCode;
    this.expose = true;
  }
}

const SAFE_ERROR_NAMES = new Set(['FilterSearchError', 'PublicError', 'ValidationError', 'NotFoundError']);

/** HTTP status for an error whose message is shown to the client. */
function exposedStatus(e) {
  if (e.name === 'ValidationError') return 422;
  if (e.name === 'NotFoundError') return 404;
  const code = e.statusCode ?? e.status;
  return Number.isInteger(code) && code >= 400 && code <= 599 ? code : 400;
}

/** True for driver / knex / objection DB errors (their messages contain SQL and bound values). */
function isDatabaseError(e) {
  return Boolean(e && typeof e === 'object' && (
    'nativeError' in e || 'sql' in e || 'errno' in e || 'sqlState' in e || 'sqlMessage' in e
    || (typeof e.code === 'string' && /^(ER_|SQLITE_|ECONNREFUSED|ETIMEDOUT|PROTOCOL_)|^[0-9A-Z]{5}$/.test(e.code))
  ));
}

/**
 * Turn an error caught by FilterSearch/Crud into a client-safe result
 * `{ status:false, message, statusCode }`.
 * Filter/validation errors keep their message; database errors (whose
 * messages contain the interpolated SQL, including values such as password
 * hashes) and other unexpected errors get a generic message and are logged.
 * `statusCode`: FilterSearchError 400, Objection ValidationError 422,
 * NotFoundError 404, PublicError / `expose` errors their own code, anything else 500.
 */
export function errorResult(e, where = 'query') {
  if (e && (SAFE_ERROR_NAMES.has(e.name) || e.expose === true)) {
    return { status: false, message: e.message, statusCode: exposedStatus(e) };
  }
  const db = isDatabaseError(e);
  Log.error(`${where} failed: ${e?.stack ?? e}`);
  return { status: false, message: db ? 'Database error' : 'Internal error', statusCode: 500 };
}

const isTruthyFlag = (v) => ['1', 'true', 'yes'].includes(String(v).toLowerCase());

/* ------------------------------------------------------------------------ */
/* Model helpers (also used by Crud and Model)                               */
/* ------------------------------------------------------------------------ */

/** True when soft delete applies to the model (`timestamp !== false`). */
export function usesSoftDelete(model) {
  return model?.timestamp !== false;
}

/** Hidden columns of a model (never serialized, never selectable/filterable). */
export function hiddenColumns(model) {
  return Array.isArray(model?.hidden) ? model.hidden : [];
}

/** Columns a client may select / filter / order by. */
export function allowedColumns(model) {
  const hidden = new Set(hiddenColumns(model));
  const columns = Object.keys(model?.column ?? {});
  if (usesSoftDelete(model)) columns.push(...TIMESTAMP_COLUMNS);
  return [...new Set(columns)].filter((c) => !hidden.has(c));
}

/**
 * A comma-separated string (numbers/booleans are stringified) or an array of
 * strings (repeated query key). Objects (`?id:in[a]=1`) and arrays holding
 * anything but strings throw FilterSearchError(`invalidMessage`).
 */
function splitList(value, invalidMessage) {
  let list;
  if (Array.isArray(value)) list = value;
  else if (['string', 'number', 'boolean'].includes(typeof value)) list = String(value).split(',');
  else throw new FilterSearchError(invalidMessage);
  return list.map((v) => {
    if (typeof v !== 'string') throw new FilterSearchError(invalidMessage);
    return v.trim();
  }).filter(Boolean);
}

/**
 * Validate a `$select` value (comma string or array) against the allowed
 * columns. Returns column names; throws FilterSearchError on unknown/hidden.
 */
export function parseSelect(value, allowed) {
  const set = new Set(allowed);
  const columns = splitList(value, 'invalid $select');
  if (!columns.length) throw new FilterSearchError('$select is empty');
  for (const column of columns) {
    if (!set.has(column)) throw new FilterSearchError(`column ${column} is not selectable`);
  }
  return columns;
}

/** Relation expression object of the relations a client may request. */
function allowedGraphObject(model) {
  let expression = model.allowGraph;
  if (expression === undefined || expression === null) {
    const names = Object.keys(model.getRelations?.() ?? {});
    if (!names.length) return null;
    expression = `[${names.join(', ')}]`;
  }
  if (expression === false || expression === '') return null;
  return model.query().withGraphFetched(expression).graphExpressionObject();
}

function checkGraph(requested, allowed, model, path) {
  for (const name of requested.$childNames) {
    const node = requested[name];
    const where = path ? `${path}.${name}` : name;
    const allowedNode = allowed?.[name];
    if (!allowedNode || allowedNode.$relation !== node.$relation) {
      throw new FilterSearchError(`relation ${where} is not allowed`);
    }
    const relation = model.getRelations()[node.$relation];
    if (!relation) throw new FilterSearchError(`relation ${where} doesn't exist`);
    if ((node.$recursive && !allowedNode.$recursive) || (node.$allRecursive && !allowedNode.$allRecursive)) {
      throw new FilterSearchError(`recursive relation ${where} is not allowed`);
    }
    for (const modifier of node.$modify) {
      if (!allowedNode.$modify.includes(modifier)) {
        throw new FilterSearchError(`modifier ${modifier} on ${where} is not allowed`);
      }
    }
    checkGraph(node, allowedNode, relation.relatedModelClass, where);
  }
}

/**
 * Parse and validate a client `$relations` expression against
 * `model.allowGraph` (default: the model's own relations, depth 1).
 * Returns `{ expression, graph, allowed }`; throws FilterSearchError.
 */
export function parseRelations(model, value) {
  if (typeof value !== 'string' || !value.trim()) throw new FilterSearchError('invalid $relations');
  const allowed = allowedGraphObject(model);
  if (!allowed) throw new FilterSearchError('relations are not allowed on this resource');
  let graph;
  try {
    graph = model.query().withGraphFetched(value).graphExpressionObject();
  } catch (e) {
    throw new FilterSearchError(`invalid $relations: ${e.message}`);
  }
  checkGraph(graph, allowed, model, '');
  return { expression: value, graph };
}

function graphPaths(graph, model, prefix = '') {
  const out = [];
  for (const name of graph.$childNames) {
    const node = graph[name];
    const relation = model.getRelations()[node.$relation];
    const path = prefix ? `${prefix}.${name}` : name;
    out.push({ path, related: relation.relatedModelClass });
    out.push(...graphPaths(node, relation.relatedModelClass, path));
  }
  return out;
}

/**
 * Apply a validated relation expression to an Objection query builder:
 * allowGraph, withGraphFetched/Joined, and soft-delete filtering of related rows.
 */
export function applyRelations(builder, model, parsed, type = 'fetch') {
  const allowed = model.allowGraph ?? `[${Object.keys(model.getRelations()).join(', ')}]`;
  builder.allowGraph(allowed);
  if (type === 'join') builder.withGraphJoined(parsed.expression);
  else builder.withGraphFetched(parsed.expression);
  for (const { path, related } of graphPaths(parsed.graph, model)) {
    if (usesSoftDelete(related)) {
      builder.modifyGraph(path, (b) => b.whereNull(`${related.tableName}.deleted_at`));
    }
  }
  return builder;
}

const NOT_DELETED = 'averoaNotDeleted';

/** Builder modifier: `<table>.deleted_at IS NULL` for soft-delete models. */
function notDeleted(builder) {
  const model = builder.modelClass();
  if (usesSoftDelete(model)) builder.whereNull(`${builder.tableRefFor(model)}.deleted_at`);
}

/** Copy of a graph expression object with the soft-delete modifier on every soft-delete node. */
function withSoftDeleteModifiers(graph, model) {
  const out = { ...graph, $modify: [...(graph.$modify ?? [])] };
  for (const name of graph.$childNames ?? []) {
    const node = graph[name];
    const related = model.getRelations()[node.$relation].relatedModelClass;
    const child = withSoftDeleteModifiers(node, related);
    if (usesSoftDelete(related) && !child.$modify.includes(NOT_DELETED)) child.$modify.push(NOT_DELETED);
    out[name] = child;
  }
  return out;
}

/**
 * LEFT JOIN the requested relations (for filtering/counting on related
 * columns). Soft-deleted related rows are excluded inside the join, so they
 * can't be matched by filters, and parents without (live) children are kept.
 */
export function leftJoinRelations(builder, model, parsed) {
  builder.modifiers({ [NOT_DELETED]: notDeleted });
  return builder.leftJoinRelated(withSoftDeleteModifiers(parsed.graph, model));
}

/** Apply soft-delete filtering to a model query (`deleted_at IS NULL`). */
export function applySoftDelete(builder, model) {
  if (usesSoftDelete(model)) builder.whereNull(`${model.tableName}.deleted_at`);
  return builder;
}

/**
 * Name (or alias) of a knex builder's single FROM table, for qualifying
 * `deleted_at`: `'users'` → users, `'users as u'` → u, `{ u: 'users' }` → u.
 * null for anything else (raw, subquery, no table) — the column then stays unqualified.
 */
export function baseTableRef(builder) {
  let from;
  try {
    from = builder?._single?.table;
  } catch {
    return null;
  }
  if (typeof from === 'string') {
    const m = /^\s*([\w$.]+)(?:\s+as\s+([\w$]+))?\s*$/i.exec(from);
    return m ? (m[2] ?? m[1]) : null;
  }
  if (from && typeof from === 'object' && Object.getPrototypeOf(from) === Object.prototype) {
    const keys = Object.keys(from);
    if (keys.length === 1 && typeof from[keys[0]] === 'string' && /^[\w$]+$/.test(keys[0])) return keys[0];
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* FilterSearch                                                              */
/* ------------------------------------------------------------------------ */

class FilterSearch {
  /**
   * Filter/paginate an Objection model from `req.query`.
   * Resolves `{ status:true, metadata, data }` or `{ status:false, message, statusCode }`.
   */
  static async model(model, req, config = {}) {
    try {
      return await new this().init('model', model, req, config);
    } catch (e) {
      return errorResult(e, `FilterSearch.model(${model?.name ?? '?'})`);
    }
  }

  /**
   * Filter/paginate a knex query builder. `config.column` (array) is the
   * whitelist; `config.hidden`, `config.timestamp`, `config.maxLimit` optional.
   */
  static async knex(builder, req, config = {}) {
    if (!Array.isArray(config.column)) {
      return { status: false, message: 'need to define column array', statusCode: 500 };
    }
    try {
      return await new this().init('knex', builder, req, config);
    } catch (e) {
      return errorResult(e, 'FilterSearch.knex');
    }
  }

  async init(type, table, req, config) {
    this.type = type;
    this.table = table;
    this.config = config;
    // never mutate req.query (Express 5 getter); work on a copy
    this.filter = { ...(req?.query ?? {}) };
    this.maxLimit = Number.isInteger(config.maxLimit) && config.maxLimit > 0 ? config.maxLimit : 1000;

    if (type === 'model') {
      this.tableName = table.tableName;
      this.idColumn = Array.isArray(table.idColumn) ? table.idColumn[0] : table.idColumn;
      this.dialect = dialectOfKnex(table.knex());
      this.softDelete = usesSoftDelete(table);
      this.allowed = allowedColumns(table);
    } else {
      this.tableName = null;
      this.dialect = dialectOf(table.client?.config?.client ?? table.client?.dialect);
      this.softDelete = Boolean(config.timestamp) && config.softDelete !== false;
      const base = typeof config.table === 'string' && config.table.trim() ? config.table.trim() : baseTableRef(table);
      this.deletedAtColumn = base ? `${base}.deleted_at` : 'deleted_at';
      const hidden = new Set(config.hidden ?? []);
      this.allowed = [...new Set([...config.column, ...(config.timestamp ? TIMESTAMP_COLUMNS : [])])]
        .filter((c) => !hidden.has(c));
      this.hasHidden = hidden.size > 0;
    }
    this.allowedSet = new Set(this.allowed);

    const limit = this.parseInteger('limit', this.filter.limit ?? config.limit ?? 10, 0);
    const page = this.parseInteger('page', this.filter.page ?? config.page ?? 1, 1);
    const effectiveLimit = limit === 0 ? this.maxLimit : Math.min(limit, this.maxLimit);

    this.parseRelations();
    this.parseWithTrashed();
    const filters = this.collectFilters();
    const select = this.filter.$select !== undefined ? parseSelect(this.filter.$select, this.allowed) : null;
    const order = this.parseOrder();
    const groupBy = this.filter.groupBy !== undefined ? this.ownColumn(this.filter.groupBy, 'groupBy') : null;

    const base = () => {
      const builder = type === 'model' ? table.query() : table.clone();
      if (this.softDelete && !this.withTrashed) {
        builder.whereNull(type === 'model' ? this.qualify('deleted_at') : this.deletedAtColumn);
      }
      for (const apply of filters) apply(builder);
      return builder;
    };

    const joinMode = this.relations && this.relationsType === 'join';
    const pk = this.qualify(this.idColumn);

    // ---- count (on a copy without select/order: a knex builder passed in may
    // already have them, which is invalid SQL next to count() on pg/MySQL)
    const countBuilder = base().clearSelect().clearOrder();
    if (joinMode) leftJoinRelations(countBuilder, table, this.relations);
    let countRow;
    if (groupBy) {
      countRow = await countBuilder.countDistinct({ $count: groupBy });
    } else if (joinMode) {
      countRow = await countBuilder.countDistinct({ $count: pk });
    } else {
      countRow = await countBuilder.count({ $count: '*' });
    }
    const count = Number(countRow?.[0]?.$count ?? 0);

    // ---- data
    let data;
    const offset = (page - 1) * effectiveLimit;
    if (joinMode) {
      // paginate on root ids first, then load the joined graph for those ids
      const idsBuilder = leftJoinRelations(base(), table, this.relations).distinct(pk);
      if (order) idsBuilder.select(order.column).orderBy(order.column, order.direction);
      const idRows = await idsBuilder.limit(effectiveLimit).offset(offset);
      const ids = idRows.map((r) => r[this.idColumn]);
      if (!ids.length) {
        data = [];
      } else {
        const dataBuilder = table.query().whereIn(pk, ids);
        if (select) dataBuilder.select(select.map((c) => this.qualify(c)));
        applyRelations(dataBuilder, table, this.relations, 'join');
        if (order) dataBuilder.orderBy(order.column, order.direction);
        data = await dataBuilder;
      }
    } else {
      const dataBuilder = base();
      if (select) dataBuilder.select(select.map((c) => this.qualify(c)));
      else if (type === 'knex' && this.hasHidden) dataBuilder.select(this.allowed);
      if (groupBy) dataBuilder.groupBy(groupBy);
      if (this.relations) applyRelations(dataBuilder, table, this.relations, 'fetch');
      if (order) dataBuilder.orderBy(order.column, order.direction);
      data = await dataBuilder.limit(effectiveLimit).offset(offset);
    }

    const pageTotal = effectiveLimit > count ? 1 : Math.ceil(count / effectiveLimit);
    return {
      status: true,
      metadata: {
        item_total: count,
        per_page: effectiveLimit > count ? count : effectiveLimit,
        page_total: pageTotal,
        current_page: page,
        has_next_page: page < pageTotal,
        has_prev_page: page !== 1 && page <= pageTotal,
      },
      data,
    };
  }

  parseInteger(name, value, min) {
    const str = String(value);
    if (!/^\d+$/.test(str)) throw new FilterSearchError(`${name} must be an integer >= ${min}`);
    const n = Number(str);
    if (!Number.isSafeInteger(n) || n < min) throw new FilterSearchError(`${name} must be an integer >= ${min}`);
    return n;
  }

  qualify(column) {
    return this.tableName ? `${this.tableName}.${column}` : column;
  }

  parseRelations() {
    this.relations = null;
    this.relationsType = this.filter['$relations-type'] === 'join' ? 'join' : 'fetch';
    if (this.filter.$relations === undefined) return;
    if (this.type !== 'model') throw new FilterSearchError('$relations is only supported for models');
    this.relations = parseRelations(this.table, this.filter.$relations);
  }

  parseWithTrashed() {
    this.withTrashed = false;
    const value = this.filter.$withTrashed;
    if (value === undefined || !isTruthyFlag(value)) return;
    if (this.type !== 'model' || this.table.allowWithTrashed !== true) {
      throw new FilterSearchError('$withTrashed is not allowed on this resource');
    }
    this.withTrashed = true;
  }

  parseOrder() {
    if (this.filter.orderByDesc !== undefined) {
      return { column: this.ownColumn(this.filter.orderByDesc, 'orderByDesc'), direction: 'desc' };
    }
    if (this.filter.orderBy !== undefined) {
      return { column: this.ownColumn(this.filter.orderBy, 'orderBy'), direction: 'asc' };
    }
    return null;
  }

  /** Own (root table) column, qualified. */
  ownColumn(value, label) {
    if (typeof value !== 'string') throw new FilterSearchError(`invalid ${label}`);
    const name = this.tableName && value.startsWith(`${this.tableName}.`) ? value.slice(this.tableName.length + 1) : value;
    if (!this.allowedSet.has(name)) throw new FilterSearchError(`column ${value} doesn't exist`);
    return this.qualify(name);
  }

  /**
   * Resolve a filter column: own column (`col` or `table.col`) or, with
   * `$relations-type=join`, a column of a requested relation (`relation.col`).
   */
  resolveColumn(raw) {
    // knex mode: whitelist entries may be qualified ('u.id'); match them as-is
    if (this.type === 'knex' && this.allowedSet.has(raw)) return raw;
    if (this.tableName && raw.startsWith(`${this.tableName}.`)) {
      return this.ownColumn(raw, 'column');
    }
    if (!raw.includes('.')) return this.ownColumn(raw, 'column');

    const dot = raw.lastIndexOf('.');
    const relationName = raw.slice(0, dot);
    const column = raw.slice(dot + 1);
    if (this.type === 'model' && this.relations && this.relationsType === 'join'
      && !relationName.includes('.') && this.relations.graph.$childNames.includes(relationName)) {
      const node = this.relations.graph[relationName];
      const related = this.table.getRelations()[node.$relation].relatedModelClass;
      if (allowedColumns(related).includes(column)) return `${relationName}.${column}`;
    }
    throw new FilterSearchError(`column ${raw} doesn't exist`);
  }

  scalar(key, value) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    throw new FilterSearchError(`invalid value for ${key}`);
  }

  /** Build `(builder, column, boolean)` appliers for each filter key. */
  operator(op, key, value) {
    const like = (col, pattern, b, or) => {
      if (this.dialect === 'mysql') {
        b[or ? 'orWhereRaw' : 'whereRaw']('?? like binary ?', [col, pattern]);
      } else {
        b[or ? 'orWhere' : 'where'](col, 'like', pattern);
      }
    };
    const ilikeOp = this.dialect === 'pg' ? 'ilike' : 'like';

    switch (op) {
      case 'eq': case 'neq': case 'lt': case 'lte': case 'gt': case 'gte': {
        const v = this.scalar(key, value);
        return (b, col, or) => b[or ? 'orWhere' : 'where'](col, COMPARE[op], v);
      }
      case 'like': {
        const v = this.scalar(key, value);
        return (b, col, or) => like(col, v, b, or);
      }
      case 'ilike': {
        const v = this.scalar(key, value);
        return (b, col, or) => b[or ? 'orWhere' : 'where'](col, ilikeOp, v);
      }
      case 'in': {
        const list = splitList(value, `invalid value for ${key}`);
        return (b, col, or) => b[or ? 'orWhereIn' : 'whereIn'](col, list);
      }
      case 'notNull':
        return (b, col, or) => b[or ? 'orWhereNotNull' : 'whereNotNull'](col);
      case 'isNull':
        return (b, col, or) => b[or ? 'orWhereNull' : 'whereNull'](col);
      case 'btwn': {
        const range = splitList(value, `invalid value for ${key}`);
        if (range.length !== 2) throw new FilterSearchError(`${key} needs two comma separated values`);
        return (b, col, or) => b[or ? 'orWhereBetween' : 'whereBetween'](col, range);
      }
      case 'search': {
        const words = this.scalar(key, value).split(' ').filter(Boolean);
        return (b, col, or) => b[or ? 'orWhere' : 'where']((inner) => {
          for (const w of words) inner.orWhere(col, ilikeOp, `%${w}%`);
        });
      }
      default:
        throw new FilterSearchError(`unknown operator ${op}`);
    }
  }

  /** resolveColumn, or null when `raw` is not a filterable column. */
  tryResolveColumn(raw) {
    try {
      return this.resolveColumn(raw);
    } catch (e) {
      if (e instanceof FilterSearchError) return null;
      throw e;
    }
  }

  /**
   * Validate the query keys; returns a list of `(builder) => void`.
   *
   * - `col:op=value` (op a known operator) is strict: an unknown or hidden
   *   column is an error. `col:op` with an unknown op on a known column too.
   * - `col=value` filters on a known column. Anything else (cache busters
   *   like `_`, `utm_*`, DataTables' `draw`/`columns[...]`, hidden columns
   *   such as `password`) is ignored, never applied.
   */
  collectFilters() {
    const filters = [];
    for (const key of Object.keys(this.filter)) {
      if (RESERVED.has(key) || IGNORED.has(key)) continue;
      const value = this.filter[key];

      const sep = key.lastIndexOf(':');
      if (sep === -1) {
        // bare `column=value` → equality; not a known column → not a filter
        const col = this.tryResolveColumn(key);
        if (col === null) continue;
        const v = this.scalar(key, value);
        filters.push((b) => b.where(col, '=', v));
        continue;
      }

      const op = key.slice(sep + 1);
      const names = key.slice(0, sep).split('|');
      if (!OPERATORS.has(op)) {
        // `x:y` that targets no known column is not a filter (e.g. a tracking param)
        if (names.every((c) => this.tryResolveColumn(c) === null)) continue;
        throw new FilterSearchError(`unknown operator ${op}`);
      }
      const columns = names.map((c) => this.resolveColumn(c));
      const apply = this.operator(op, key, value);

      if (columns.length === 1) {
        filters.push((b) => apply(b, columns[0], false));
      } else {
        filters.push((b) => b.where((inner) => {
          for (const col of columns) apply(inner, col, true);
        }));
      }
    }
    return filters;
  }
}

export default FilterSearch;
