import axios from 'axios';
import config from '../../../config/fetch.js'

const Fetch = axios.create(config);

export default Fetch;