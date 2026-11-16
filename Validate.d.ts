import type { Middleware, ValidatorStatic } from './types.js';

/** The request sections validate() checks, in the order they run. */
export type Section = 'params' | 'query' | 'headers' | 'body';

export const SECTIONS: readonly ['params', 'query', 'headers', 'body'];

/** `Symbol.for('averoa.validate')`: holds `{ schemas, options }` on a validate() middleware. */
export const VALIDATE: unique symbol;

/** The Standard Schema v1 interface (zod >= 3.24, valibot >= 1, arktype >= 2, ...). */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export declare namespace StandardSchemaV1 {
  type Result<Output> = { readonly value: Output; readonly issues?: undefined } | { readonly issues: readonly Issue[] };
  interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
  }
}

export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';

export interface FieldRuleInput {
  validator: ValidatorStatic;
  /** String form of the value (JSON for objects / arrays). */
  value: string;
  /** The coerced value (its type follows the field's `type`, hence `any`). */
  raw: any;
  /** The whole section. */
  data: Record<string, unknown>;
}

export interface FieldRule {
  /** Returns (or resolves to) a boolean; a falsy result adds `msg`. */
  run: (input: FieldRuleInput) => unknown;
  /** Default 'is invalid'. */
  msg?: string;
}

/** A built-in field definition (Model column style). */
export interface FieldDefinition {
  type?: FieldType;
  /** Default true. */
  required?: boolean;
  /** Accepted too, as in Model columns. */
  flag?: { required?: boolean; [key: string]: unknown };
  /** Value (or function returning one) used when the key is missing. */
  default?: unknown;
  /** Allowed values, compared after coercion. */
  enum?: readonly unknown[];
  validation?: FieldRule[];
  /** Documentation only (copied into the JSON Schema). */
  description?: string;
  example?: unknown;
  format?: string;
  /** Merged as is into the field's JSON Schema. */
  schema?: Record<string, unknown>;
}

export type FieldDefinitions = Record<string, FieldDefinition>;

/** A section schema: a Standard Schema validator or an object of field definitions. */
export type SectionSchema = StandardSchemaV1 | FieldDefinitions;

export type ValidateSchemas = Partial<Record<Section, SectionSchema | null>>;

export type JsonSchema = Record<string, unknown>;

export interface ValidateOptions {
  /** HTTP status on failure (default 422). */
  status?: number;
  /** Converts a Standard Schema to JSON Schema, for libraries without `~standard.jsonSchema`. */
  toJSONSchema?: (schema: StandardSchemaV1, section: Section) => JsonSchema | undefined;
  /** Explicit JSON Schema per section (wins over everything else). */
  jsonSchema?: Partial<Record<Section, JsonSchema>>;
}

/** Failure response body (status 422 by default). */
export interface ValidationFailure {
  status: false;
  data: {
    /** Dotted path, or null for an issue on the section itself. */
    column: string | null;
    /** 'required', or every failed rule / issue message. */
    message: string | string[];
    in: Section;
  };
}

/** The middleware returned by validate(). */
export interface ValidateMiddleware extends Middleware {
  readonly [VALIDATE]: { schemas: ValidateSchemas; options: ValidateOptions };
}

/**
 * Validation middleware for `body`, `query`, `params` and `headers`. On
 * success the parsed sections are in `req.validated` and `req.body` is the
 * parsed body (the original in `req.bodyRaw`).
 */
export function validate(schemas?: ValidateSchemas, options?: ValidateOptions): ValidateMiddleware;

/** True for a Standard Schema v1 validator. */
export function isStandardSchema(schema: unknown): schema is StandardSchemaV1;

/** JSON Schema of the sections a validate() middleware checks, or null when `fn` is not one. */
export function describeValidation(fn: unknown): Partial<Record<Section, JsonSchema>> | null;

export default validate;
