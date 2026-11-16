import axios from 'axios';
import { loadAppConfig } from './config.js';
import { appHas } from './paths.js';

/** Env-based defaults used when the app has no config/fetch.js. */
export function envFetchConfig() {
  const config = {};
  if (process.env.FETCH_BASE_URL) config.baseURL = process.env.FETCH_BASE_URL;
  if (process.env.FETCH_TIMEOUT) config.timeout = Number(process.env.FETCH_TIMEOUT);
  return config;
}

/*
 * config/fetch.js is loaded in the background (no top-level await, so a
 * config that imports '@averoa/utilities' cannot deadlock the import).
 * Requests made before it has loaded wait for it; `Fetch.defaults` and
 * `Fetch.interceptors` belong to the one shared axios instance throughout.
 */
const CONFIG_FILE = 'config/fetch.js';
const hasConfig = appHas(CONFIG_FILE);
const instance = axios.create(hasConfig ? {} : envFetchConfig());
let loaded = !hasConfig;

export const fetchReady = hasConfig
  ? loadAppConfig(CONFIG_FILE, envFetchConfig).then((cfg) => {
    // instance.defaults is shared with axios' internal context: mutate it in place
    Object.assign(instance.defaults, axios.mergeConfig(instance.defaults, cfg ?? {}));
  }, (e) => {
    // eslint-disable-next-line no-console
    console.warn(`[averoa] cannot load ${CONFIG_FILE}: ${e.message}`);
  }).finally(() => { loaded = true; })
  : Promise.resolve();

const REQUEST_METHODS = new Set(['request', 'get', 'delete', 'head', 'options', 'post', 'put', 'patch', 'postForm', 'putForm', 'patchForm']);

const Fetch = new Proxy(instance, {
  apply(target, thisArg, args) {
    return loaded ? Reflect.apply(target, thisArg, args) : fetchReady.then(() => Reflect.apply(target, thisArg, args));
  },
  get(target, prop, receiver) {
    if (prop === 'ready') return fetchReady;
    const value = Reflect.get(target, prop, receiver);
    if (!loaded && typeof value === 'function' && REQUEST_METHODS.has(prop)) {
      return (...args) => fetchReady.then(() => value.apply(target, args));
    }
    return value;
  },
});

export default Fetch;
