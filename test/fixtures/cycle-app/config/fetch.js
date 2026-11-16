import { appRoot } from '@averoa/utilities';

export default () => ({ baseURL: 'https://cycle.example.test', headers: { 'x-app-root': appRoot() ? 'yes' : 'no' } });
