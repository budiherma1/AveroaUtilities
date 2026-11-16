/*
 * The logger is a winston Logger at runtime. It is typed structurally here
 * (the methods an application calls) so these declarations do not depend on
 * winston's, which need `@types/node`.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'http' | 'verbose' | 'debug' | 'silly';
export type LogFormatName = 'json' | 'pretty';
export type LogChannel = 'stdout' | 'file' | 'both';

/** `Log.info('message', { meta })`, `Log.error(err)`, `Log.info({ message, ...meta })`. */
export type LogMethod = (message: unknown, ...meta: unknown[]) => Logger;

export interface Logger {
  level: string;
  error: LogMethod;
  warn: LogMethod;
  info: LogMethod;
  http: LogMethod;
  verbose: LogMethod;
  debug: LogMethod;
  silly: LogMethod;
  log(level: string, message: unknown, ...meta: unknown[]): Logger;
  log(entry: { level: string; message: unknown; [key: string]: unknown }): Logger;
  /** A logger that adds `defaultMeta` to every entry. */
  child(defaultMeta: Record<string, unknown>): Logger;
  isLevelEnabled(level: string): boolean;
  /** Add / remove a winston transport. */
  add(transport: unknown): Logger;
  remove(transport: unknown): Logger;
  clear(): Logger;
  close(): Logger;
  readonly transports: unknown[];
  on(event: string, listener: (...args: any[]) => void): Logger;
  once(event: string, listener: (...args: any[]) => void): Logger;
}

/** A winston format (opaque here). */
export interface LogFormat {
  transform(info: Record<string, unknown>, opts?: unknown): unknown;
}

/** The replacement string for redacted values. */
export const REDACTED: '[REDACTED]';

/** Built-in sensitive key fragments (matched case-insensitively, letters and digits only). */
export const DEFAULT_REDACT_KEYS: readonly string[];

/**
 * A key matcher from DEFAULT_REDACT_KEYS plus `extra` (an array or a comma
 * separated string; default env LOG_REDACT).
 */
export function redactionMatcher(extra?: readonly string[] | string): (key: string) => boolean;

export interface RedactOptions {
  /** Extra sensitive keys (array or comma separated string). */
  keys?: readonly string[] | string;
}

/**
 * A redacted deep copy of `value`: sensitive keys become '[REDACTED]',
 * `Bearer`/`Basic` credentials in strings are masked, circular references
 * become '[Circular]', Errors become `{ name, message, stack, ...props }`.
 */
export function redact(value: unknown, options?: RedactOptions): unknown;

/** winston format adding `requestId` and addLogContext() fields. */
export const contextFormat: (opts?: Record<string, unknown>) => LogFormat;

/** winston format redacting sensitive fields of the entry. */
export const redactFormat: (opts?: { matcher?: (key: string) => boolean; keys?: readonly string[] | string }) => LogFormat;

export interface LogFormatOptions {
  format?: LogFormatName;
  colors?: boolean;
  redactKeys?: readonly string[] | string;
}

/** The format chain of Log's transports: context → redaction → timestamp → JSON or a readable line. */
export function logFormat(options?: LogFormatOptions): LogFormat;

export interface LogSettings {
  level: string;
  format: LogFormatName;
  /** null = 2.0 behaviour (the file, plus the console unless production). */
  channel: LogChannel | null;
  redactKeys: string | undefined;
  production: boolean;
  /** Messages about invalid LOG_FORMAT / LOG_CHANNEL values. */
  warnings: string[];
}

/** Logging settings from the environment (LOG_LEVEL, LOG_FORMAT, LOG_CHANNEL, LOG_REDACT, NODE_ENV). */
export function logSettings(env?: Record<string, string | undefined>): LogSettings;

/** A writable stream (only `write` is needed). */
export interface WritableLike {
  write(chunk: any, ...args: any[]): boolean;
}

export interface CreateLoggerOptions {
  level?: LogLevel | (string & {});
  /** Console format. */
  format?: LogFormatName;
  /** null = 2.0 behaviour. */
  channel?: LogChannel | null;
  /** Log directory (default `<app>/storages/logs`). */
  dir?: string;
  /** File name inside `dir` (default `averoa.log`). */
  filename?: string;
  /** Write console output here instead of stdout (tests). */
  stream?: WritableLike;
  /** Colorize the pretty format (default: stdout is a TTY and NO_COLOR is unset). */
  colors?: boolean;
  redactKeys?: readonly string[] | string;
  /** Default: NODE_ENV === 'production'. */
  production?: boolean;
}

/** Build a logger; every option defaults to logSettings() (the environment). */
export function createLogger(options?: CreateLoggerOptions): Logger;

/** The application logger. */
declare const logger: Logger;
export default logger;
