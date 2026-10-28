import { Injectable } from '@nestjs/common';
import { ScopeService } from '../access/scope.service';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { conflict, notFound } from '../common/errors';
import { enqueue } from '../outbox/outbox';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorage } from '../storage/file-storage';

const KEEP_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/** Files built in the background. Only the person who asked can see or download theirs. */
@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly storage: FileStorage,
    private readonly audit: AuditService,
  ) {}

  async requestReportCards(schoolId: string, auth: AuthContext, termId: string, classId: string, correlationId?: string) {
    const cls = await this.prisma.schoolClass.findFirst({
      where: { AND: [{ schoolId, id: classId }, this.scope.classFilter(auth, 'results.read')] },
      select: { id: true, name: true, academicYearId: true },
    });
    const term = await this.prisma.term.findUnique({ where: { schoolId_id: { schoolId, id: termId } }, select: { name: true, academicYearId: true } });
    if (!cls || !term || term.academicYearId !== cls.academicYearId) throw notFound('Class or term not found');
    const published = await this.prisma.resultSheet.count({ where: { schoolId, termId, classId, status: 'PUBLISHED' } });
    if (!published) throw conflict('NOT_PUBLISHED', 'This class has no published results for that term yet.');

    const job = await this.prisma.$transaction(async (tx) => {
      const j = await tx.exportJob.create({
        data: {
          schoolId,
          kind: 'REPORT_CARDS',
          params: { termId, classId },
          fileName: `report-cards-${cls.name}-${term.name}.pdf`.replace(/[^A-Za-z0-9._-]+/g, '-'),
          createdByUserId: auth.userId,
          expiresAt: new Date(Date.now() + KEEP_FOR_MS),
        },
        select: { id: true },
      });
      await enqueue(tx, [{ schoolId, type: 'export.report_cards', payload: { jobId: j.id }, dedupeKey: `export:${j.id}` }]);
      return j;
    });
    await this.audit.record({ action: 'export.request', outcome: 'SUCCESS', resourceType: 'export', resourceId: job.id, schoolId, actorUserId: auth.userId, summary: { kind: 'REPORT_CARDS', termId, classId }, correlationId });
    return this.get(schoolId, auth.userId, job.id);
  }

  /** A full copy of the school's records as JSON (school owners and anyone with school.update). */
  async requestSchoolData(schoolId: string, auth: AuthContext, correlationId?: string) {
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { slug: true } });
    const job = await this.prisma.$transaction(async (tx) => {
      const j = await tx.exportJob.create({
        data: { schoolId, kind: 'SCHOOL_DATA', params: {}, fileName: `${school.slug}-data-${new Date().toISOString().slice(0, 10)}.json`, createdByUserId: auth.userId, expiresAt: new Date(Date.now() + KEEP_FOR_MS) },
        select: { id: true },
      });
      await enqueue(tx, [{ schoolId, type: 'export.school_data', payload: { jobId: j.id }, dedupeKey: `export:${j.id}` }]);
      return j;
    });
    await this.audit.record({ action: 'export.request', outcome: 'SUCCESS', resourceType: 'export', resourceId: job.id, schoolId, actorUserId: auth.userId, summary: { kind: 'SCHOOL_DATA' }, correlationId });
    return this.get(schoolId, auth.userId, job.id);
  }

  async mine(schoolId: string, userId: string) {
    const rows = await this.prisma.exportJob.findMany({
      where: { schoolId, createdByUserId: userId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, kind: true, status: true, fileName: true, error: true, createdAt: true, completedAt: true, expiresAt: true },
    });
    return { data: rows };
  }

  async get(schoolId: string, userId: string, id: string) {
    const job = await this.prisma.exportJob.findFirst({
      where: { schoolId, id, createdByUserId: userId },
      select: { id: true, kind: true, status: true, fileName: true, error: true, createdAt: true, completedAt: true, expiresAt: true },
    });
    if (!job) throw notFound('Export not found');
    return { data: job };
  }

  async download(schoolId: string, userId: string, id: string) {
    const job = await this.prisma.exportJob.findFirst({ where: { schoolId, id, createdByUserId: userId }, select: { status: true, storageKey: true, fileName: true, expiresAt: true, kind: true } });
    if (!job || job.expiresAt <= new Date()) throw notFound('Export not found');
    if (job.status !== 'READY' || !job.storageKey) throw conflict('NOT_READY', 'This file isn’t ready yet.');
    await this.audit.record({ action: 'export.download', outcome: 'SUCCESS', resourceType: 'export', resourceId: id, schoolId, actorUserId: userId });
    return { body: await this.storage.get(job.storageKey), fileName: job.fileName ?? 'export', contentType: job.kind === 'SCHOOL_DATA' ? 'application/json' : 'application/pdf' };
  }
}
