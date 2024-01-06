// error: 0,
// warn: 1,
// info: 2,
// http: 3,
// verbose: 4,
// debug: 5,
// silly: 6
import winston from 'winston';
import path from 'path';

let __dirname = path.resolve()

if (__dirname.includes('/node_modules/@averoa/core')) {
	__dirname = __dirname.replace('/node_modules/@averoa/core', '')
}
let filename = path.join(__dirname, '/storages/logs/averoa.log')
const logger = winston.createLogger({
	format: winston.format.json(),
	transports: [
		new winston.transports.File({ filename }),
	],
})

if (process.env.NODE_ENV !== 'production') {
	logger.add(new winston.transports.Console({
		format: winston.format.simple(),
	}));
}

export default logger;