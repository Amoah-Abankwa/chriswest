import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { conflict, notFound } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateSchoolInput } from './school.schemas';

const PROFILE = {
  id: true,
  name: true,
  slug: true,
  motto: true,
  addressLine: true,
  city: true,
  region: true,
  phone: true,
  contactEmail: true,
  timezone: true,
  currency: true,
  admissionNumberPrefix: true,
  attendanceCorrectionDays: true,
  notifyAbsence: true,
  studentPortalFees: true,
  libraryMaxLoans: true,
  libraryLoanDays: true,
  setupCompletedAt: true,
} as const;

export type SetupStepKey = 'profile' | 'academicYear' | 'terms' | 'levels' | 'subjects' | 'classes';

@Injectable()
export class SchoolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getProfile(schoolId: string) {
    const school = await this.prisma.school.findUnique({ where: { id: schoolId }, select: PROFILE });
    if (!school) throw notFound('School not found');
    return { data: school };
  }

  async updateProfile(schoolId: string, input: UpdateSchoolInput, actor: Actor) {
    const school = await this.prisma.school.update({ where: { id: schoolId }, data: input, select: PROFILE });
    await this.audit.record({
      action: 'school.profile_update',
      outcome: 'SUCCESS',
      resourceType: 'school',
      resourceId: schoolId,
      schoolId,
      actorUserId: actor.userId,
      summary: { fields: Object.keys(input) },
      correlationId: actor.correlationId,
    });
    return { data: school };
  }

  async setupStatus(schoolId: string) {
    const [school, activeYear, levels, subjects] = await Promise.all([
      this.prisma.school.findUnique({ where: { id: schoolId }, select: { phone: true, addressLine: true, setupCompletedAt: true } }),
      this.prisma.academicYear.findFirst({
        where: { schoolId, status: 'ACTIVE' },
        select: { id: true, name: true, _count: { select: { terms: true, classes: true } } },
      }),
      this.prisma.educationLevel.count({ where: { schoolId, isActive: true } }),
      this.prisma.subject.count({ where: { schoolId, isActive: true } }),
    ]);
    if (!school) throw notFound('School not found');

    const steps: { key: SetupStepKey; done: boolean }[] = [
      { key: 'profile', done: Boolean(school.phone && school.addressLine) },
      { key: 'academicYear', done: Boolean(activeYear) },
      { key: 'terms', done: (activeYear?._count.terms ?? 0) > 0 },
      { key: 'levels', done: levels > 0 },
      { key: 'subjects', done: subjects > 0 },
      { key: 'classes', done: (activeYear?._count.classes ?? 0) > 0 },
    ];
    return {
      data: {
        steps,
        currentYear: activeYear ? { id: activeYear.id, name: activeYear.name } : null,
        completedAt: school.setupCompletedAt,
      },
    };
  }

  async completeSetup(schoolId: string, actor: Actor) {
    const status = (await this.setupStatus(schoolId)).data;
    const missing = status.steps.filter((s) => !s.done).map((s) => s.key);
    if (missing.length > 0) {
      throw conflict('SETUP_INCOMPLETE', 'Finish the remaining setup steps first.', { missing });
    }
    if (!status.completedAt) {
      await this.prisma.school.update({ where: { id: schoolId }, data: { setupCompletedAt: new Date() } });
      await this.audit.record({
        action: 'school.setup_complete',
        outcome: 'SUCCESS',
        resourceType: 'school',
        resourceId: schoolId,
        schoolId,
        actorUserId: actor.userId,
        correlationId: actor.correlationId,
      });
    }
    return this.setupStatus(schoolId);
  }
}
