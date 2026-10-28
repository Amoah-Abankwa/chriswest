import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { getEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

export type MailAttachment = { filename: string; content: Buffer; contentType: string };
export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
  /** Where replies go, e.g. the school office rather than the no-reply sending address. */
  replyTo?: string | null;
  /** The provider sends at most once per key (Resend keeps keys for 24 hours). */
  idempotencyKey?: string;
};
export type MailMeta = { schoolId?: string | null; kind?: string };

/**
 * A failure that retrying won't fix (bad address, unverified domain, invalid key). The worker gives
 * up on the job at once instead of trying five times.
 */
export class PermanentMailError extends Error {
  readonly permanent = true;
}

/** What the rest of the app uses. Every send is recorded in email_deliveries. */
export abstract class Mailer {
  abstract send(message: MailMessage, meta?: MailMeta): Promise<void>;
}

/** The thing that actually delivers. Swappable in tests to simulate an outage. */
export abstract class MailTransport {
  abstract deliver(message: MailMessage, meta?: MailMeta): Promise<{ messageId?: string }>;
}

/** Development: prints emails (without attachments) so links can be clicked. Tests: discards. */
export class DevTransport extends MailTransport {
  private readonly logger = new Logger('Mailer');

  async deliver(message: MailMessage) {
    if (getEnv().NODE_ENV === 'development') {
      const files = message.attachments?.map((a) => `${a.filename} (${a.content.length} bytes)`).join(', ');
      this.logger.log(
        `\n--- DEV EMAIL to ${message.to}${message.replyTo ? ` (reply to ${message.replyTo})` : ''} ---\n${message.subject}\n\n${message.text}${files ? `\n\nAttachments: ${files}` : ''}\n---`,
      );
    }
    return { messageId: undefined };
  }
}

export type ResendOptions = {
  apiKey: string;
  from: string;
  maxPerSecond: number;
  /** For tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Sends through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email).
 * - Paces requests to stay under the account's rate limit (per process; see the README if you run
 *   several workers).
 * - On 429 waits for Retry-After and tries again a few times; other server errors are left to the
 *   outbox's retries.
 * - Rejections (400/401/403/404/422) are permanent: retrying won't help.
 */
export class ResendTransport extends MailTransport {
  private readonly logger = new Logger('Resend');
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly interval: number;
  private next = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: ResendOptions) {
    super();
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.interval = Math.ceil(1000 / opts.maxPerSecond);
  }

  async deliver(message: MailMessage, meta: MailMeta = {}) {
    const body = JSON.stringify({
      from: this.opts.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      ...(message.attachments?.length
        ? { attachments: message.attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64'), content_type: a.contentType })) }
        : {}),
      // Shown in the Resend dashboard for filtering. Names and values: letters, numbers, _ and - only.
      tags: [{ name: 'kind', value: (meta.kind ?? 'other').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) }],
    });
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json' };
    if (message.idempotencyKey) headers['Idempotency-Key'] = message.idempotencyKey.slice(0, 256);

    for (let attempt = 1; ; attempt++) {
      await this.waitForSlot();
      let res: Response;
      try {
        res = await this.fetchFn('https://api.resend.com/emails', { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        throw new Error(`Resend unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.ok) {
        const json = (await res.json().catch(() => ({}))) as { id?: string };
        return { messageId: json.id };
      }
      const detail = await res
        .json()
        .then((j: unknown) => {
  const error =
    j !== null && typeof j === 'object'
      ? (j as { name?: string; message?: string })
      : {};

  return `${error.name ?? 'error'}: ${error.message ?? ''}`;
})
        .catch(() => res.statusText);
      if (res.status === 429 && attempt < 4) {
        const wait = Math.min(60, Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000;
        this.logger.warn({ msg: 'Resend rate limit; waiting', waitMs: wait, attempt });
        this.next = Date.now() + wait;
        continue;
      }
      if ([400, 401, 403, 404, 422].includes(res.status)) throw new PermanentMailError(`Resend rejected the email (${res.status}) ${detail}`);
      throw new Error(`Resend error (${res.status}) ${detail}`);
    }
  }

  /** One request at a time, at most maxPerSecond. */
  private waitForSlot() {
    const turn = this.queue.then(async () => {
      const wait = this.next - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.next = Math.max(Date.now(), this.next) + this.interval;
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }
}

export class SmtpTransport extends MailTransport {
  private readonly env = getEnv();
  private readonly transporter: Transporter = nodemailer.createTransport({
    host: this.env.SMTP_HOST,
    port: this.env.SMTP_PORT,
    secure: this.env.SMTP_SECURE === 'true',
    auth: this.env.SMTP_USER ? { user: this.env.SMTP_USER, pass: this.env.SMTP_PASS } : undefined,
    // Don't let a slow provider hold a worker forever; the outbox retries.
    connectionTimeout: 15_000,
    socketTimeout: 30_000,
  });

  async deliver(message: MailMessage) {
    const info = await this.transporter.sendMail({
      from: this.env.MAIL_FROM,
      to: message.to,
      replyTo: message.replyTo ?? undefined,
      subject: message.subject,
      text: message.text,
      attachments: message.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    return { messageId: info.messageId };
  }
}

@Injectable()
export class RecordingMailer extends Mailer {
  constructor(
    private readonly transport: MailTransport,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async send(message: MailMessage, meta: MailMeta = {}) {
    try {
      const { messageId } = await this.transport.deliver(message, meta);
      await this.record(message, meta, 'SENT', messageId ?? null, null);
    } catch (err) {
      await this.record(message, meta, 'FAILED', null, err instanceof Error ? err.message.slice(0, 500) : 'Unknown error');
      throw err;
    }
  }

  private async record(message: MailMessage, meta: MailMeta, status: 'SENT' | 'FAILED', messageId: string | null, error: string | null) {
    // The body is never stored: it can hold one-time links.
    await this.prisma.emailDelivery
      .create({ data: { schoolId: meta.schoolId ?? null, kind: meta.kind ?? null, toAddress: message.to, subject: message.subject.slice(0, 200), status, messageId, error } })
      .catch(() => undefined);
  }
}

export function createTransport(): MailTransport {
  const env = getEnv();
  switch (env.MAIL_DRIVER) {
    case 'resend':
      return new ResendTransport({ apiKey: env.RESEND_API_KEY!, from: env.MAIL_FROM!, maxPerSecond: env.RESEND_MAX_PER_SECOND });
    case 'smtp':
      return new SmtpTransport();
    default:
      return new DevTransport();
  }
}
