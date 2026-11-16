/**
 * Per-request auth helper (passport). v1 exported a module-level singleton
 * that stored the last `req`, so concurrent requests could read each other's
 * user. Create one per request instead:
 *
 *   import Auth from '@averoa/utilities/AuthSandbox.js';
 *   const auth = Auth(req);
 *   if (auth.check()) auth.user();
 */
export class AuthContext {
  constructor(req) {
    this.req = req;
  }

  user() {
    return this.req.user ?? this.req.session?.passport?.user ?? {};
  }

  check() {
    return typeof this.req.isAuthenticated === 'function' ? this.req.isAuthenticated() : false;
  }

  /** Resolves once passport has logged the user out (passport >= 0.6 needs a callback). */
  logout() {
    return new Promise((resolve, reject) => {
      this.req.logOut((err) => (err ? reject(err) : resolve()));
    });
  }
}

export default function Auth(req) {
  return new AuthContext(req);
}
