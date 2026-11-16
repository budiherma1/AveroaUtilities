import type { Model as ObjectionModel, ModelConstructor, TransactionOrKnex } from 'objection';
import type { ErrorResult, FilterSearchConfig, FilterSearchSuccess } from './FilterSearch.js';
import type { RequestLike } from './types.js';

/** A model class, or the name of a model exported by app/Models/index.js. */
export type CrudModel<M extends ObjectionModel = ObjectionModel> = string | (ModelConstructor<M> & typeof ObjectionModel);

export interface CrudDataResult<T> {
  status: true;
  data: T;
}

export interface CrudOkResult {
  status: true;
}

/** `findAll` with `?$datatable=1`. */
export interface DataTablesResult<T> {
  draw: unknown;
  recordsTotal: number;
  recordsFiltered: number;
  data: T[];
}

export interface CrudCreateOptions {
  /** Merged over the payload (its values win). */
  insert?: Record<string, unknown>;
}

export interface CrudUpdateOptions {
  /** Merged over the payload / soft-delete patch (`created_by` / `created_at` are dropped). */
  update?: Record<string, unknown>;
}

/**
 * create / findAll / findOne / update / delete in one call each. Methods
 * never throw for request or database problems: they resolve to
 * `{ status: false, message, statusCode }`.
 */
declare class Crud {
  static create<M extends ObjectionModel = ObjectionModel>(
    model: CrudModel<M>, req: RequestLike, option?: CrudCreateOptions, trx?: TransactionOrKnex | null,
  ): Promise<CrudDataResult<M> | ErrorResult>;

  /** List, filtered and paginated from req.query (`option`: FilterSearch config). */
  static findAll<M extends ObjectionModel = ObjectionModel>(
    model: CrudModel<M>, req: RequestLike, option?: FilterSearchConfig,
  ): Promise<FilterSearchSuccess<M> | DataTablesResult<M> | ErrorResult>;

  /** The row with id req.params.id (404 result when missing or soft-deleted). */
  static findOne<M extends ObjectionModel = ObjectionModel>(
    model: CrudModel<M>, req: RequestLike, option?: Record<string, unknown>,
  ): Promise<CrudDataResult<M> | ErrorResult>;

  static update<M extends ObjectionModel = ObjectionModel>(
    model: CrudModel<M>, req: RequestLike, option?: CrudUpdateOptions, trx?: TransactionOrKnex | null,
  ): Promise<CrudOkResult | ErrorResult>;

  /** Soft delete when the model's `timestamp !== false`, hard delete otherwise. */
  static delete<M extends ObjectionModel = ObjectionModel>(
    model: CrudModel<M>, req: RequestLike, option?: CrudUpdateOptions, trx?: TransactionOrKnex | null,
  ): Promise<CrudOkResult | ErrorResult>;
}

export default Crud;
