/*
 * nodemailer ships no types; messages and the transporter are typed with the
 * fields this package uses plus an open index for every other nodemailer option.
 */

export type MailAddress = string | { name: string; address: string };
export type MailRecipients = MailAddress | MailAddress[];

export interface MailAttachment {
  filename?: string;
  /** A string, a Buffer / Uint8Array, or a stream. */
  content?: unknown;
  path?: string;
  href?: string;
  contentType?: string;
  cid?: string;
  encoding?: string;
  [key: string]: unknown;
}

/** nodemailer message options, as built by Mail#build(). */
export interface MailMessage {
  from?: MailRecipients;
  to?: MailRecipients;
  cc?: MailRecipients;
  bcc?: MailRecipients;
  replyTo?: MailRecipients;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: MailAttachment[];
  [key: string]: unknown;
}

/** Result of nodemailer's sendMail() (depends on the transport). */
export interface SentMessageInfo {
  messageId?: string;
  accepted?: unknown[];
  rejected?: unknown[];
  response?: string;
  envelope?: unknown;
  [key: string]: unknown;
}

/** Result of `send()` on a queued mail. */
export interface QueuedMail {
  status: 'queued';
  channel: string;
  data: MailMessage;
}

/** A nodemailer transporter (anything with sendMail). */
export interface MailTransporter {
  sendMail(message: MailMessage): Promise<SentMessageInfo>;
}

/** config/mail.js: nodemailer transport options plus `queue`, the default mail queue. */
export interface MailConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  auth?: { user?: string; pass?: string; [key: string]: unknown };
  queue?: string;
  [key: string]: unknown;
}

/** Env-based transport options (MAIL_*) used when the app has no config/mail.js. */
export function envMailConfig(): MailConfig;

/** App mail config (config/mail.js or env), loaded once. */
export function loadMailConfig(): Promise<MailConfig>;

/** Default queue of `Mail.queue()` and startMailWorker(): config `queue`, env MAIL_QUEUE or 'mail'. */
export function defaultMailQueue(): Promise<string>;

/** The process' single nodemailer transporter (created on first use). */
export function getTransporter(): Promise<MailTransporter>;

/** Replace the transporter (tests, or a custom nodemailer transport); null = create again on next use. */
export function setTransporter(value: MailTransporter | null): void;

/** Fluent nodemailer message builder. */
declare class Mail {
  constructor();
  static init<T extends Mail>(this: new () => T): T;

  v_from: MailRecipients;
  v_to: MailRecipients;
  v_subject: string;
  v_html: () => Promise<string>;
  v_text: string;
  v_additional: Record<string, unknown>;
  v_attachments: MailAttachment[];
  /** '' = send directly, true = the default mail queue, or a queue name. */
  channel: string | boolean;

  from(from: MailRecipients): this;
  to(to: MailRecipients): this;
  subject(subject: string): this;
  /**
   * `view` is an Edge template name (rendered with `variables`) or raw HTML
   * (anything containing '<' is used as is).
   */
  html(view: string, variables?: Record<string, unknown>): this;
  text(text: string): this;
  /** Extra nodemailer options (cc, bcc, replyTo, headers, ...), merged last. */
  additional(options?: Record<string, unknown>): this;
  attachments(data?: MailAttachment[]): this;
  /** Send through the queue instead of directly. No name = the default mail queue. */
  queue(channel?: string): this;
  /** The nodemailer message options (HTML rendered). */
  build(): Promise<MailMessage>;
  /** Sends (resolves to nodemailer's info) or queues (resolves to `{ status: 'queued', channel, data }`). */
  send(): Promise<SentMessageInfo | QueuedMail>;
}

export default Mail;
