/** The passport parts of a request that AuthContext uses. */
export interface AuthRequest {
  user?: unknown;
  session?: { passport?: { user?: unknown } } & Record<string, unknown>;
  isAuthenticated?: () => boolean;
  logOut?: (callback: (err?: unknown) => void) => void;
}

/** Per-request auth helper (passport). */
export class AuthContext {
  constructor(req: AuthRequest);
  req: AuthRequest;
  /** `req.user`, else the session's passport user, else `{}`. */
  user<TUser = Record<string, unknown>>(): TUser;
  /** `req.isAuthenticated()`, false without passport. */
  check(): boolean;
  /** Resolves once passport has logged the user out. */
  logout(): Promise<void>;
}

/** `const auth = Auth(req); if (auth.check()) auth.user();` */
export default function Auth(req: AuthRequest): AuthContext;
