import type { Edge } from 'edge.js';

/**
 * The application's single Edge instance, mounted at
 * `<app>/resources/views` (templates cached when NODE_ENV=production).
 */
declare const edge: Edge;
export default edge;
