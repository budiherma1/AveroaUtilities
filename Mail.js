import nodemailer from 'nodemailer';
import Queue from './Queue.js';
import View from './View.js';
import config from './../../../config/mail.js';

class Mail {
	constructor() {
		this.v_from = '';
		this.v_to = '';
		this.v_subject = '';
		this.v_html = '';
		this.v_text = '';
		this.v_additional = {};
		this.v_attachments = [];
		this.channel = '';
		this.transporter = nodemailer.createTransport(config);
	}

	static init() {
		return new this;
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
			let html = view;
			try {
				html = await View.render(view, variable)
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
	attachments(data=[]) {
		this.v_attachments = data;
		return this;
	}
	
	async send() {

		let html;
		try {
			html = await this.v_html();
		} catch(e) {
			html = '';
		}
		
		let option = {
			from: this.v_from,
			to: this.v_to,
			subject: this.v_subject,
			text: this.v_text,
			html: html,
			attachments: this.v_attachments,
			...this.v_additional
		};

		if (this.channel) {
			Queue(this.channel, option)
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

export default Mail