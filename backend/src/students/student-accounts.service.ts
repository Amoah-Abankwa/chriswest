import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { conflict, notFound } from '../common/errors';
import { queueAccountEmail } from '../outbox/account-email';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Students' own sign-in. Optional and per student, since many younger pupils won't have an email.
 * A student account only ever sees that student's own records.
 */
@Injectable()
export class StudentAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async invite(schoolId: string, studentId: string, email: string, actor: Actor) {
    const student = await this.prisma.student.findUnique({
      where: { schoolId_id: { schoolId, id: studentId } },
      select: { firstName: true, lastName: true, status: true, userId: true, user: { select: { email: true, status: true } } },
    });
    if (!student) throw notFound('Student not found');
    if (student.status !== 'ACTIVE') throw conflict('STUDENT_NOT_ACTIVE', 'Only current students can have an account.');
    if (student.user?.status === 'ACTIVE') throw conflict('ALREADY_HAS_ACCOUNT', 'This student already has an account.');

    const user = await this.prisma.$transaction(async (tx) => {
      let u = await tx.user.findUnique({ where: { email }, select: { id: true, email: true, status: true, platformRole: true } });
      if (u?.platformRole) throw conflict('EMAIL_NOT_ALLOWED', "This email can't be used for a student account.");
      if (u?.status === 'DISABLED') throw conflict('ACCOUNT_DISABLED', 'This email belongs to a disabled account.');
      if (u && u.id !== student.userId) {
        const used = await tx.schoolMembership.findUnique({ where: { schoolId_userId: { schoolId, userId: u.id } }, select: { id: true } });
        if (used) throw conflict('EMAIL_IN_USE', 'This email already belongs to someone at this school (staff or a parent). Students need their own email.');
      }
      u ??= await tx.user.create({
        data: { email, fullName: `${student.firstName} ${student.lastName}`, status: 'INVITED' },
        select: { id: true, email: true, status: true, platformRole: true },
      });
      const membership = await tx.schoolMembership.findUnique({ where: { schoolId_userId: { schoolId, userId: u.id } }, select: { id: true } });
      if (membership) await tx.schoolMembership.update({ where: { id: membership.id }, data: { kind: 'STUDENT', status: 'ACTIVE' } });
      else await tx.schoolMembership.create({ data: { schoolId, userId: u.id, kind: 'STUDENT' } });
      await tx.student.update({ where: { id: studentId }, data: { userId: u.id } });
      return u;
    });

    await queueAccountEmail(this.prisma, { userId: user.id, schoolId, template: 'INVITE', audience: 'STUDENT' });
    await this.audit.record({
      action: 'student.account_invite',
      outcome: 'SUCCESS',
      resourceType: 'student',
      resourceId: studentId,
      schoolId,
      actorUserId: actor.userId,
      summary: {},
      correlationId: actor.correlationId,
    });
    return { data: { account: user.status === 'ACTIVE' ? 'ACTIVE' : 'INVITED', invitationQueued: true } };
  }

  async revoke(schoolId: string, studentId: string, actor: Actor) {
    const student = await this.prisma.student.findUnique({ where: { schoolId_id: { schoolId, id: studentId } }, select: { userId: true } });
    if (!student) throw notFound('Student not found');
    if (!student.userId) throw conflict('NO_ACCOUNT', 'This student has no account.');
    const userId = student.userId;
    await this.prisma.$transaction(async (tx) => {
      await tx.student.update({ where: { id: studentId }, data: { userId: null } });
      await tx.schoolMembership.updateMany({ where: { schoolId, userId, kind: 'STUDENT' }, data: { status: 'DISABLED' } });
      await tx.session.updateMany({ where: { schoolId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    await this.audit.record({ action: 'student.account_revoke', outcome: 'SUCCESS', resourceType: 'student', resourceId: studentId, schoolId, actorUserId: actor.userId, correlationId: actor.correlationId });
    return { data: { account: 'NONE' } };
  }
}
