import type { AxiosInstance, CreateAxiosDefaults } from 'axios';

/** Env-based axios config (FETCH_BASE_URL, FETCH_TIMEOUT) used when the app has no config/fetch.js. */
export function envFetchConfig(): CreateAxiosDefaults;

/** Settles once config/fetch.js has been applied (never rejects). */
export const fetchReady: Promise<void>;

/**
 * The shared axios instance, configured from config/fetch.js or env.
 * Requests made before the config has loaded wait for it. `Fetch.ready` is
 * the same promise as fetchReady.
 */
declare const Fetch: AxiosInstance & { readonly ready: Promise<void> };
export default Fetch;
