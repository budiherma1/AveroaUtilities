import type { Knex } from 'knex';
import { Model as ObjectionModel } from 'objection';
import type { FilterSearchConfig, FilterSearchResult } from './FilterSearch.js';
import type {
  Awaitable, HttpRequest, HttpResponse, NextFunction, RequestLike, ValidatorStatic,
} from './types.js';

export interface ColumnFlags {
  /** Default true. */
  required?: boolean;
  unique?: boolean;
  /** The value comes from an uploaded file. */
  upload?: boolean;
  /** Allow objects and arrays. */
  json?: boolean;
  /** Clients may write the primary key. */
  fillable?: boolean;
  /** Clients may write this hidden column. */
  writable?: boolean;
  /** false excludes the column from Model.search(). */
  search?: boolean;
}

export interface ColumnRule {
  /** `value` is String(value), or JSON for `json` columns. A falsy result adds `msg`. */
  run: (input: { validator: ValidatorStatic; value: string }) => unknown;
  msg: string;
}

export interface ColumnDefinition {
  migration?: (m: { table: Knex.CreateTableBuilder; knex: Knex; column: string }) => unknown;
  /**
   * `(faker) => value` for seeder() / seederCustom(). `faker` is the
   * @faker-js/faker instance (optional peer dependency, hence `any`).
   */
  seed?: (faker: any) => unknown;
  validation?: ColumnRule[];
  flag?: ColumnFlags;
  /** Set by the seeders to the last seeded value. */
  value?: unknown;
}

/** `static column`, keyed by column name. */
export type ColumnMap = Record<string, ColumnDefinition>;

/** `additional` argument of the crud route hooks. */
export interface RouteAdditional {
  type?: 'json' | 'multipart';
  create?: boolean;
  pref?: unknown;
}

export type ModelValidationResult =
  | { status: true }
  | { status: false; data: { column: string; message: string | string[] } };

/**
 * Objection Model with column definitions, migrations, seeders, validation
 * hooks, hidden columns and soft delete.
 *
 * In TypeScript annotate the column map so its callbacks are typed:
 * `static column: ColumnMap = { ... }`.
 */
declare class Model extends ObjectionModel {
  /** Column definitions, keyed by column name. */
  static column?: ColumnMap;
  /** Anything but false adds the audit columns and turns on soft delete. */
  static timestamp?: boolean;
  /** Columns never serialized nor selectable / filterable. */
  static hidden: string[];
  /** Relation expression clients may request with `$relations` (default: own relations, depth 1; false = none). */
  static allowGraph: string | false | undefined;
  /** Allow `$withTrashed=1`. */
  static allowWithTrashed: boolean;

  /** createTable(tableName) with every column's `migration`, then the audit columns. */
  static migrationUp(knex: Knex): Knex.SchemaBuilder;
  /** dropTable(tableName). */
  static migrationDown(knex: Knex): Knex.SchemaBuilder;

  /** Deletes every row, then inserts `number` (default 1) rows from each column's `seed`. */
  static seeder(knex: Knex): Promise<void>;
  static seeder(number: number, knex: Knex): Promise<void>;
  /** Like seeder(), with `await cb()` overriding the generated values of every row. */
  static seederCustom(number: number, cb: () => Awaitable<Record<string, unknown> | null | undefined>, knex: Knex): Promise<void>;

  /** Columns a client may write (no audit columns, pk unless `fillable`, hidden unless `writable`). */
  static writableColumns(): string[];
  /** True when a live row already has `value` in `column` (other than `exceptId`). */
  static isDuplicate(column: string, value: unknown, exceptId?: unknown): Promise<boolean>;

  /** Crud route hook: validate and whitelist req.body; 422 `{ status: false, data: { column, message } }`. */
  static validationRouter(req: HttpRequest, res: HttpResponse, next: NextFunction, additional?: RouteAdditional): Promise<unknown>;
  /** Crud route hook: `req.dataReq = req.body`, `req.routeData = pref`. */
  static mapRequest(req: HttpRequest, res: HttpResponse, next: NextFunction, additional?: RouteAdditional): unknown;
  /** Crud route hook: 404 `{ status: false, message }` when req.params.id doesn't exist (or is soft-deleted). */
  static checkParamId(req: HttpRequest, res: HttpResponse, next: NextFunction): Promise<unknown>;

  /** FilterSearch.model(this, req, config); override to customise listing. */
  static filterSearch(req: RequestLike, config?: FilterSearchConfig): Promise<FilterSearchResult<ObjectionModel>>;

  /** Validate a plain object (no unique check, no database access). */
  static validation(request?: Record<string, unknown>, type?: 'create' | 'update' | (string & {})): ModelValidationResult;

  /** OR `column like %search%` over the searchable columns. */
  static search<QB>(query: QB, search: string): QB;
}

export default Model;
