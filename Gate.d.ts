import type { Awaitable, HttpRequest, HttpResponse, Middleware } from './types.js';

/** Thrown by `authorize()`; `statusCode` 403 (or the denial's own code), exposed to clients. */
export class AuthorizationError extends Error {
  constructor(message?: string, statusCode?: number, options?: { ability?: string; code?: unknown });
  name: 'AuthorizationError';
  statusCode: number;
  status: number;
  expose: true;
  ability?: string;
  code?: unknown;
}

/** Result of a check; callbacks may return one instead of a boolean to give a reason or another status. */
export class GateResponse {
  constructor(allowed: boolean, message?: string | null, statusCode?: number | null, code?: unknown);
  readonly allowed: boolean;
  message: string | null;
  statusCode: number | null;
  code: unknown;
  static allow(message?: string | null): GateResponse;
  static deny(message?: string, statusCode?: number, code?: unknown): GateResponse;
  /** 404, hides that the resource exists. */
  static denyAsNotFound(message?: string): GateResponse;
  denied(): boolean;
  /** Throws an AuthorizationError when denied, returns this when allowed. */
  authorize(ability?: string): this;
}

/** What an ability or policy method returns: only `true` (or an allowing GateResponse) allows. */
export type GateResult = Awaitable<boolean | GateResponse>;

/** `callback(user, ...args)`. */
export type AbilityCallback<TUser = any> = (user: TUser, ...args: any[]) => GateResult;

/** A `before` callback: a non-null / non-undefined result decides. */
export type BeforeCallback<TUser = any> = (user: TUser | null, ability: string, ...args: any[]) => Awaitable<boolean | GateResponse | null | undefined | void>;

export type AfterCallback<TUser = any> = (user: TUser | null, ability: string, response: GateResponse, ...args: any[]) => unknown;

/**
 * A policy: a class (instantiated once, lazily) or an object whose methods
 * are named after abilities and get `(user, resource, ...args)`. Optional
 * `before(user, ability, resource, ...args)` and `allowGuests`.
 */
export type Policy = object | (new () => object);

/** The checks of a gate bound to one user (`Gate.forUser(user)`). */
export interface BoundGate {
  inspect(ability: string, ...args: unknown[]): Promise<GateResponse>;
  allows(ability: string, ...args: unknown[]): Promise<boolean>;
  denies(ability: string, ...args: unknown[]): Promise<boolean>;
  check(abilities: string | readonly string[], ...args: unknown[]): Promise<boolean>;
  any(abilities: string | readonly string[], ...args: unknown[]): Promise<boolean>;
  authorize(ability: string, ...args: unknown[]): Promise<GateResponse>;
}

/** Abilities and model policies. Every check fails closed. */
export class AccessGate<TUser = any> {
  constructor();
  /** Define an ability; guests (no user) are denied without calling it unless `{ guests: true }`. */
  define(ability: string, callback: AbilityCallback<TUser>, options?: { guests?: boolean }): this;
  /** True when the ability was defined with define(). */
  has(ability: string): boolean;
  /** Register a policy for a model class (subclasses inherit it). */
  policy(ModelClass: abstract new (...args: any[]) => unknown, Policy: Policy): this;
  /** The policy object for a model instance or class, or undefined. */
  getPolicyFor(resource: unknown): object | undefined;
  /** Runs before every check; the first non-null result decides (e.g. a super-admin bypass). */
  before(callback: BeforeCallback<TUser>): this;
  /** Runs after every check (audit logging); its result is ignored. */
  after(callback: AfterCallback<TUser>): this;
  /** Full result of a check (never throws for a denial). */
  inspect(user: TUser | null | undefined, ability: string, ...args: unknown[]): Promise<GateResponse>;
  allows(user: TUser | null | undefined, ability: string, ...args: unknown[]): Promise<boolean>;
  denies(user: TUser | null | undefined, ability: string, ...args: unknown[]): Promise<boolean>;
  /** True when every ability is allowed. */
  check(user: TUser | null | undefined, abilities: string | readonly string[], ...args: unknown[]): Promise<boolean>;
  /** True when at least one ability is allowed. */
  any(user: TUser | null | undefined, abilities: string | readonly string[], ...args: unknown[]): Promise<boolean>;
  /** Resolves the GateResponse when allowed, throws an AuthorizationError otherwise. */
  authorize(user: TUser | null | undefined, ability: string, ...args: unknown[]): Promise<GateResponse>;
  forUser(user: TUser | null | undefined): BoundGate;
  /** Removes every ability, policy and callback (tests). */
  reset(): this;
}

/** Loads the resource of a `can()` check (null / undefined → 404; an array is spread into several arguments). */
export type ResourceLoader = (req: HttpRequest, res: HttpResponse) => unknown;

export interface CanOptions {
  /** Default: the application's gate. */
  gate?: AccessGate<any>;
  /** Default: `req.user`. */
  user?: (req: HttpRequest) => unknown | Promise<unknown>;
  /** Message of the 404 answer when the loader finds nothing. */
  notFoundMessage?: string;
}

/**
 * Express middleware: 401 without a user, 403 (or the denial's status) when
 * denied, 404 when the resource loader finds nothing; the allowed resource
 * is kept on `res.locals.resource`.
 */
export function can(ability: string, resource?: ResourceLoader, options?: CanOptions): Middleware;
export function can(ability: string, resource?: unknown, options?: CanOptions): Middleware;

/** The application's gate. */
declare const gate: AccessGate;
export default gate;
