import { Edge } from 'edge.js';
import { appPath } from './paths.js';

/**
 * THE single Edge instance of an AveroaJS app. @averoa/core uses it as the
 * Express render engine, Mail uses it for templates.
 * Templates live in <app>/resources/views. Compiled templates are cached
 * when NODE_ENV === 'production'.
 */
const edge = new Edge({ cache: process.env.NODE_ENV === 'production' });

edge.mount(appPath('resources', 'views'));

export default edge;
