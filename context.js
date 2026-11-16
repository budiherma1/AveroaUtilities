import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request context (AsyncLocalStorage).
 *
 * @averoa/core opens a context for every HTTP request with its request id;
 * Log adds `requestId` (and anything added with addLogContext()) to every log
 * line written while that request is being handled, across async boundaries
 * (await, promises, timers).
 *
 * The storage lives on `globalThis` under a registered symbol, so @averoa/core
 * and @averoa/utilities share the same instance even when they are different
 * package versions or installed twice (pnpm, workspaces, symlinks).
 */
const KEY = Symbol.for('averoa.requestContext');

/** @type {AsyncLocalStorage<{ requestId?: string, log?: object }>} */
export const requestContext = globalThis[KEY] ?? new AsyncLocalStorage();
if (!globalThis[KEY]) {
  Object.defineProperty(globalThis, KEY, { value: requestContext, enumerable: false });
}

/** Run `fn` inside a new context (e.g. a queue job: `runWithContext({ requestId: msg.id }, () => handle(msg))`). */
export function runWithContext(context, fn) {
  return requestContext.run({ ...(context ?? {}) }, fn);
}

/** The current context object, or undefined outside a request / runWithContext(). */
export function getContext() {
  return requestContext.getStore();
}

/** The current request id, or undefined. */
export function getRequestId() {
  return requestContext.getStore()?.requestId;
}

/**
 * Add fields to every later log line of the current context (e.g. the user id
 * after authentication). No-op outside a context.
 *
 * @param {object} fields
 * @returns {boolean} whether a context was active
 */
export function addLogContext(fields) {
  const store = requestContext.getStore();
  if (!store || !fields || typeof fields !== 'object') return false;
  store.log = { ...(store.log ?? {}), ...fields };
  return true;
}

export default requestContext;
