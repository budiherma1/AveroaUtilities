// Express-like request/response doubles (same as test/helpers.js, without its SQLite setup).

/** Minimal Express-like response. */
export function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
  };
}

/** Express-5-like request: `query` is a frozen object behind a prototype getter. */
export function fakeReq({ query = {}, ...rest } = {}) {
  Object.freeze(query);
  const proto = {};
  Object.defineProperty(proto, 'query', { get() { return query; }, configurable: true });
  return Object.assign(Object.create(proto), { params: {}, ...rest });
}
