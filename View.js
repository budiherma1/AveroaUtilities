import {Edge} from 'edge.js';
import path from 'path';

let edge = new Edge({cache: false});

edge.mount(path.join(path.resolve(), '/resources/views'))

export default edge