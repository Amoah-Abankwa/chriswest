import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AttendanceAbsentHandler, type AbsentPayload } from './handlers/attendance-absent';
import { hostname } from 'node:os';
import { getEnv } from '../config/env';
import { FileStorage } from '../storage/file-storage';
import type { AccountEmailPayload } from './account-email';
import { AccountEmailHandler } from './handlers/account-email';
import { AnnouncementPublishedHandler } from './handlers/announcement-published';
import { ExportReportCardsHandler } from './handlers/export-report-cards';
import { ExportSchoolDataHandler } from './handlers/export-school-data';
import { PaymentRecordedHandler } from './handlers/payment-recorded';
import { ResultsPublishedHandler, type ResultsPublishedPayload } from './handlers/results-published';
import { SendEmailHandler, type SendEmailPayload } from './handlers/send-email';

const MAX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60_000;

/**
 * Processes due outbox events. Safe to run in several workers at once: rows are claimed with
 * FOR UPDATE SKIP LOCKED and leased for a few minutes while being handled.
 */
@Injectable()
export class OutboxProcessor {
  private readonly logger = new Logger(OutboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly absent: AttendanceAbsentHandler,
    private readonly resultsPublished: ResultsPublishedHandler,
    private readonly paymentRecorded: PaymentRecordedHandler,
    private readonly announcementPublished: AnnouncementPublishedHandler,
    private readonly accountEmail: AccountEmailHandler,
    private readonly exportReportCards: ExportReportCardsHandler,
    private readonly exportSchoolData: ExportSchoolDataHandler,
    private readonly sendEmail: SendEmailHandler,
    private readonly storage: FileStorage,
  ) {}

  /** Lets the platform see that background work is running. */
  async heartbeat(name = `worker@${hostname()}`) {
    console.log({
  prismaDefined: this.prisma !== undefined,
  prismaType: typeof this.prisma,
  heartbeatDelegate: typeof this.prisma?.workerHeartbeat,
});
    const now = new Date();
    await this.prisma.workerHeartbeat.upsert({ where: { name }, create: { name, lastSeenAt: now, host: hostname() }, update: { lastSeenAt: now } });
  }

  /** Housekeeping: old finished jobs, old email records and expired exports. */
  async cleanup(now = new Date()) {
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
    // Retention schedule (see docs/PRIVACY.md). Business records (students, marks, payments) are never removed here.
    const [events, emails, sessions, tokens, notifications, messages, audit] = await Promise.all([
      this.prisma.outboxEvent.deleteMany({ where: { processedAt: { lt: days(30) } } }),
      this.prisma.emailDelivery.deleteMany({ where: { createdAt: { lt: days(180) } } }),
      this.prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: days(30) } }, { revokedAt: { lt: days(30) } }] } }),
      this.prisma.authToken.deleteMany({ where: { createdAt: { lt: days(30) }, OR: [{ usedAt: { not: null } }, { expiresAt: { lt: now } }] } }),
      this.prisma.notification.deleteMany({ where: { readAt: { lt: days(180) } } }),
      this.prisma.contactMessage.deleteMany({ where: { handledAt: { lt: days(365) } } }),
      this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: days(getEnv().AUDIT_RETENTION_DAYS) } } }),
    ]);
    const expired = await this.prisma.exportJob.findMany({ where: { expiresAt: { lte: now } }, select: { id: true, storageKey: true } });
    for (const job of expired) {
      if (job.storageKey) await this.storage.delete(job.storageKey).catch(() => undefined);
      await this.prisma.exportJob.delete({ where: { id: job.id } });
    }
    return { events: events.count, emails: emails.count, sessions: sessions.count, tokens: tokens.count, notifications: notifications.count, messages: messages.count, audit: audit.count, exports: expired.length };
  }

  /** Handles up to `limit` due events. Returns how many were claimed. */
  async runOnce(limit = 20): Promise<number> {
    const ids = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM outbox_events
        WHERE "processedAt" IS NULL AND "failedAt" IS NULL AND "availableAt" <= now()
        ORDER BY "availableAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`;
      const claimed = rows.map((r) => r.id);
      if (claimed.length > 0) {
        await tx.outboxEvent.updateMany({
          where: { id: { in: claimed } },
          data: { availableAt: new Date(Date.now() + LEASE_MS), attempts: { increment: 1 } },
        });
      }
      return claimed;
    });

    for (const id of ids) await this.process(id);
    return ids.length;
  }

  private async process(id: string) {
    const event = await this.prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    try {
      const outcome = await this.dispatch(event.type, event.schoolId, event.payload);
      await this.prisma.outboxEvent.update({ where: { id }, data: { processedAt: new Date(), lastError: null } });
      this.logger.log({ msg: 'Outbox event processed', id, type: event.type, outcome });
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : 'Unknown error';
      // Some failures can't succeed on retry (e.g. the email provider rejected the address).
      const permanent = Boolean((err as { permanent?: boolean }).permanent);
      const giveUp = permanent || event.attempts >= MAX_ATTEMPTS;
      // Exponential backoff with jitter: ~1, 2, 4, 8 minutes.
      const delay = 60_000 * 2 ** (event.attempts - 1) * (0.75 + Math.random() * 0.5);
      await this.prisma.outboxEvent.update({
        where: { id },
        data: giveUp ? { failedAt: new Date(), lastError: message } : { availableAt: new Date(Date.now() + delay), lastError: message },
      });
      this.logger.error({ msg: giveUp ? 'Outbox event failed permanently' : 'Outbox event failed; will retry', id, type: event.type, err: message });
      if (giveUp && event.type.startsWith('export.')) {
        const { jobId } = event.payload as { jobId: string };
        await this.prisma.exportJob.updateMany({ where: { id: jobId }, data: { status: 'FAILED', error: message } });
      } else if (event.type.startsWith('export.')) {
        const { jobId } = event.payload as { jobId: string };
        await this.prisma.exportJob.updateMany({ where: { id: jobId }, data: { status: 'QUEUED', error: message } });
      }
    }
  }

  private dispatch(type: string, schoolId: string | null, payload: unknown) {
    switch (type) {
      case 'attendance.absent':
        return this.absent.handle(schoolId!, payload as AbsentPayload);
      case 'results.published':
        return this.resultsPublished.handle(schoolId!, payload as ResultsPublishedPayload);
      case 'payment.recorded':
        return this.paymentRecorded.handle(schoolId!, payload as { paymentId: string });
      case 'announcement.published':
        return this.announcementPublished.handle(schoolId!, payload as { announcementId: string });
      case 'email.send':
        return this.sendEmail.handle(schoolId, payload as SendEmailPayload);
      case 'account.email':
        return this.accountEmail.handle(payload as AccountEmailPayload);
      case 'export.report_cards':
        return this.exportReportCards.handle(schoolId!, payload as { jobId: string });
      case 'export.school_data':
        return this.exportSchoolData.handle(schoolId!, payload as { jobId: string });
      default:
        throw new Error(`No handler for outbox event type ${type}`);
    }
  }
}
