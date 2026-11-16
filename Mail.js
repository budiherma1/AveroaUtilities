import nodemailer from 'nodemailer';
import Queue from './Queue.js';
import View from './View.js';
import Log from './Log.js';
import { loadAppConfig } from './config.js';

/** Env-based transport options used when the app has no config/mail.js. */
export function envMailConfig() {
  return {
    host: process.env.MAIL_HOST,
    port: process.env.MAIL_PORT ? Number(process.env.MAIL_PORT) : undefined,
    secure: process.env.MAIL_SECURE ? process.env.MAIL_SECURE === 'true' : undefined,
    auth: process.env.MAIL_USERNAME
      ? { user: process.env.MAIL_USERNAME, pass: process.env.MAIL_PASSWORD }
      : undefined,
    queue: process.env.MAIL_QUEUE,
  };
}

let configPromise = null;
let transporter = null;

/** App mail config (config/mail.js or env). `queue` is the default mail queue name. */
export function loadMailConfig() {
  configPromise ??= loadAppConfig('config/mail.js', envMailConfig);
  return configPromise;
}

/** Default queue used by `Mail.queue()` and `startMailWorker()`. */
export async function defaultMailQueue() {
  const cfg = await loadMailConfig();
  return cfg.queue || process.env.MAIL_QUEUE || 'mail';
}

/** The single nodemailer transporter of the process (created on first use). */
export async function getTransporter() {
  if (!transporter) {
    // eslint-disable-next-line no-unused-vars
    const { queue, amqp, ...options } = await loadMailConfig();
    transporter = nodemailer.createTransport(options);
  }
  return transporter;
}

/** Replace the transporter (tests, or a custom nodemailer transport). */
export function setTransporter(value) {
  transporter = value;
}

const looksLikeHtml = (value) => typeof value === 'string' && value.includes('<');

class Mail {
  constructor() {
    this.v_from = '';
    this.v_to = '';
    this.v_subject = '';
    this.v_html = async () => '';
    this.v_text = '';
    this.v_additional = {};
    this.v_attachments = [];
    this.channel = '';
  }

  static init() {
    return new this();
  }

  from(from) {
    this.v_from = from;
    return this;
  }

  to(to) {
    this.v_to = to;
    return this;
  }

  subject(subject) {
    this.v_subject = subject;
    return this;
  }

  /**
   * `view` is an Edge template name (rendered with `variable`) or a raw HTML
   * string (anything containing '<' is used as-is).
   */
  html(view, variable = {}) {
    this.v_html = async () => {
      if (looksLikeHtml(view)) return view;
      try {
        return await View.render(view, variable);
      } catch (e) {
        Log.error(`Mail: cannot render view "${view}": ${e.message}`);
        throw e;
      }
    };
    return this;
  }

  text(text) {
    this.v_text = text;
    return this;
  }

  additional(opt = {}) {
    this.v_additional = opt;
    return this;
  }

  attachments(data = []) {
    this.v_attachments = data;
    return this;
  }

  /** Send through the queue instead of directly. No name = default mail queue. */
  queue(channel) {
    this.channel = channel || true;
    return this;
  }

  /** The nodemailer message options (HTML already rendered). */
  async build() {
    return {
      from: this.v_from,
      to: this.v_to,
      subject: this.v_subject,
      text: this.v_text,
      html: await this.v_html(),
      attachments: this.v_attachments,
      ...this.v_additional,
    };
  }

  async send() {
    const option = await this.build();

    if (this.channel) {
      const channel = this.channel === true ? await defaultMailQueue() : this.channel;
      await Queue(channel, option);
      return { status: 'queued', channel, data: option };
    }

    return (await getTransporter()).sendMail(option);
  }
}

export default Mail;
