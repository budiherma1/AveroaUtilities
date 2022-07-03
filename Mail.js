import nodemailer from 'nodemailer';
import { edge } from '@averoa/core';
import path from 'path';
import config from './../../../config/mail.js';
const __dirname = path.resolve();

class Mail {
	constructor() {
		this.v_from = '';
		this.v_to = '';
		this.v_subject = '';
		this.v_html = '';
		this.v_text = '';
		this.v_additional = {};
		this.channel = '';
		this.transporter = nodemailer.createTransport(config);
	}

	from(from) {
		this.v_from = from;
		return this
	}
	to(to) {
		this.v_to = to;
		return this;
	}
	subject(subject) {
		this.v_subject = subject;
		return this
	}
	html(view, variable={}) {
		
		this.v_html = async()=> {
			edge.mount(path.join(__dirname, '/resources/views'))
			let html = view;
			try {
				html = await edge.render(view, variable)
			} catch (e) {}
			return html;
		};

		return this;
	}
	text(text) {
		this.v_text = text;
		return this
	}
	additional(opt={}) {
		this.v_additional = opt;
		return this
	}
	
	async send() {
		let html = await this.v_html();
		let option = {
			from: this.v_from,
			to: this.v_to,
			subject: this.v_subject,
			text: this.v_text,
			html: html,
			...this.v_additional
		};
		if (this.channel) {
			return {
				status: 'queued',
				channel: this.channel,
				data: option

			}
		} else {
			let info = await this.transporter.sendMail(option);
			return info
		}

	}
	queue(channel) {
		this.channel = channel;
		return this;
	}
}

export default new Mail