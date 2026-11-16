import { importApp } from './paths.js';
import FilterSearch, {
  PublicError, TIMESTAMP_COLUMNS, allowedColumns, applyRelations, applySoftDelete, errorResult, hiddenColumns,
  parseRelations, parseSelect, usesSoftDelete,
} from './FilterSearch.js';

/** Resolve a model by name from app/Models/index.js (or accept a model class). */
async function resolveModel(model) {
  if (typeof model === 'function') return model;
  const models = await importApp('app/Models/index.js');
  const found = models?.[model];
  if (!found) throw new PublicError(`Model ${model} not found in app/Models/index.js`, 500);
  return found;
}

async function uploadProvider() {
  const providers = await importApp('app/Providers/index.js', { optional: true });
  if (!providers?.UploadProvider) throw new Error('UploadProvider not found in app/Providers/index.js');
  return providers.UploadProvider;
}

/**
 * Columns writable from a raw request body: no pk, audit columns or unknown
 * keys; hidden columns only when flagged `writable: true` (same rule as
 * Model.writableColumns / validationRouter).
 */
function writableColumns(model) {
  const hidden = hiddenColumns(model);
  const allowHidden = (c) => !hidden.includes(c) || model.column?.[c]?.flag?.writable === true;
  if (typeof model.writableColumns === 'function') {
    return model.writableColumns().filter(allowHidden);
  }
  const skip = new Set([...[].concat(model.idColumn), ...TIMESTAMP_COLUMNS]);
  return Object.keys(model.column ?? {}).filter((c) => !skip.has(c) && allowHidden(c));
}

/**
 * Payload for insert/patch. `req.dataReq` (set by the crud route middleware
 * or by your own code) is trusted; a raw `req.body` is whitelisted.
 */
function payloadFrom(model, req) {
  if (req.dataReq && typeof req.dataReq === 'object') return { ...req.dataReq };
  const body = req.body ?? {};
  const out = {};
  for (const column of writableColumns(model)) {
    if (column in body) out[column] = body[column];
  }
  return out;
}

/** `$datatable` switch: only '1', 'true', 'yes', 'on' (any case) or boolean true enable it. */
function isEnabled(value) {
  if (value === true) return true;
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** `option.update` without the creation audit columns (they are never changed after insert). */
function withoutCreated(values) {
  const out = { ...(values ?? {}) };
  delete out.created_by;
  delete out.created_at;
  return out;
}

/** Result for an id with no live row (missing or soft-deleted). */
function notFound(id) {
  return { status: false, message: `ID ${id} doesn't exist`, statusCode: 404 };
}

class Crud {
  static async create(model, req, option = {}, trx = null) {
    try {
      const Model = await resolveModel(model);
      const data = payloadFrom(Model, req);

      if (req.dataFiles !== undefined) {
        const uploader = await uploadProvider();
        for (const key in req.dataFiles) {
          data[key] = await uploader.upload(req.dataFiles[key], req.routeData);
        }
      }

      if (req.user && usesSoftDelete(Model)) {
        data.created_by = req.user.id;
        data.updated_by = req.user.id;
      }

      const result = await Model.query(trx).insert({ ...data, ...(option.insert ?? {}) });
      return { status: true, data: result };
    } catch (e) {
      return errorResult(e, 'Crud.create');
    }
  }

  static async findAll(model, req, option = {}) {
    try {
      const Model = await resolveModel(model);
      const query = { ...(req.query ?? {}) };
      const isDatatable = isEnabled(query.$datatable);
      const datatableDraw = query.$draw;
      delete query._; // jQuery cache buster, never a filter
      delete query.$draw;
      delete query.$datatable;

      // req-like object whose `query` is our copy (req.query is never mutated)
      const request = Object.create(req, { query: { value: query, enumerable: true } });
      const data = typeof Model.filterSearch === 'function'
        ? await Model.filterSearch(request, option)
        : await FilterSearch.model(Model, request, option);

      if (isDatatable && data.status) {
        return {
          draw: datatableDraw,
          recordsTotal: data.metadata?.item_total ?? 0,
          recordsFiltered: data.metadata?.item_total ?? 0,
          data: data.data,
        };
      }

      return data;
    } catch (e) {
      return errorResult(e, 'Crud.findAll');
    }
  }

  static async findOne(model, req, option = {}) {
    try {
      const Model = await resolveModel(model);
      const q = { ...(req.query ?? {}) };
      const query = Model.query().findById(req.params.id);
      applySoftDelete(query, Model);

      if (q.$select !== undefined) {
        const columns = parseSelect(q.$select, allowedColumns(Model));
        query.select(columns.map((c) => `${Model.tableName}.${c}`));
      }
      if (q.$relations !== undefined) {
        applyRelations(query, Model, parseRelations(Model, q.$relations), 'fetch');
      }

      const result = await query;
      if (!result) return notFound(req.params.id);
      return { status: true, data: result };
    } catch (e) {
      return errorResult(e, 'Crud.findOne');
    }
  }

  static async update(model, req, option = {}, trx = null) {
    try {
      const Model = await resolveModel(model);
      const data = payloadFrom(Model, req);
      delete data.created_by;
      delete data.created_at;

      if (req.dataFiles !== undefined) {
        const uploader = await uploadProvider();
        const old = await Model.query(trx).findById(req.params.id);
        for (const key in req.dataFiles) {
          data[key] = await uploader.upload(req.dataFiles[key], req.routeData, old?.[key]);
        }
      }

      if (usesSoftDelete(Model)) {
        data.updated_at = new Date();
        if (req.user) data.updated_by = req.user.id;
      }

      const query = Model.query(trx).findById(req.params.id);
      applySoftDelete(query, Model);
      const affected = await query.patch({ ...data, ...withoutCreated(option.update) });
      return affected ? { status: true } : notFound(req.params.id);
    } catch (e) {
      return errorResult(e, 'Crud.update');
    }
  }

  /** Soft delete (sets deleted_at/deleted_by) when `timestamp !== false`, hard delete otherwise. */
  static async delete(model, req, option = {}, trx = null) {
    try {
      const Model = await resolveModel(model);
      const query = Model.query(trx).findById(req.params.id);
      let affected;
      if (usesSoftDelete(Model)) {
        applySoftDelete(query, Model);
        affected = await query.patch({
          deleted_at: new Date(),
          deleted_by: req.user?.id ?? null,
          ...withoutCreated(option.update),
        });
      } else {
        affected = await query.delete();
      }
      return affected ? { status: true } : notFound(req.params.id);
    } catch (e) {
      return errorResult(e, 'Crud.delete');
    }
  }
}

export default Crud;
