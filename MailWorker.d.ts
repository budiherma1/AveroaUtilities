import type { MailTransporter } from './Mail.js';

export interface MailWorkerOptions {
  /** Queue name (default: config/mail.js `queue`, env MAIL_QUEUE, 'mail'). */
  queue?: string;
  /** Unacked messages handled concurrently (default 1). */
  prefetch?: number;
  /** Re-publish attempts after a failed send (default 3). */
  maxRetries?: number;
  /** nodemailer transporter (default: the shared one). */
  transporter?: MailTransporter;
  /** First reconnect delay in ms (default 1000). */
  reconnectDelay?: number;
  /** Reconnect delay cap in ms (default 30000). */
  maxReconnectDelay?: number;
}

export interface MailWorkerHandle {
  readonly queue: string;
  /** Tag of the current consumer (changes after a reconnect). */
  readonly consumerTag: string;
  /** Stop consuming and reconnecting, wait for in-flight sends, close the channel. */
  stop(): Promise<void>;
}

/** Consume the mail queue and send each message with nodemailer. */
export function startMailWorker(options?: MailWorkerOptions): Promise<MailWorkerHandle>;

export default startMailWorker;
