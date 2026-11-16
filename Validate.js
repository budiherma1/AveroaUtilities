import validator from 'validator';

/**
 * Request validation for input that is not a Model: login forms, search
 * parameters, webhooks, ...
 *
 *   router.post('/auth/login', 'AuthController@login', [validate({
 *     body: {
 *       email: { type: 'string', validation: [{ run: (v) => v.validator.isEmail(v.value), msg: 'email format required' }] },
 *       password: { type: 'string' },
 *     },
 *   })]);
 *
 * Each section (`body`, `query`, `params`, `headers`) is either a Standard
 * Schema v1 validator (zod, valibot, arktype, ... anything with `~standard`)
 * or a plain object of field definitions in the Model column style.
 *
 * On failure: 422 `{ status: false, data: { column, message, in } }` (the
 * Model.validationRouter shape plus `in`). On success the parsed output is in
 * `req.validated.{body,query,params,headers}`, and `req.body` is replaced by
 * the parsed body. `req.query` (an Express 5 getter), `req.params` and
 * `req.headers` are left untouched.
 */

export const SECTIONS = Object.freeze(['params', 'query', 'headers', 'body']);

/** Marker on the middleware returned by validate(): `fn[VALIDATE] = { schemas, options }`. */
export const VALIDATE = Symbol.for('averoa.validate');

const TYPES = new Set(['string', 'integer', 'number', 'boolean', 'object', 'array']);

const isEmpty = (v) => v === '' || v === undefined || v === null;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** True for a Standard Schema v1 validator (zod >= 3.24, valibot >= 1, arktype >= 2, ...). */
export function isStandardSchema(schema) {
  return Boolean(schema) && (typeof schema === 'object' || typeof schema === 'function')
    && typeof schema['~standard']?.validate === 'function';
}

/** Name of a Standard Schema path segment (`'a'` or `{ key: 'a' }`). */
const segment = (s) => String(isPlainObject(s) && 'key' in s ? s.key : s);

/* ------------------------------------------------------------------------ */
/* built-in field definitions                                                */
/* ------------------------------------------------------------------------ */

function checkDefinition(section, fields) {
  for (const [name, def] of Object.entries(fields)) {
    if (!isPlainObject(def)) {
      throw new TypeError(`validate(): ${section}.${name} must be an object ({ type, required, validation, ... })`);
    }
    if (def.type !== undefined && !TYPES.has(def.type)) {
      throw new TypeError(`validate(): ${section}.${name} has unknown type "${def.type}" (${[...TYPES].join(', ')})`);
    }
    if (def.validation !== undefined && !Array.isArray(def.validation)) {
      throw new TypeError(`validate(): ${section}.${name}.validation must be an array of { run, msg }`);
    }
    if (def.enum !== undefined && !Array.isArray(def.enum)) {
      throw new TypeError(`validate(): ${section}.${name}.enum must be an array`);
    }
  }
}

/** `required` (or `flag.required`, as in Model columns); default true. */
const isRequired = (def) => (def.required ?? def.flag?.required) !== false;

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);

/**
 * Coerce `value` to `type`. Query strings, params and headers are always
 * strings, so '42' is a valid integer and 'true' a valid boolean.
 * Returns `{ value }` or `{ error }`.
 */
function coerce(type, value) {
  switch (type) {
    case undefined:
      return { value };
    case 'string':
      if (typeof value === 'string') return { value };
      if (typeof value === 'number' || typeof value === 'boolean') return { value: String(value) };
      return { error: 'must be a string' };
    case 'integer': {
      const n = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
      if (typeof n === 'number' && Number.isSafeInteger(n)) return { value: n };
      return { error: 'must be an integer' };
    }
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n === 'number' && Number.isFinite(n)) return { value: n };
      return { error: 'must be a number' };
    }
    case 'boolean':
      if (typeof value === 'boolean') return { value };
      if (typeof value === 'string' && TRUE.has(value.toLowerCase())) return { value: true };
      if (typeof value === 'string' && FALSE.has(value.toLowerCase())) return { value: false };
      return { error: 'must be a boolean' };
    case 'object':
      return isPlainObject(value) ? { value } : { error: 'must be an object' };
    case 'array':
      return Array.isArray(value) ? { value } : { error: 'must be an array' };
    default:
      return { error: `unknown type ${type}` };
  }
}

/** The string the `validator` rules see: JSON for objects/arrays, String(value) otherwise (like Model). */
const ruleValue = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : `${v}`);

/**
 * Validate one section against built-in field definitions.
 * Returns `{ value }` (declared keys only) or `{ error: { column, message } }`.
 */
async function runFields(fields, input, section) {
  const data = isPlainObject(input) ? input : {};
  const out = {};
  for (const [name, def] of Object.entries(fields)) {
    // header names are case-insensitive (node lower-cases them)
    let raw = section === 'headers' ? data[name.toLowerCase()] : data[name];

    if (raw === undefined && def.default !== undefined) {
      raw = typeof def.default === 'function' ? def.default() : def.default;
    }
    if (isEmpty(raw)) {
      if (isRequired(def)) return { error: { column: name, message: 'required' } };
      if (raw !== undefined) out[name] = raw; // keep an explicit null / ''
      continue;
    }

    const coerced = coerce(def.type, raw);
    if (coerced.error) return { error: { column: name, message: [coerced.error] } };
    const value = coerced.value;

    const messages = [];
    if (Array.isArray(def.enum) && !def.enum.includes(value)) {
      messages.push(`must be one of ${def.enum.join(', ')}`);
    }
    for (const rule of def.validation ?? []) {
      if (typeof rule?.run !== 'function') continue;
      const ok = await rule.run({
        validator, value: ruleValue(value), raw: value, data,
      });
      if (!ok) messages.push(rule.msg ?? 'is invalid');
    }
    if (messages.length) return { error: { column: name, message: messages } };

    out[name] = value;
  }
  return { value: out };
}

/* ------------------------------------------------------------------------ */
/* Standard Schema                                                           */
/* ------------------------------------------------------------------------ */

async function runStandard(schema, input) {
  const result = await schema['~standard'].validate(input);
  if (!result.issues) return { value: result.value };
  const first = result.issues[0] ?? {};
  const path = Array.isArray(first.path) ? first.path.map(segment) : [];
  const column = path.length ? path.join('.') : null;
  // every message reported for the same path, like the built-in format
  const message = result.issues
    .filter((i) => (Array.isArray(i.path) ? i.path.map(segment).join('.') : '') === (column ?? ''))
    .map((i) => i.message ?? 'is invalid');
  return { error: { column, message: message.length ? message : ['is invalid'] } };
}

/* ------------------------------------------------------------------------ */
/* middleware                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Create a validation middleware.
 *
 * @param {object} schemas  `{ body?, query?, params?, headers? }`, each a Standard Schema
 *   validator or an object of field definitions `{ type, required, default, enum, validation, description, example }`
 * @param {object} [options]
 * @param {number} [options.status=422]  HTTP status on failure
 * @param {(schema: object, section: string) => object} [options.toJSONSchema]  converts a
 *   Standard Schema to JSON Schema for API documentation, for libraries that don't implement
 *   `~standard.jsonSchema` (zod 4.2+ does)
 * @param {object} [options.jsonSchema]  explicit JSON Schema per section (wins over everything else)
 * @returns {(req, res, next) => Promise<void>}
 */
export function validate(schemas = {}, options = {}) {
  if (!isPlainObject(schemas)) throw new TypeError('validate(): expected { body, query, params, headers }');
  for (const key of Object.keys(schemas)) {
    if (!SECTIONS.includes(key)) {
      throw new TypeError(`validate(): unknown section "${key}" (expected ${SECTIONS.join(', ')})`);
    }
    const schema = schemas[key];
    if (schema === undefined || schema === null) continue;
    if (!isStandardSchema(schema)) {
      if (!isPlainObject(schema)) {
        throw new TypeError(`validate(): ${key} must be a Standard Schema validator or an object of field definitions`);
      }
      checkDefinition(key, schema);
    }
  }
  const status = Number.isInteger(options.status) ? options.status : 422;
  const active = SECTIONS.filter((s) => schemas[s] !== undefined && schemas[s] !== null);

  const middleware = async function validate(req, res, next) {
    const validated = { ...(req.validated ?? {}) };
    for (const section of active) {
      const schema = schemas[section];
      const input = section === 'body' ? (req.body ?? {}) : (req[section] ?? {});
      const result = isStandardSchema(schema) ? await runStandard(schema, input) : await runFields(schema, input, section);
      if (result.error) {
        return res.status(status).json({ status: false, data: { ...result.error, in: section } });
      }
      validated[section] = result.value;
    }
    req.validated = validated;
    if ('body' in validated) {
      req.bodyRaw = req.body;
      req.body = validated.body;
    }
    return next();
  };
  Object.defineProperty(middleware, VALIDATE, { value: { schemas, options } });
  return middleware;
}

/* ------------------------------------------------------------------------ */
/* JSON Schema (API documentation)                                           */
/* ------------------------------------------------------------------------ */

function fieldsToJsonSchema(fields) {
  const properties = {};
  const required = [];
  for (const [name, def] of Object.entries(fields)) {
    const prop = {};
    if (def.type) prop.type = def.type;
    if (def.enum) prop.enum = [...def.enum];
    if (def.default !== undefined && typeof def.default !== 'function') prop.default = def.default;
    if (def.description) prop.description = def.description;
    if (def.example !== undefined) prop.examples = [def.example];
    if (def.format) prop.format = def.format;
    if (def.schema && isPlainObject(def.schema)) Object.assign(prop, def.schema);
    properties[name] = prop;
    if (isRequired(def)) required.push(name);
  }
  const out = { type: 'object', properties };
  if (required.length) out.required = required;
  return out;
}

function standardToJsonSchema(schema, section, options) {
  const std = schema['~standard'];
  try {
    if (typeof options.toJSONSchema === 'function') return options.toJSONSchema(schema, section);
    if (typeof std.jsonSchema?.input === 'function') return std.jsonSchema.input({ target: 'draft-2020-12' });
    if (typeof schema.toJSONSchema === 'function') return schema.toJSONSchema();
  } catch {
    // a schema the library can't express as JSON Schema (transforms, custom checks): undocumented
  }
  return undefined;
}

/** Drop the `$schema` keyword, which is redundant inside an OpenAPI document. */
function clean(jsonSchema) {
  if (!isPlainObject(jsonSchema)) return undefined;
  const { $schema, ...rest } = jsonSchema;
  return rest;
}

/**
 * JSON Schema of the sections a validate() middleware checks:
 * `{ body?, query?, params?, headers? }`, or null when `fn` is not one.
 * A Standard Schema section is included only when its library can produce
 * JSON Schema (`~standard.jsonSchema`, `options.toJSONSchema` or a
 * `toJSONSchema()` method); otherwise that section is left out.
 */
export function describeValidation(fn) {
  const meta = fn?.[VALIDATE];
  if (!meta) return null;
  const out = {};
  for (const section of SECTIONS) {
    const schema = meta.schemas[section];
    if (schema === undefined || schema === null) continue;
    const explicit = meta.options?.jsonSchema?.[section];
    let json;
    if (explicit) json = explicit;
    else if (isStandardSchema(schema)) json = standardToJsonSchema(schema, section, meta.options ?? {});
    else json = fieldsToJsonSchema(schema);
    json = clean(json);
    if (json) out[section] = json;
  }
  return out;
}

export default validate;
