/**
 * Shared declaration-only types of @averoa/utilities (there is no types.js at
 * runtime: import them with `import type`).
 *
 * The HTTP types are small structural stand-ins for Express' req/res/next, so
 * the published declarations need neither `@types/express` nor `@types/node`.
 * An Express (4 or 5) `Request` / `Response` / `NextFunction` is assignable to
 * them, and the middlewares typed with them can be passed to Express.
 */

/** A value or a promise of it. */
export type Awaitable<T> = T | PromiseLike<T>;

/** A plain JSON-ish object. */
export type Dictionary<T = unknown> = Record<string, T>;

/**
 * A request as passed to Crud, FilterSearch and other helpers. Every property
 * is optional so hand-made objects work (`{ query: { limit: '5' } }`).
 */
export interface RequestLike {
  body?: any;
  query?: Dictionary;
  /** Express 5 types wildcard params as string[]. */
  params?: Dictionary<string | string[]>;
  headers?: Dictionary<string | string[] | undefined>;
  /** Authenticated user (passport): `req.user.id` fills the audit columns. */
  user?: any;
  /** multer files; `upload` columns are picked from it by Model.validationRouter. */
  files?: unknown;
  /** Trusted payload set by Model.mapRequest (written as is by Crud). */
  dataReq?: Dictionary;
  /** Upload files set by Model.validationRouter, keyed by column. */
  dataFiles?: Dictionary;
  /** The route's `pref`, set by Model.mapRequest and passed to UploadProvider.upload(). */
  routeData?: unknown;
  /** Original body, kept by validationRouter / validate(). */
  bodyRaw?: unknown;
  /** Parsed sections written by validate(). */
  validated?: Partial<Record<'body' | 'query' | 'params' | 'headers', any>>;
  isFormData?: boolean;
}

/** The request a middleware receives (Express always sets these). */
export interface HttpRequest extends RequestLike {
  body?: any;
  query: Dictionary;
  params: Dictionary<string | string[]>;
  headers: Dictionary<string | string[] | undefined>;
}

/** The part of an Express response the middlewares of this package use. */
export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body?: unknown): unknown;
  send(body?: unknown): unknown;
  locals?: Dictionary;
}

export type NextFunction = (err?: unknown) => void;

/** An Express-compatible middleware. */
export type Middleware = (req: HttpRequest, res: HttpResponse, next: NextFunction) => Promise<void>;

/**
 * The validator.js functions this package's validation rules most commonly
 * use (`rule.run({ validator })`). Every other validator.js function exists
 * too, typed `unknown`: install `@types/validator` and import 'validator'
 * yourself for the complete typing.
 */
export interface ValidatorStatic {
  readonly version: string;
  contains(str: string, seed: unknown, options?: { ignoreCase?: boolean; minOccurrences?: number }): boolean;
  equals(str: string, comparison: string): boolean;
  isAfter(str: string, date?: string | { comparisonDate?: string }): boolean;
  isAlpha(str: string, locale?: string, options?: { ignore?: string | RegExp }): boolean;
  isAlphanumeric(str: string, locale?: string, options?: { ignore?: string | RegExp }): boolean;
  isAscii(str: string): boolean;
  isBase64(str: string, options?: { urlSafe?: boolean }): boolean;
  isBefore(str: string, date?: string | { comparisonDate?: string }): boolean;
  isBoolean(str: string, options?: { loose?: boolean }): boolean;
  isCreditCard(str: string, options?: Dictionary): boolean;
  isDate(str: string, options?: { format?: string; strictMode?: boolean; delimiters?: string[] }): boolean;
  isDecimal(str: string, options?: { force_decimal?: boolean; decimal_digits?: string; locale?: string }): boolean;
  isEmail(str: string, options?: Dictionary): boolean;
  isEmpty(str: string, options?: { ignore_whitespace?: boolean }): boolean;
  isFloat(str: string, options?: { min?: number; max?: number; gt?: number; lt?: number; locale?: string }): boolean;
  isFQDN(str: string, options?: Dictionary): boolean;
  isHexColor(str: string): boolean;
  isIn(str: string, values: readonly unknown[]): boolean;
  isInt(str: string, options?: { min?: number; max?: number; gt?: number; lt?: number; allow_leading_zeroes?: boolean }): boolean;
  isIP(str: string, version?: 4 | 6 | '4' | '6'): boolean;
  isISO8601(str: string, options?: { strict?: boolean; strictSeparator?: boolean }): boolean;
  isJSON(str: string, options?: { allow_primitives?: boolean }): boolean;
  isJWT(str: string): boolean;
  isLength(str: string, options?: { min?: number; max?: number }): boolean;
  isLowercase(str: string): boolean;
  isMobilePhone(str: string, locale?: string | string[], options?: { strictMode?: boolean }): boolean;
  isNumeric(str: string, options?: { no_symbols?: boolean; locale?: string }): boolean;
  isPostalCode(str: string, locale: string): boolean;
  isSlug(str: string): boolean;
  isStrongPassword(str: string, options?: Dictionary): boolean | number;
  isTime(str: string, options?: { hourFormat?: 'hour12' | 'hour24'; mode?: 'default' | 'withSeconds' }): boolean;
  isUppercase(str: string): boolean;
  isURL(str: string, options?: Dictionary): boolean;
  isUUID(str: string, version?: number | string): boolean;
  matches(str: string, pattern: RegExp | string, modifiers?: string): boolean;
  blacklist(input: string, chars: string): string;
  escape(input: string): string;
  ltrim(input: string, chars?: string): string;
  normalizeEmail(email: string, options?: Dictionary): string | false;
  rtrim(input: string, chars?: string): string;
  stripLow(input: string, keepNewLines?: boolean): string;
  toBoolean(input: string, strict?: boolean): boolean;
  toDate(input: string): Date | null;
  toFloat(input: string): number;
  toInt(input: string, radix?: number): number;
  trim(input: string, chars?: string): string;
  unescape(input: string): string;
  whitelist(input: string, chars: string): string;
  readonly [name: string]: unknown;
}

/**
 * The environment's AbortSignal (from `@types/node` or the DOM lib) when one
 * is declared, otherwise a minimal structural version.
 */
export type AbortSignalLike = typeof globalThis extends { AbortSignal: { prototype: infer S } }
  ? S
  : {
    readonly aborted: boolean;
    readonly reason: unknown;
    throwIfAborted(): void;
    addEventListener(type: 'abort', listener: () => void, options?: unknown): void;
    removeEventListener(type: 'abort', listener: () => void, options?: unknown): void;
  };
