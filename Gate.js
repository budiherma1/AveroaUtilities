/**
 * Authorization: abilities and model policies, in the spirit of Laravel's Gate.
 *
 *   import { Gate, can } from '@averoa/utilities';
 *
 *   Gate.define('view-reports', (user) => user.is_admin === true);
 *   Gate.policy(Post, PostPolicy);              // class with view/create/update/delete(user, post)
 *
 *   await Gate.allows(req.user, 'update', post);  // true | false
 *   await Gate.authorize(req.user, 'update', post); // throws AuthorizationError (403)
 *
 *   router.put('/posts/:id', 'PostController@update', ['AuthMiddleware', can('update', loadPost)]);
 *
 * Every check fails closed: an unknown ability, a missing policy method, a
 * guest user or a callback that returns anything but `true` denies.
 */

const DEFAULT_DENY_MESSAGE = 'This action is unauthorized.';

/** Thrown by `authorize()`. `statusCode` 403 (or the denial's own code), exposed to clients. */
export class AuthorizationError extends Error {
  constructor(message = DEFAULT_DENY_MESSAGE, statusCode = 403, { ability, code } = {}) {
    super(message || DEFAULT_DENY_MESSAGE);
    this.name = 'AuthorizationError';
    this.statusCode = statusCode;
    this.status = statusCode;
    this.expose = true;
    if (ability !== undefined) this.ability = ability;
    if (code !== undefined) this.code = code;
  }
}

/**
 * Result of a check. Callbacks may return one instead of a boolean to give a
 * reason or another status: `return GateResponse.deny('Not your post')`,
 * `GateResponse.denyAsNotFound()` (404, hides that the resource exists).
 */
export class GateResponse {
  constructor(allowed, message = null, statusCode = null, code = undefined) {
    this.allowed = allowed === true;
    this.message = message;
    this.statusCode = statusCode;
    this.code = code;
  }

  static allow(message = null) {
    return new GateResponse(true, message);
  }

  static deny(message = DEFAULT_DENY_MESSAGE, statusCode = 403, code = undefined) {
    return new GateResponse(false, message, statusCode, code);
  }

  static denyAsNotFound(message = 'Not Found') {
    return new GateResponse(false, message, 404);
  }

  denied() {
    return !this.allowed;
  }

  /** Throws an AuthorizationError when denied, returns this when allowed. */
  authorize(ability) {
    if (this.allowed) return this;
    throw new AuthorizationError(
      this.message ?? DEFAULT_DENY_MESSAGE,
      this.statusCode ?? 403,
      { ability, code: this.code },
    );
  }
}

/** `true` -> allow, a GateResponse as is, anything else -> deny. */
function toResponse(result) {
  if (result instanceof GateResponse) return result;
  return result === true ? GateResponse.allow() : GateResponse.deny();
}

const isClass = (fn) => typeof fn === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(fn));

function assertAbility(ability) {
  if (typeof ability !== 'string' || ability === '') {
    throw new TypeError('Gate: ability must be a non-empty string');
  }
}

export class AccessGate {
  constructor() {
    this.abilities = new Map(); // ability -> { callback, guests }
    this.policies = new Map(); // model class -> policy class | object
    this.policyInstances = new Map(); // model class -> policy object
    this.beforeCallbacks = [];
    this.afterCallbacks = [];
  }

  /**
   * Define an ability: `callback(user, ...args)` returns a boolean, a
   * GateResponse or a Promise of one. Guests (no user) are denied without
   * calling it unless `{ guests: true }`.
   */
  define(ability, callback, { guests = false } = {}) {
    assertAbility(ability);
    if (typeof callback !== 'function') throw new TypeError(`Gate.define('${ability}'): callback must be a function`);
    this.abilities.set(ability, { callback, guests: guests === true });
    return this;
  }

  /** True when the ability was defined with define(). */
  has(ability) {
    return this.abilities.has(ability);
  }

  /**
   * Register a policy for a model class. `Policy` is a class (instantiated once,
   * lazily) or a plain object. Its methods are named after abilities and get
   * `(user, resource, ...args)`; `before(user, ability, resource, ...args)`,
   * when present, runs first and decides when it returns non-undefined.
   * Set `allowGuests = true` (static or instance) to call it for guests too.
   */
  policy(ModelClass, Policy) {
    if (typeof ModelClass !== 'function') throw new TypeError('Gate.policy: the first argument must be a model class');
    if (!Policy || (typeof Policy !== 'function' && typeof Policy !== 'object')) {
      throw new TypeError(`Gate.policy(${ModelClass.name}): the policy must be a class or an object`);
    }
    this.policies.set(ModelClass, Policy);
    this.policyInstances.delete(ModelClass);
    return this;
  }

  /**
   * The policy object for a model instance or class (walks the class
   * hierarchy, so a subclass uses its parent's policy), or undefined.
   */
  getPolicyFor(resource) {
    if (resource === null || resource === undefined) return undefined;
    let cls;
    if (typeof resource === 'function') cls = resource;
    else if (typeof resource === 'object') cls = resource.constructor;
    while (typeof cls === 'function' && cls !== Function.prototype) {
      if (this.policies.has(cls)) return this.resolvePolicy(cls);
      cls = Object.getPrototypeOf(cls);
    }
    return undefined;
  }

  /** @private */
  resolvePolicy(ModelClass) {
    if (!this.policyInstances.has(ModelClass)) {
      const Policy = this.policies.get(ModelClass);
      const instance = isClass(Policy) ? new Policy() : Policy;
      this.policyInstances.set(ModelClass, instance);
    }
    return this.policyInstances.get(ModelClass);
  }

  /**
   * Run before every check: `callback(user, ability, ...args)`. The first one
   * that returns something other than undefined/null decides (true allows,
   * anything else denies), e.g. a super-admin bypass.
   */
  before(callback) {
    if (typeof callback !== 'function') throw new TypeError('Gate.before: callback must be a function');
    this.beforeCallbacks.push(callback);
    return this;
  }

  /**
   * Run after every check: `callback(user, ability, response, ...args)`, e.g. for
   * audit logging. Its return value is ignored.
   */
  after(callback) {
    if (typeof callback !== 'function') throw new TypeError('Gate.after: callback must be a function');
    this.afterCallbacks.push(callback);
    return this;
  }

  /** Full result of a check as a GateResponse (never throws for a denial). */
  async inspect(user, ability, ...args) {
    assertAbility(ability);
    const response = await this.decide(user ?? null, ability, args);
    for (const callback of this.afterCallbacks) {
      await callback(user ?? null, ability, response, ...args);
    }
    return response;
  }

  /** @private */
  async decide(user, ability, args) {
    for (const callback of this.beforeCallbacks) {
      const result = await callback(user, ability, ...args);
      if (result !== undefined && result !== null) return toResponse(result);
    }

    const policy = this.getPolicyFor(args[0]);
    if (policy) {
      const guestsAllowed = policy.allowGuests === true || policy.constructor?.allowGuests === true;
      if (user === null && !guestsAllowed) return GateResponse.deny();

      if (typeof policy.before === 'function') {
        const result = await policy.before(user, ability, ...args);
        if (result !== undefined && result !== null) return toResponse(result);
      }
      if (typeof policy[ability] === 'function' && ability !== 'before' && ability !== 'constructor') {
        return toResponse(await policy[ability](user, ...args));
      }
    }

    const definition = this.abilities.get(ability);
    if (!definition) return GateResponse.deny();
    if (user === null && !definition.guests) return GateResponse.deny();
    return toResponse(await definition.callback(user, ...args));
  }

  async allows(user, ability, ...args) {
    return (await this.inspect(user, ability, ...args)).allowed;
  }

  async denies(user, ability, ...args) {
    return !(await this.allows(user, ability, ...args));
  }

  /** True when every ability is allowed. */
  async check(user, abilities, ...args) {
    for (const ability of [].concat(abilities)) {
      if (!(await this.allows(user, ability, ...args))) return false;
    }
    return true;
  }

  /** True when at least one ability is allowed. */
  async any(user, abilities, ...args) {
    for (const ability of [].concat(abilities)) {
      if (await this.allows(user, ability, ...args)) return true;
    }
    return false;
  }

  /** Resolves the GateResponse when allowed, throws an AuthorizationError (403) otherwise. */
  async authorize(user, ability, ...args) {
    return (await this.inspect(user, ability, ...args)).authorize(ability);
  }

  /** The same checks bound to one user: `Gate.forUser(req.user).allows('update', post)`. */
  forUser(user) {
    return {
      inspect: (ability, ...args) => this.inspect(user, ability, ...args),
      allows: (ability, ...args) => this.allows(user, ability, ...args),
      denies: (ability, ...args) => this.denies(user, ability, ...args),
      check: (abilities, ...args) => this.check(user, abilities, ...args),
      any: (abilities, ...args) => this.any(user, abilities, ...args),
      authorize: (ability, ...args) => this.authorize(user, ability, ...args),
    };
  }

  /** Removes every ability, policy and callback (tests). */
  reset() {
    this.abilities.clear();
    this.policies.clear();
    this.policyInstances.clear();
    this.beforeCallbacks.length = 0;
    this.afterCallbacks.length = 0;
    return this;
  }
}

/** The application's gate, used by `can()` unless another one is passed. */
const gate = new AccessGate();

/**
 * Express middleware: answers 401 JSON without a user, 403 JSON (or the
 * denial's status) when the ability is denied, otherwise calls next().
 *
 * `resource` is optional:
 * - a model class with a policy (`can('create', Post)`), passed as is;
 * - a function `(req, res) => resource | Promise<resource>` that loads the
 *   resource, e.g. from `req.params.id`. When it returns null/undefined the
 *   middleware answers 404 (as a missing row would); an array is spread
 *   into several arguments;
 * - any other value, passed as is.
 *
 * The allowed resource is kept on `res.locals.resource` so the controller does
 * not have to load it again.
 *
 * @param {string} ability
 * @param {Function|object} [resource]
 * @param {{ gate?: AccessGate, user?: (req) => object, notFoundMessage?: string }} [options]
 */
export function can(ability, resource, options = {}) {
  assertAbility(ability);
  const {
    gate: useGate = gate,
    user: getUser = (req) => req.user,
    notFoundMessage = 'Not Found',
  } = options;
  const hasResource = resource !== undefined;
  // a class (model) is an argument, any other function loads the resource
  const isLoader = typeof resource === 'function' && !isClass(resource);

  return async function canMiddleware(req, res, next) {
    try {
      const user = getUser(req);
      if (!user) {
        return res.status(401).json({ status: false, message: 'Unauthenticated' });
      }

      let args = [];
      if (hasResource) {
        const value = isLoader ? await resource(req, res) : resource;
        if (value === undefined || value === null) {
          return res.status(404).json({ status: false, message: notFoundMessage });
        }
        args = isLoader && Array.isArray(value) ? value : [value];
      }

      const response = await useGate.inspect(user, ability, ...args);
      if (!response.allowed) {
        const body = { status: false, message: response.message ?? DEFAULT_DENY_MESSAGE };
        if (response.code !== undefined) body.code = response.code;
        return res.status(response.statusCode ?? 403).json(body);
      }

      if (hasResource) {
        res.locals ??= {};
        res.locals.resource = args[0];
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

export default gate;
