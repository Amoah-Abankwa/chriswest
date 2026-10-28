import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { conflict, notFound } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const WORKER_STALE_MS = 2 * 60_000;

@Injectable()
export class OpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The health of background work across the platform. */
  async summary() {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const open = { processedAt: null, failedAt: null };
    const [workers, pending, due, failed, oldestDue, processed, byType, emails] = await Promise.all([
      this.prisma.workerHeartbeat.findMany({ orderBy: { lastSeenAt: 'desc' } }),
      this.prisma.outboxEvent.count({ where: open }),
      this.prisma.outboxEvent.count({ where: { ...open, availableAt: { lte: now } } }),
      this.prisma.outboxEvent.count({ where: { failedAt: { not: null } } }),
      this.prisma.outboxEvent.findFirst({ where: { ...open, availableAt: { lte: now } }, orderBy: { availableAt: 'asc' }, select: { availableAt: true } }),
      this.prisma.outboxEvent.count({ where: { processedAt: { gte: dayAgo } } }),
      this.prisma.outboxEvent.groupBy({ by: ['type'], where: { OR: [{ processedAt: null }, { processedAt: { gte: dayAgo } }] }, _count: { _all: true } }),
      this.prisma.emailDelivery.groupBy({ by: ['status'], where: { createdAt: { gte: dayAgo } }, _count: { _all: true } }),
    ]);
    const lastSeen = workers[0]?.lastSeenAt ?? null;
    return {
      data: {
        worker: {
          alive: Boolean(lastSeen && now.getTime() - lastSeen.getTime() < WORKER_STALE_MS),
          lastSeenAt: lastSeen,
          instances: workers.map((w) => ({ name: w.name, lastSeenAt: w.lastSeenAt })),
        },
        outbox: {
          pending,
          due,
          failed,
          oldestDueSeconds: oldestDue ? Math.round((now.getTime() - oldestDue.availableAt.getTime()) / 1000) : 0,
          processedLast24h: processed,
          byType: Object.fromEntries(byType.map((t) => [t.type, t._count._all])),
        },
        email: {
          sentLast24h: emails.find((e) => e.status === 'SENT')?._count._all ?? 0,
          failedLast24h: emails.find((e) => e.status === 'FAILED')?._count._all ?? 0,
        },
      },
    };
  }

  async events(status: 'failed' | 'pending' | 'processed', type: string | undefined, page: number, pageSize: number) {
    const where: Prisma.OutboxEventWhereInput = {
      ...(status === 'failed' ? { failedAt: { not: null } } : status === 'pending' ? { processedAt: null, failedAt: null } : { processedAt: { not: null } }),
      ...(type ? { type } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.outboxEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        // The payload holds only IDs, but it isn't shown: type, timing and error are what's needed to act.
        select: { id: true, schoolId: true, type: true, attempts: true, lastError: true, availableAt: true, createdAt: true, processedAt: true, failedAt: true },
      }),
      this.prisma.outboxEvent.count({ where }),
    ]);
    const schools = new Map(
      (await this.prisma.school.findMany({ where: { id: { in: rows.flatMap((r) => (r.schoolId ? [r.schoolId] : [])) } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]),
    );
    return {
      data: rows.map((r) => ({ ...r, schoolName: r.schoolId ? (schools.get(r.schoolId) ?? null) : null })),
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  /** Puts a failed job back in the queue, e.g. after fixing the mail settings. */
  async retry(id: string, actor: Actor) {
    const e = await this.prisma.outboxEvent.findUnique({ where: { id }, select: { failedAt: true, type: true, schoolId: true } });
    if (!e) throw notFound('Job not found');
    if (!e.failedAt) throw conflict('NOT_FAILED', 'Only failed jobs can be retried.');
    await this.prisma.outboxEvent.update({ where: { id }, data: { failedAt: null, attempts: 0, availableAt: new Date() } });
    await this.audit.record({ action: 'ops.retry', outcome: 'SUCCESS', resourceType: 'outbox_event', resourceId: id, schoolId: e.schoolId, actorUserId: actor.userId, summary: { type: e.type } });
    return { data: { id, queued: true } };
  }

  /**
   * Who has privileged access, for the periodic access review (docs/ACCESS_REVIEW.md):
   * every platform account, and each school's managers, flagging missing two-step sign-in
   * and accounts unused for 90 days.
   */
  async accessReview() {
    const stale = new Date(Date.now() - 90 * 86_400_000);
    const [platform, managers] = await Promise.all([
      this.prisma.user.findMany({
        where: { platformRole: { not: null } },
        orderBy: { email: 'asc' },
        select: { email: true, fullName: true, platformRole: true, status: true, mfaEnabled: true, lastLoginAt: true, _count: { select: { sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } } } } },
      }),
      this.prisma.schoolMembership.findMany({
        where: { kind: 'STAFF', status: 'ACTIVE', roles: { some: { role: { key: 'manager', isSystem: true } } } },
        select: { school: { select: { id: true, name: true } }, user: { select: { email: true, mfaEnabled: true, lastLoginAt: true } } },
      }),
    ]);
    const bySchool = new Map<string, { school: string; managers: { email: string; mfaEnabled: boolean; lastLoginAt: Date | null; stale: boolean }[] }>();
    for (const m of managers) {
      const entry = bySchool.get(m.school.id) ?? { school: m.school.name, managers: [] };
      entry.managers.push({ email: m.user.email, mfaEnabled: m.user.mfaEnabled, lastLoginAt: m.user.lastLoginAt, stale: !m.user.lastLoginAt || m.user.lastLoginAt < stale });
      bySchool.set(m.school.id, entry);
    }
    return {
      data: {
        generatedAt: new Date(),
        platformAccounts: platform.map(({ _count, ...u }) => ({ ...u, activeSessions: _count.sessions, stale: !u.lastLoginAt || u.lastLoginAt < stale, needsAttention: !u.mfaEnabled || u.status !== 'ACTIVE' })),
        schoolManagers: [...bySchool.values()].sort((a, b) => a.school.localeCompare(b.school)),
      },
    };
  }

  /** A school's own email activity, for its managers. */
  async schoolEmails(schoolId: string, page: number, pageSize: number, status?: 'SENT' | 'FAILED') {
    const where = { schoolId, ...(status ? { status } : {}) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.emailDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, kind: true, toAddress: true, subject: true, status: true, error: true, createdAt: true },
      }),
      this.prisma.emailDelivery.count({ where }),
    ]);
    return { data: rows, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  }
}
