import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

/**
 * Resolve the root directory of the AveroaJS application.
 *
 * Order:
 *   1. process.env.AVEROA_ROOT (absolute, or relative to cwd)
 *   2. the nearest directory, walking up from process.cwd(), that contains a
 *      package.json and is not inside node_modules
 *
 * Replaces the old `./../../../` imports, which only worked when a package was
 * installed exactly at node_modules/@averoa/<pkg> (and broke with pnpm,
 * workspaces, symlinks and monorepos).
 */
let cachedRoot = null;

export function appRoot() {
  if (cachedRoot) return cachedRoot;

  if (process.env.AVEROA_ROOT) {
    cachedRoot = path.resolve(process.env.AVEROA_ROOT);
    return cachedRoot;
  }

  let dir = process.cwd();
  for (;;) {
    const inNodeModules = dir.split(path.sep).includes('node_modules');
    if (!inNodeModules && fs.existsSync(path.join(dir, 'package.json'))) {
      cachedRoot = dir;
      return cachedRoot;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  cachedRoot = process.cwd();
  return cachedRoot;
}

/** Absolute path inside the application, e.g. appPath('config', 'database.js'). */
export function appPath(...segments) {
  return path.join(appRoot(), ...segments);
}

/** True when the given app-relative file exists. */
export function appHas(...segments) {
  return fs.existsSync(appPath(...segments));
}

/**
 * Dynamically import a module from the application.
 * Returns the module namespace. Pass `{ optional: true }` to get `null`
 * instead of throwing when the file does not exist.
 */
export async function importApp(relativePath, { optional = false } = {}) {
  const abs = appPath(relativePath);
  if (optional && !fs.existsSync(abs)) return null;
  return import(pathToFileURL(abs).href);
}

/** Like importApp, but returns the module's default export. */
export async function importAppDefault(relativePath, options) {
  const mod = await importApp(relativePath, options);
  return mod ? mod.default : null;
}

/** For tests: forget the cached root (e.g. after changing AVEROA_ROOT). */
export function resetAppRoot() {
  cachedRoot = null;
}
