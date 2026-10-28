import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { conflict, isUniqueViolation, notFound } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import { queueAccountEmail } from '../outbox/account-email';
import { PrismaService } from '../prisma/prisma.service';
import type {
  GuardianInput,
  LinkGuardianInput,
  ListGuardiansInput,
  UpdateGuardianInput,
  UpdateLinkInput,
} from './guardians.schemas';

const GUARDIAN = {
  id: true,
  fullName: true,
  phone: true,
  email: true,
  occupation: true,
  address: true,
  user: { select: { status: true } },
  students: {
    select: {
      relationship: true,
      student: { select: { id: true, firstName: true, lastName: true, admissionNumber: true } },
    },
  },
} satisfies Prisma.GuardianSelect;

type GuardianRow = Prisma.GuardianGetPayload<{ select: typeof GUARDIAN }>;

/** NONE: no portal account. INVITED: invitation sent, not yet activated. ACTIVE: can sign in. */
const portalStatus = (g: { user: { status: string } | null }) =>
  !g.user ? 'NONE' : g.user.status === 'ACTIVE' ? 'ACTIVE' : g.user.status === 'INVITED' ? 'INVITED' : 'NONE';

const toDto = (g: GuardianRow) => ({
  id: g.id,
  fullName: g.fullName,
  phone: g.phone,
  email: g.email,
  occupation: g.occupation,
  address: g.address,
  portal: portalStatus(g),
  children: g.students.map((s) => ({ ...s.student, relationship: s.relationship })),
});

const guardianNotFound = () => notFound('Parent or guardian not found');

@Injectable()
export class GuardiansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(schoolId: string, q: ListGuardiansInput, visible: Prisma.GuardianWhereInput = {}) {
    const where: Prisma.GuardianWhereInput = {
      AND: [
        { schoolId },
        visible,
        q.search
          ? {
              OR: [
                { fullName: { contains: q.search, mode: 'insensitive' } },
                { phone: { contains: q.search } },
                { email: { contains: q.search, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.guardian.findMany({
        where,
        select: GUARDIAN,
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.guardian.count({ where }),
    ]);
    return { data: rows.map((g) => toDto(g)), meta: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) } };
  }

  async get(schoolId: string, id: string, visible: Prisma.GuardianWhereInput = {}) {
    const g = await this.prisma.guardian.findFirst({ where: { AND: [{ schoolId, id }, visible] }, select: GUARDIAN });
    if (!g) throw guardianNotFound();
    return { data: toDto(g) };
  }

  async create(schoolId: string, input: GuardianInput, actor: Actor) {
    const g = await this.prisma.guardian.create({ data: { schoolId, ...input }, select: { id: true } });
    await this.log('guardian.create', schoolId, 'guardian', g.id, actor, {});
    return this.get(schoolId, g.id);
  }

  async update(schoolId: string, id: string, input: UpdateGuardianInput, actor: Actor) {
    const g = await this.prisma.guardian.findUnique({ where: { schoolId_id: { schoolId, id } }, select: { userId: true, email: true } });
    if (!g) throw guardianNotFound();
    if (g.userId && input.email !== undefined && input.email !== g.email) {
      throw conflict('EMAIL_LOCKED', 'This parent signs in with their email. Remove portal access before changing it.');
    }
    await this.prisma.guardian.update({ where: { id }, data: input });
    await this.log('guardian.update', schoolId, 'guardian', id, actor, { fields: Object.keys(input) });
    return this.get(schoolId, id);
  }

  /** Links a parent to a student. Only staff can create links; parents can never claim a child. */
  async link(schoolId: string, studentId: string, input: LinkGuardianInput, actor: Actor) {
    const student = await this.prisma.student.findUnique({ where: { schoolId_id: { schoolId, id: studentId } }, select: { id: true } });
    if (!student) throw notFound('Student not found');
    if (input.guardianId) {
      const exists = await this.prisma.guardian.findUnique({ where: { schoolId_id: { schoolId, id: input.guardianId } }, select: { id: true } });
      if (!exists) throw guardianNotFound();
    }

    let guardianId: string;
    try {
      guardianId = await this.prisma.$transaction(async (tx) => {
        const id = input.guardianId ?? (await tx.guardian.create({ data: { schoolId, ...input.guardian! }, select: { id: true } })).id;
        if (input.isPrimaryContact) {
          await tx.studentGuardian.updateMany({ where: { schoolId, studentId, isPrimaryContact: true }, data: { isPrimaryContact: false } });
        }
        await tx.studentGuardian.create({
          data: {
            schoolId,
            studentId,
            guardianId: id,
            relationship: input.relationship,
            isPrimaryContact: input.isPrimaryContact,
            portalAccess: input.portalAccess,
          },
        });
        return id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('ALREADY_LINKED', 'This parent is already linked to this student.');
      throw err;
    }
    await this.log('guardian.link', schoolId, 'student', studentId, actor, {
      guardianId,
      relationship: input.relationship,
      portalAccess: input.portalAccess,
    });
    return this.forStudent(schoolId, studentId);
  }

  async updateLink(schoolId: string, studentId: string, guardianId: string, input: UpdateLinkInput, actor: Actor) {
    const link = await this.prisma.studentGuardian.findFirst({ where: { schoolId, studentId, guardianId }, select: { studentId: true } });
    if (!link) throw notFound('Link not found');
    await this.prisma.$transaction(async (tx) => {
      if (input.isPrimaryContact) {
        await tx.studentGuardian.updateMany({ where: { schoolId, studentId, isPrimaryContact: true }, data: { isPrimaryContact: false } });
      }
      await tx.studentGuardian.update({ where: { studentId_guardianId: { studentId, guardianId } }, data: input });
    });
    await this.log('guardian.link_update', schoolId, 'student', studentId, actor, { guardianId, fields: Object.keys(input) });
    return this.forStudent(schoolId, studentId);
  }

  async unlink(schoolId: string, studentId: string, guardianId: string, actor: Actor) {
    const removed = await this.prisma.studentGuardian.deleteMany({ where: { schoolId, studentId, guardianId } });
    if (removed.count === 0) throw notFound('Link not found');
    await this.log('guardian.unlink', schoolId, 'student', studentId, actor, { guardianId });
    return this.forStudent(schoolId, studentId);
  }

  async forStudent(schoolId: string, studentId: string, visible: Prisma.StudentWhereInput = {}) {
    const student = await this.prisma.student.findFirst({ where: { AND: [{ schoolId, id: studentId }, visible] }, select: { id: true } });
    if (!student) throw notFound('Student not found');
    const links = await this.prisma.studentGuardian.findMany({
      where: { schoolId, studentId },
      orderBy: [{ isPrimaryContact: 'desc' }, { createdAt: 'asc' }],
      select: {
        relationship: true,
        isPrimaryContact: true,
        portalAccess: true,
        guardian: { select: { id: true, fullName: true, phone: true, email: true, user: { select: { status: true } } } },
      },
    });
    return {
      data: links.map((l) => ({
        guardianId: l.guardian.id,
        fullName: l.guardian.fullName,
        phone: l.guardian.phone,
        email: l.guardian.email,
        relationship: l.relationship,
        isPrimaryContact: l.isPrimaryContact,
        portalAccess: l.portalAccess,
        portal: portalStatus(l.guardian),
      })),
    };
  }

  /**
   * Gives a parent a portal account. Reuses an existing account if they already have one
   * (for example, a teacher who is also a parent at the school).
   */
  async invite(schoolId: string, guardianId: string, actor: Actor) {
    const g = await this.prisma.guardian.findUnique({
      where: { schoolId_id: { schoolId, id: guardianId } },
      select: { email: true, fullName: true, userId: true, user: { select: { status: true } } },
    });
    if (!g) throw guardianNotFound();
    if (!g.email) throw conflict('EMAIL_REQUIRED', 'Add an email address for this parent first.');
    if (g.user?.status === 'ACTIVE') throw conflict('ALREADY_HAS_ACCESS', 'This parent can already sign in.');

    const user = await this.prisma.$transaction(async (tx) => {
      let u = await tx.user.findUnique({ where: { email: g.email! }, select: { id: true, email: true, status: true, platformRole: true } });
      if (u?.platformRole) throw conflict('EMAIL_NOT_ALLOWED', "This email belongs to a platform administrator and can't be used here.");
      if (u?.status === 'DISABLED') throw conflict('ACCOUNT_DISABLED', 'This email belongs to a disabled account.');
      u ??= await tx.user.create({
        data: { email: g.email!, fullName: g.fullName, status: 'INVITED' },
        select: { id: true, email: true, status: true, platformRole: true },
      });

      const otherGuardian = await tx.guardian.findFirst({ where: { schoolId, userId: u.id, id: { not: guardianId } }, select: { id: true } });
      if (otherGuardian) throw conflict('EMAIL_IN_USE', 'Another parent record at this school already uses this email.');

      const membership = await tx.schoolMembership.findUnique({ where: { schoolId_userId: { schoolId, userId: u.id } }, select: { id: true, kind: true, status: true } });
      if (!membership) {
        await tx.schoolMembership.create({ data: { schoolId, userId: u.id, kind: 'PARENT' } });
      } else if (membership.status === 'DISABLED') {
        if (membership.kind !== 'PARENT') throw conflict('ACCOUNT_DISABLED', 'This email belongs to a deactivated staff account at this school.');
        await tx.schoolMembership.update({ where: { id: membership.id }, data: { status: 'ACTIVE' } });
      }
      await tx.guardian.update({ where: { id: guardianId }, data: { userId: u.id } });
      return u;
    });

    const invitationSent = await this.sendInvite(schoolId, user, actor);
    await this.log('guardian.invite', schoolId, 'guardian', guardianId, actor, {});
    return { data: { portal: user.status === 'ACTIVE' ? 'ACTIVE' : 'INVITED', invitationQueued: invitationSent } };
  }

  /** Removes portal access. A parent-only account at this school is disabled and signed out. */
  async revokeAccess(schoolId: string, guardianId: string, actor: Actor) {
    const g = await this.prisma.guardian.findUnique({ where: { schoolId_id: { schoolId, id: guardianId } }, select: { userId: true } });
    if (!g) throw guardianNotFound();
    if (!g.userId) throw conflict('NO_ACCESS', "This parent doesn't have portal access.");
    const userId = g.userId;
    await this.prisma.$transaction(async (tx) => {
      await tx.guardian.update({ where: { id: guardianId }, data: { userId: null } });
      const membership = await tx.schoolMembership.findUnique({ where: { schoolId_userId: { schoolId, userId } }, select: { id: true, kind: true } });
      if (membership?.kind === 'PARENT') {
        await tx.schoolMembership.update({ where: { id: membership.id }, data: { status: 'DISABLED' } });
        await tx.session.updateMany({ where: { userId, schoolId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
    });
    await this.log('guardian.revoke_access', schoolId, 'guardian', guardianId, actor, {});
    return this.get(schoolId, guardianId);
  }

  private async sendInvite(schoolId: string, user: { id: string; email: string; status: string }, _actor: Actor) {
    await queueAccountEmail(this.prisma, { userId: user.id, schoolId, template: 'INVITE', audience: 'PARENT' });
    return true;
  }

  private log(action: string, schoolId: string, resourceType: string, resourceId: string, actor: Actor, summary: Prisma.InputJsonObject) {
    return this.audit.record({
      action,
      outcome: 'SUCCESS',
      resourceType,
      resourceId,
      schoolId,
      actorUserId: actor.userId,
      summary,
      correlationId: actor.correlationId,
    });
  }
}
