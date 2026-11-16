/** The per-request context object. */
export interface RequestContext {
  requestId?: string;
  /** Extra fields added to every log line (addLogContext()). */
  log?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * The AsyncLocalStorage holding the request context (typed structurally so
 * this module's declarations do not need `@types/node`).
 */
export interface RequestContextStorage {
  run<R>(store: RequestContext, callback: () => R): R;
  getStore(): RequestContext | undefined;
  enterWith(store: RequestContext): void;
  exit<R>(callback: () => R): R;
  disable(): void;
}

/**
 * Shared through `globalThis[Symbol.for('averoa.requestContext')]`, so
 * @averoa/core and @averoa/utilities use the same instance.
 */
export const requestContext: RequestContextStorage;

/** Run `fn` inside a new context (a shallow copy of `context`). */
export function runWithContext<R>(context: RequestContext | null | undefined, fn: () => R): R;

/** The current context object, or undefined outside a request / runWithContext(). */
export function getContext(): RequestContext | undefined;

/** The current request id, or undefined. */
export function getRequestId(): string | undefined;

/**
 * Add fields to every later log line of the current context. No-op outside a
 * context; resolves whether a context was active.
 */
export function addLogContext(fields: Record<string, unknown>): boolean;

export default requestContext;
