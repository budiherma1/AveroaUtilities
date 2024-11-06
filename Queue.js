import amqplib from 'amqplib';
import config from './../../../config/queue.js';

export default async (channel, data) => {
	const queue = channel;
	const conn = await amqplib.connect(config.amqp, { heartbeat: config.heartbeat || 5 });

	const ch1 = await conn.createChannel();
	await ch1.assertQueue(queue);

	const ch2 = await conn.createChannel();

	let setData = '';
	if (typeof data == 'string') {
		setData = data
	} else {
		setData = JSON.stringify(data)
	}
	ch2.sendToQueue(queue, Buffer.from(setData));
};
