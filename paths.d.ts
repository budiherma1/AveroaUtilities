/**
 * Root directory of the AveroaJS application: `AVEROA_ROOT` (absolute, or
 * relative to the cwd), else the nearest directory above the cwd that has a
 * package.json and is not inside node_modules. Cached.
 */
export function appRoot(): string;

/** Absolute path inside the application, e.g. `appPath('config', 'database.js')`. */
export function appPath(...segments: string[]): string;

/** True when the given app-relative file exists. */
export function appHas(...segments: string[]): boolean;

export interface ImportAppOptions {
  /** Resolve to `null` instead of throwing when the file does not exist. */
  optional?: boolean;
}

/** Dynamically import a module of the application; resolves to its namespace. */
export function importApp<T = Record<string, unknown>>(relativePath: string, options: { optional: true }): Promise<T | null>;
export function importApp<T = Record<string, unknown>>(relativePath: string, options?: { optional?: false }): Promise<T>;
export function importApp<T = Record<string, unknown>>(relativePath: string, options?: ImportAppOptions): Promise<T | null>;

/** Like importApp(), but resolves to the module's default export. */
export function importAppDefault<T = unknown>(relativePath: string, options: { optional: true }): Promise<T | null>;
export function importAppDefault<T = unknown>(relativePath: string, options?: { optional?: false }): Promise<T>;
export function importAppDefault<T = unknown>(relativePath: string, options?: ImportAppOptions): Promise<T | null>;

/** For tests: forget the cached root (e.g. after changing AVEROA_ROOT). */
export function resetAppRoot(): void;
