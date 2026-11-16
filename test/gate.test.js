import './setup.js';
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as utilities from '../index.js';
import {
  AccessGate, AuthorizationError, GateResponse, can,
} from '../Gate.js';
import { errorResult } from '../FilterSearch.js';

after(() => utilities.DB.destroy());

class Post {
  constructor(attrs) { Object.assign(this, attrs); }
}
class DraftPost extends Post {}
class Comment {}

class PostPolicy {
  view() { return true; }

  update(user, post) { return post.user_id === user.id; }

  delete(user, post) { return post.user_id === user.id ? true : GateResponse.deny('Only the author can delete it'); }

  async publish(user, post) { return post.user_id === user.id && user.verified === true; }

  hide(user, post) { return post.user_id === user.id ? true : GateResponse.denyAsNotFound(); }
}

const alice = { id: 1, verified: true };
const bob = { id: 2 };
const admin = { id: 3, is_admin: true };
const post = new Post({ id: 10, user_id: 1 });

/** Minimal express-like response that records status and JSON body. */
function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    locals: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

/** Runs a middleware; resolves { res, nextCalls }. */
async function run(middleware, req) {
  const res = fakeRes();
  const nextCalls = [];
  await middleware(req, res, (err) => { nextCalls.push(err); });
  return { res, nextCalls };
}

describe('Gate exports', () => {
  test('index exports the gate singleton and helpers', () => {
    assert.ok(utilities.Gate instanceof AccessGate);
    assert.equal(utilities.can, can);
    assert.equal(utilities.AccessGate, AccessGate);
    assert.equal(utilities.AuthorizationError, AuthorizationError);
    assert.equal(utilities.GateResponse, GateResponse);
  });
});

describe('Gate.define', () => {
  test('allows only when the callback returns true', async () => {
    const gate = new AccessGate();
    gate.define('view-reports', (user) => user.is_admin === true);
    gate.define('truthy', () => 1);
    gate.define('async', async (user, n) => n === 42);

    assert.equal(await gate.allows(admin, 'view-reports'), true);
    assert.equal(await gate.allows(alice, 'view-reports'), false);
    assert.equal(await gate.denies(alice, 'view-reports'), true);
    assert.equal(await gate.allows(admin, 'truthy'), false, 'only `true` allows');
    assert.equal(await gate.allows(alice, 'async', 42), true, 'extra arguments are passed');
    assert.equal(await gate.allows(alice, 'async', 1), false);
  });

  test('unknown abilities are denied', async () => {
    const gate = new AccessGate();
    assert.equal(gate.has('nope'), false);
    assert.equal(await gate.allows(admin, 'nope'), false);
  });

  test('guests are denied without calling the callback, unless guests: true', async () => {
    const gate = new AccessGate();
    let called = 0;
    gate.define('members', () => { called += 1; return true; });
    gate.define('public', (user) => user === null, { guests: true });

    assert.equal(await gate.allows(null, 'members'), false);
    assert.equal(await gate.allows(undefined, 'members'), false);
    assert.equal(called, 0);
    assert.equal(await gate.allows(undefined, 'public'), true);
  });

  test('validates its arguments', async () => {
    const gate = new AccessGate();
    assert.throws(() => gate.define('', () => true), TypeError);
    assert.throws(() => gate.define('x', 'nope'), TypeError);
    assert.throws(() => gate.policy('Post', PostPolicy), TypeError);
    assert.throws(() => gate.policy(Post, null), TypeError);
    await assert.rejects(gate.allows(alice, ''), TypeError);
  });
});

describe('Gate.policy', () => {
  test('dispatches to the policy method of the resource class', async () => {
    const gate = new AccessGate().policy(Post, PostPolicy);
    assert.equal(await gate.allows(alice, 'update', post), true);
    assert.equal(await gate.allows(bob, 'update', post), false);
    assert.equal(await gate.allows(bob, 'view', post), true);
    assert.equal(await gate.allows(alice, 'publish', post), true);
    assert.equal(await gate.allows(alice, 'unknown-method', post), false, 'missing method denies');
    assert.equal(await gate.allows(alice, 'update', new Comment()), false, 'no policy, no ability: deny');
  });

  test('a model class selects the policy too (create checks)', async () => {
    class Policy { create(user) { return user.verified === true; } }
    const gate = new AccessGate().policy(Post, Policy);
    assert.equal(await gate.allows(alice, 'create', Post), true);
    assert.equal(await gate.allows(bob, 'create', Post), false);
  });

  test('subclasses use the parent policy, and the policy is instantiated once', async () => {
    let instances = 0;
    class Policy {
      constructor() { instances += 1; }

      update(user, p) { return p.user_id === user.id; }
    }
    const gate = new AccessGate().policy(Post, Policy);
    assert.equal(await gate.allows(alice, 'update', new DraftPost({ user_id: 1 })), true);
    assert.equal(await gate.allows(alice, 'update', post), true);
    assert.equal(instances, 1);
  });

  test('a plain object works as a policy and `this` is the policy', async () => {
    const policy = {
      owner(user, p) { return p.user_id === user.id; },
      update(user, p) { return this.owner(user, p); },
    };
    const gate = new AccessGate().policy(Post, policy);
    assert.equal(await gate.allows(alice, 'update', post), true);
    assert.equal(await gate.allows(bob, 'update', post), false);
  });

  test('policy.before decides when it returns non-undefined', async () => {
    class Policy {
      before(user, ability) {
        if (user.is_admin) return true;
        if (user.banned) return false;
        if (ability === 'forbidden') return GateResponse.deny('Never', 403, 'FORBIDDEN');
        return undefined;
      }

      update(user, p) { return p.user_id === user.id; }
    }
    const gate = new AccessGate().policy(Post, Policy);
    assert.equal(await gate.allows(admin, 'update', post), true);
    assert.equal(await gate.allows(admin, 'not-a-method', post), true, 'before wins even without a method');
    assert.equal(await gate.allows({ id: 1, banned: true }, 'update', post), false);
    assert.equal(await gate.allows(alice, 'update', post), true);
    const response = await gate.inspect(alice, 'forbidden', post);
    assert.equal(response.allowed, false);
    assert.equal(response.code, 'FORBIDDEN');
  });

  test('guests never reach a policy unless it sets allowGuests', async () => {
    let called = 0;
    class Closed { view() { called += 1; return true; } }
    class Open {
      static allowGuests = true;

      view(user) { return user === null; }
    }
    const closed = new AccessGate().policy(Post, Closed);
    assert.equal(await closed.allows(null, 'view', post), false);
    assert.equal(called, 0);
    const open = new AccessGate().policy(Post, Open);
    assert.equal(await open.allows(null, 'view', post), true);
  });

  test('falls back to a defined ability when the policy has no such method', async () => {
    const gate = new AccessGate().policy(Post, PostPolicy).define('archive', (user, p) => p.user_id === user.id);
    assert.equal(await gate.allows(alice, 'archive', post), true);
    assert.equal(await gate.allows(bob, 'archive', post), false);
  });

  test('re-registering replaces the policy', async () => {
    const gate = new AccessGate().policy(Post, { update: () => true });
    assert.equal(await gate.allows(bob, 'update', post), true);
    gate.policy(Post, { update: () => false });
    assert.equal(await gate.allows(bob, 'update', post), false);
  });
});

describe('global before/after callbacks', () => {
  test('the first non-undefined before result decides', async () => {
    const gate = new AccessGate().policy(Post, PostPolicy);
    gate.before((user) => (user?.is_admin ? true : undefined));
    gate.before((user, ability) => (ability === 'locked' ? false : undefined));
    assert.equal(await gate.allows(admin, 'update', post), true);
    assert.equal(await gate.allows(admin, 'anything'), true);
    assert.equal(await gate.allows(alice, 'locked'), false);
    assert.equal(await gate.allows(bob, 'update', post), false, 'falls through to the policy');
  });

  test('after callbacks see every decision', async () => {
    const seen = [];
    const gate = new AccessGate().policy(Post, PostPolicy);
    gate.after((user, ability, response, resource) => {
      seen.push([user?.id ?? null, ability, response.allowed, resource?.id]);
    });
    await gate.allows(alice, 'update', post);
    await gate.allows(bob, 'update', post);
    await gate.allows(null, 'nope');
    assert.deepEqual(seen, [[1, 'update', true, 10], [2, 'update', false, 10], [null, 'nope', false, undefined]]);
  });

  test('reset() clears everything', async () => {
    const gate = new AccessGate().policy(Post, PostPolicy).define('x', () => true).before(() => true);
    gate.reset();
    assert.equal(await gate.allows(alice, 'x'), false);
    assert.equal(await gate.allows(alice, 'update', post), false);
  });
});

describe('authorize / inspect / forUser / check / any', () => {
  const gate = new AccessGate().policy(Post, PostPolicy).define('admin', (user) => user.is_admin === true);

  test('authorize resolves when allowed and throws a 403 AuthorizationError otherwise', async () => {
    const ok = await gate.authorize(alice, 'update', post);
    assert.equal(ok.allowed, true);

    const err = await gate.authorize(bob, 'update', post).then(() => null, (e) => e);
    assert.ok(err instanceof AuthorizationError);
    assert.equal(err.statusCode, 403);
    assert.equal(err.status, 403);
    assert.equal(err.expose, true);
    assert.equal(err.ability, 'update');
    assert.equal(err.message, 'This action is unauthorized.');
  });

  test('a denial message and status reach the error', async () => {
    const deleteErr = await gate.authorize(bob, 'delete', post).then(() => null, (e) => e);
    assert.equal(deleteErr.message, 'Only the author can delete it');
    assert.equal(deleteErr.statusCode, 403);

    const hideErr = await gate.authorize(bob, 'hide', post).then(() => null, (e) => e);
    assert.equal(hideErr.statusCode, 404);
    assert.equal(hideErr.message, 'Not Found');
  });

  test('AuthorizationError follows the Crud error-result convention', async () => {
    const err = await gate.authorize(bob, 'update', post).then(() => null, (e) => e);
    assert.deepEqual(errorResult(err), { status: false, message: 'This action is unauthorized.', statusCode: 403 });
  });

  test('inspect returns the response without throwing', async () => {
    const response = await gate.inspect(bob, 'delete', post);
    assert.ok(response instanceof GateResponse);
    assert.equal(response.allowed, false);
    assert.equal(response.denied(), true);
    assert.equal(response.message, 'Only the author can delete it');
  });

  test('forUser binds the user', async () => {
    const forAlice = gate.forUser(alice);
    assert.equal(await forAlice.allows('update', post), true);
    assert.equal(await forAlice.denies('admin'), true);
    await assert.rejects(forAlice.authorize('admin'), AuthorizationError);
    assert.equal(await gate.forUser(admin).check(['admin', 'view'], post), true);
  });

  test('check needs all abilities, any needs one', async () => {
    assert.equal(await gate.check(alice, ['view', 'update'], post), true);
    assert.equal(await gate.check(bob, ['view', 'update'], post), false);
    assert.equal(await gate.any(bob, ['update', 'view'], post), true);
    assert.equal(await gate.any(bob, ['update', 'delete'], post), false);
  });

  test('errors thrown by callbacks propagate', async () => {
    const g = new AccessGate().define('boom', () => { throw new Error('db down'); });
    await assert.rejects(g.allows(alice, 'boom'), /db down/);
  });
});

describe('can() middleware', () => {
  const gate = new AccessGate().policy(Post, PostPolicy).define('admin', (user) => user.is_admin === true);
  const posts = new Map([['10', post]]);
  const loadPost = (req) => posts.get(req.params.id);

  test('401 JSON without a user', async () => {
    const { res, nextCalls } = await run(can('admin', undefined, { gate }), {});
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { status: false, message: 'Unauthenticated' });
    assert.equal(nextCalls.length, 0);
  });

  test('403 JSON when denied, next() when allowed', async () => {
    const denied = await run(can('admin', undefined, { gate }), { user: alice });
    assert.equal(denied.res.statusCode, 403);
    assert.deepEqual(denied.res.body, { status: false, message: 'This action is unauthorized.' });
    assert.equal(denied.nextCalls.length, 0);

    const allowed = await run(can('admin', undefined, { gate }), { user: admin });
    assert.deepEqual(allowed.nextCalls, [undefined]);
    assert.equal(allowed.res.body, undefined);
  });

  test('a loader resolves the resource from the request and is kept on res.locals', async () => {
    const mw = can('update', loadPost, { gate });
    const owner = await run(mw, { user: alice, params: { id: '10' } });
    assert.deepEqual(owner.nextCalls, [undefined]);
    assert.equal(owner.res.locals.resource, post);

    const other = await run(mw, { user: bob, params: { id: '10' } });
    assert.equal(other.res.statusCode, 403);
  });

  test('404 JSON when the loader finds nothing (before any policy runs)', async () => {
    const { res, nextCalls } = await run(can('update', async () => null, { gate, notFoundMessage: 'Post not found' }), { user: alice });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { status: false, message: 'Post not found' });
    assert.equal(nextCalls.length, 0);
  });

  test('a denial status and message are used (denyAsNotFound -> 404)', async () => {
    const { res } = await run(can('hide', loadPost, { gate }), { user: bob, params: { id: '10' } });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { status: false, message: 'Not Found' });

    const del = await run(can('delete', loadPost, { gate }), { user: bob, params: { id: '10' } });
    assert.equal(del.res.statusCode, 403);
    assert.equal(del.res.body.message, 'Only the author can delete it');
  });

  test('a model class is passed as is (create checks)', async () => {
    class Policy { create(user) { return user.verified === true; } }
    const g = new AccessGate().policy(Post, Policy);
    assert.deepEqual((await run(can('create', Post, { gate: g }), { user: alice })).nextCalls, [undefined]);
    assert.equal((await run(can('create', Post, { gate: g }), { user: bob })).res.statusCode, 403);
  });

  test('a loader may return several arguments as an array', async () => {
    const g = new AccessGate().define('move', (user, from, to) => from === 'a' && to === 'b');
    assert.deepEqual((await run(can('move', () => ['a', 'b'], { gate: g }), { user: alice })).nextCalls, [undefined]);
    assert.equal((await run(can('move', () => ['b', 'a'], { gate: g }), { user: alice })).res.statusCode, 403);
  });

  test('a custom user getter', async () => {
    const mw = can('admin', undefined, { gate, user: (req) => req.auth?.user });
    assert.deepEqual((await run(mw, { auth: { user: admin } })).nextCalls, [undefined]);
    assert.equal((await run(mw, { user: admin })).res.statusCode, 401);
  });

  test('loader and gate errors go to next(err)', async () => {
    const boom = new Error('db down');
    const { res, nextCalls } = await run(can('update', async () => { throw boom; }, { gate }), { user: alice });
    assert.deepEqual(nextCalls, [boom]);
    assert.equal(res.body, undefined);
  });

  test('uses the default Gate singleton', async () => {
    utilities.Gate.define('gate-test-ability', (user) => user.id === 1);
    try {
      assert.deepEqual((await run(can('gate-test-ability'), { user: alice })).nextCalls, [undefined]);
      assert.equal((await run(can('gate-test-ability'), { user: bob })).res.statusCode, 403);
    } finally {
      utilities.Gate.abilities.delete('gate-test-ability');
    }
  });

  test('rejects an invalid ability at definition time', () => {
    assert.throws(() => can(''), TypeError);
  });
});
