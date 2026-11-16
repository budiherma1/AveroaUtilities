import type { Knex } from 'knex';
import type { Model as ObjectionModel, ModelConstructor } from 'objection';
import type { RequestLike } from './types.js';

/** The six audit columns of soft-delete models. */
export const TIMESTAMP_COLUMNS: string[];

/** Invalid client filter; its message is safe to return to clients (status 400). */
export class FilterSearchError extends Error {
  constructor(message: string, statusCode?: number);
  name: 'FilterSearchError';
  statusCode: number;
}

/** Error whose message is safe to show to API clients. */
export class PublicError extends Error {
  constructor(message: string, statusCode?: number);
  name: 'PublicError';
  statusCode: number;
  expose: true;
}

/** Client-safe failure result of FilterSearch and Crud. */
export interface ErrorResult {
  status: false;
  message: string;
  statusCode: number;
}

export interface PaginationMetadata {
  item_total: number;
  per_page: number;
  page_total: number;
  current_page: number;
  has_next_page: boolean;
  has_prev_page: boolean;
}

export interface FilterSearchSuccess<T> {
  status: true;
  metadata: PaginationMetadata;
  data: T[];
}

export type FilterSearchResult<T = Record<string, unknown>> = FilterSearchSuccess<T> | ErrorResult;

export interface FilterSearchConfig {
  /** Upper bound for `limit` (default 1000). */
  maxLimit?: number;
  /** Page size when the request has no `limit` (default 10). */
  limit?: number;
  /** Page when the request has no `page` (default 1). */
  page?: number;
}

export interface KnexFilterSearchConfig extends FilterSearchConfig {
  /** Whitelist of filterable / selectable / orderable columns (may be qualified: 'u.id'). */
  column: string[];
  /** Columns removed from the whitelist. */
  hidden?: string[];
  /** Add the audit columns and filter `deleted_at IS NULL`. */
  timestamp?: boolean;
  /** With `timestamp`, false skips the `deleted_at` filter. */
  softDelete?: boolean;
  /** Table name or alias qualifying the soft-delete filter (default: the builder's FROM table). */
  table?: string;
}

/** True when the database rejected a value (SQLSTATE class 22, Objection DataError). */
export function isDataError(e: unknown): boolean;

/** Turn an error into a client-safe `{ status: false, message, statusCode }` (unexpected errors are logged). */
export function errorResult(e: unknown, where?: string): ErrorResult;

/** The model-class properties these helpers read. */
export interface ModelInfo {
  timestamp?: unknown;
  hidden?: unknown;
  column?: Record<string, unknown>;
}

/** True when soft delete applies to the model (`timestamp !== false`). */
export function usesSoftDelete(model: ModelInfo | null | undefined): boolean;

/** Hidden columns of a model. */
export function hiddenColumns(model: ModelInfo | null | undefined): string[];

/** Columns a client may select / filter / order by. */
export function allowedColumns(model: ModelInfo | null | undefined): string[];

/** Validate a `$select` value against the allowed columns; throws FilterSearchError. */
export function parseSelect(value: unknown, allowed: Iterable<string>): string[];

/** A node of an Objection relation expression object. */
export interface RelationNode {
  $name?: string;
  $relation: string;
  $modify: string[];
  $recursive: boolean | number;
  $allRecursive: boolean;
  $childNames: string[];
  [child: string]: unknown;
}

export interface ParsedRelations {
  expression: string;
  graph: RelationNode;
}

type AnyModelClass = typeof ObjectionModel;

/** Parse and validate a client `$relations` expression against `model.allowGraph`; throws FilterSearchError. */
export function parseRelations(model: AnyModelClass, value: unknown): ParsedRelations;

/** Apply a validated relation expression (with soft-delete filtering of related rows) to an Objection builder. */
export function applyRelations<QB>(builder: QB, model: AnyModelClass, parsed: ParsedRelations, type?: 'fetch' | 'join'): QB;

/** LEFT JOIN the requested relations, excluding soft-deleted related rows inside the join. */
export function leftJoinRelations<QB>(builder: QB, model: AnyModelClass, parsed: ParsedRelations): QB;

/** Add `<table>.deleted_at IS NULL` for soft-delete models. */
export function applySoftDelete<QB>(builder: QB, model: ModelInfo & { tableName?: string }): QB;

/** Name or alias of a knex builder's single FROM table, or null. */
export function baseTableRef(builder: unknown): string | null;

export interface LikeOptions {
  or?: boolean;
  insensitive?: boolean;
}

/** Add a parameterized LIKE condition (dialect aware) to a knex / Objection builder. */
export function likeClause<QB>(builder: QB, dialect: string, column: string, pattern: string, options?: LikeOptions): QB;

/** Query-string filtering, ordering and pagination. */
declare class FilterSearch {
  /** Filter / paginate an Objection model from `req.query`. Never throws for client errors. */
  static model<M extends ObjectionModel>(model: ModelConstructor<M> & typeof ObjectionModel, req: RequestLike, config?: FilterSearchConfig): Promise<FilterSearchResult<M>>;
  /** Filter / paginate a knex query builder (cloned, not modified) against `config.column`. */
  static knex<T = Record<string, unknown>>(builder: Knex.QueryBuilder, req: RequestLike, config: KnexFilterSearchConfig): Promise<FilterSearchResult<T>>;
}

export default FilterSearch;
