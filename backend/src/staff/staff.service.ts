import { Injectable } from '@nestjs/common';
import { assertCanGrantAll, canGrantAll, type Grant } from '../access/delegation';
import { AuditService } from '../audit/audit.service';
import { conflict, isUniqueViolation, notFound } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import { queueAccountEmail } from '../outbox/account-email';
import { PrismaService } from '../prisma/prisma.service';
import { auditHistory } from './audit-history';
import type { StaffActor } from './roles.service';
import type { InviteStaffInput, ListStaffInput, UpdateStaffInput } from './staff.schemas';

const ROLE_GRANTS = {
  select: { role: { select: { id: true, key: true, name: true, isSystem: true, permissions: { select: { permissionKey: true, scope: true } } } } },
} as const;

const STAFF = {
  id: true,
  status: true,
  createdAt: true,
  user: { select: { id: true, email: true, fullName: true, status: true, lastLoginAt: true } },
  staffProfile: { select: { jobTitle: true, staffNumber: true, phone: true } },
  roles: ROLE_GRANTS,
} satisfies Prisma.SchoolMembershipSelect;

type StaffRow = Prisma.SchoolMembershipGetPayload<{ select: typeof STAFF }>;

const grantsOfMember = (m: { roles: { role: { permissions: { permissionKey: string; scope: 'SCHOOL' | 'ASSIGNED' }[] } }[] }): Grant[] =>
  m.roles.flatMap((r) => r.role.permissions.map((p) => ({ key: p.permissionKey, scope: p.scope })));

const staffNotFound = () => notFound('Staff member not found');
const selfChange = () => conflict('SELF_CHANGE', "You can't do this to your own account. Ask another administrator.");
const staffNumberTaken = () => conflict('STAFF_NUMBER_TAKEN', 'Another staff member already has this staff number.');

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(schoolId: string, q: ListStaffInput) {
    const where: Prisma.SchoolMembershipWhereInput = {
      schoolId,
      kind: 'STAFF',
      ...(q.status ? { status: q.status } : {}),
      ...(q.roleId ? { roles: { some: { roleId: q.roleId } } } : {}),
      ...(q.search
        ? {
            OR: [
              { user: { email: { contains: q.search, mode: 'insensitive' } } },
              { user: { fullName: { contains: q.search, mode: 'insensitive' } } },
              { staffProfile: { is: { staffNumber: { contains: q.search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.schoolMembership.findMany({
        where,
        select: STAFF,
        orderBy: [{ status: 'asc' }, { user: { fullName: 'asc' } }, { user: { email: 'asc' } }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.schoolMembership.count({ where }),
    ]);
    return {
      data: rows.map((r) => this.summary(r)),
      meta: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) },
    };
  }

  async get(schoolId: string, membershipId: string, actor: StaffActor) {
    const m = await this.prisma.schoolMembership.findFirst({
      where: { schoolId, id: membershipId, kind: 'STAFF' },
      select: {
        ...STAFF,
        classTeacherOf: {
          where: { class: { academicYear: { status: { not: 'CLOSED' } } } },
          select: { class: { select: { id: true, name: true, academicYear: { select: { name: true } } } } },
        },
        subjectsTaught: {
          where: { classSubject: { class: { academicYear: { status: { not: 'CLOSED' } } } } },
          select: {
            classSubject: {
              select: {
                subject: { select: { name: true } },
                class: { select: { id: true, name: true, academicYear: { select: { name: true } } } },
              },
            },
          },
        },
      },
    });
    if (!m) throw staffNotFound();
    return {
      data: {
        ...this.summary(m),
        phone: m.staffProfile?.phone ?? null,
        isYou: m.id === actor.auth.membershipId,
        canManage: m.id !== actor.auth.membershipId && canGrantAll(actor.auth.permissions, grantsOfMember(m)),
        assignments: {
          classTeacherOf: m.classTeacherOf.map((c) => ({ classId: c.class.id, className: c.class.name, yearName: c.class.academicYear.name })),
          subjects: m.subjectsTaught.map((s) => ({
            classId: s.classSubject.class.id,
            className: s.classSubject.class.name,
            subjectName: s.classSubject.subject.name,
            yearName: s.classSubject.class.academicYear.name,
          })),
        },
      },
    };
  }

  async invite(schoolId: string, input: InviteStaffInput, actor: StaffActor) {
    const roles = await this.loadRoles(schoolId, input.roleIds);
    assertCanGrantAll(actor.auth.permissions, roles.flatMap((r) => r.grants));

    if (input.staffNumber) {
      const clash = await this.prisma.staffProfile.findUnique({
        where: { schoolId_staffNumber: { schoolId, staffNumber: input.staffNumber } },
        select: { membershipId: true },
      });
      if (clash) throw staffNumberTaken();
    }

    let created: { membershipId: string; user: { id: string; email: string; status: string } };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        let user = await tx.user.findUnique({
          where: { email: input.email },
          select: { id: true, email: true, status: true, platformRole: true },
        });
        if (user?.platformRole) {
          throw conflict('EMAIL_NOT_ALLOWED', "This email belongs to a platform administrator and can't be used for school staff.");
        }
        if (user?.status === 'DISABLED') {
          throw conflict('ACCOUNT_DISABLED', 'This email belongs to a disabled account. Use a different email.');
        }
        let parentMembershipId: string | null = null;
        if (user) {
          const existing = await tx.schoolMembership.findUnique({
            where: { schoolId_userId: { schoolId, userId: user.id } },
            select: { id: true, status: true, kind: true },
          });
          if (existing?.kind === 'PARENT') {
            // A parent at this school joining the staff keeps one account; their parent access is unaffected.
            parentMembershipId = existing.id;
          } else if (existing?.status === 'DISABLED') {
            throw conflict('FORMER_MEMBER', 'This person has a deactivated account at this school. Reactivate them instead.');
          } else if (existing) {
            throw conflict('ALREADY_MEMBER', 'This person already has an account at this school.');
          }
        }
        user ??= await tx.user.create({
          data: { email: input.email, fullName: input.fullName ?? null, status: 'INVITED' },
          select: { id: true, email: true, status: true, platformRole: true },
        });

        const membership = parentMembershipId
          ? await tx.schoolMembership.update({ where: { id: parentMembershipId }, data: { kind: 'STAFF', status: 'ACTIVE' }, select: { id: true } })
          : await tx.schoolMembership.create({ data: { schoolId, userId: user.id, kind: 'STAFF' }, select: { id: true } });
        await tx.staffProfile.create({
          data: {
            schoolId,
            membershipId: membership.id,
            jobTitle: input.jobTitle ?? null,
            staffNumber: input.staffNumber ?? null,
            phone: input.phone ?? null,
          },
        });
        await tx.membershipRole.createMany({
          data: roles.map((r) => ({ schoolId, membershipId: membership.id, roleId: r.id })),
        });
        return { membershipId: membership.id, user: { id: user.id, email: user.email, status: user.status } };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('CONFLICT', 'Someone else just made a similar change. Reload and try again.');
      throw err;
    }

    await this.log('staff.invite', schoolId, created.membershipId, actor, { roles: roles.map((r) => r.name) });
    const invitationSent = await this.notify(schoolId, created.membershipId, created.user, actor);
    return { data: { membershipId: created.membershipId, accountStatus: created.user.status, invitationQueued: invitationSent } };
  }

  async update(schoolId: string, membershipId: string, input: UpdateStaffInput, actor: StaffActor) {
    const m = await this.loadTarget(schoolId, membershipId);
    if (input.fullName !== undefined && m.user.status !== 'INVITED' && input.fullName !== m.user.fullName) {
      throw conflict('NAME_LOCKED', 'People set their own name once they have activated their account.');
    }
    const profile = { jobTitle: input.jobTitle, staffNumber: input.staffNumber, phone: input.phone };
    try {
      await this.prisma.$transaction(async (tx) => {
        if (input.fullName !== undefined && m.user.status === 'INVITED') {
          await tx.user.update({ where: { id: m.user.id }, data: { fullName: input.fullName } });
        }
        await tx.staffProfile.upsert({
          where: { membershipId },
          create: { schoolId, membershipId, jobTitle: input.jobTitle ?? null, staffNumber: input.staffNumber ?? null, phone: input.phone ?? null },
          update: profile,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw staffNumberTaken();
      throw err;
    }
    await this.log('staff.profile_update', schoolId, membershipId, actor, { fields: Object.keys(input) });
    return this.get(schoolId, membershipId, actor);
  }

  /**
   * Replaces someone's roles. You can't change your own roles, and you can only add or remove
   * roles whose permissions you hold yourself, so nobody can escalate or strip a more senior colleague.
   */
  async setRoles(schoolId: string, membershipId: string, roleIds: string[], actor: StaffActor) {
    if (membershipId === actor.auth.membershipId) throw selfChange();
    const m = await this.loadTarget(schoolId, membershipId);
    const next = await this.loadRoles(schoolId, roleIds);

    const currentIds = new Set(m.roles.map((r) => r.role.id));
    const nextIds = new Set(next.map((r) => r.id));
    const added = next.filter((r) => !currentIds.has(r.id));
    const removed = m.roles.map((r) => r.role).filter((r) => !nextIds.has(r.id));

    assertCanGrantAll(
      actor.auth.permissions,
      [...added.flatMap((r) => r.grants), ...removed.flatMap((r) => r.permissions.map((p) => ({ key: p.permissionKey, scope: p.scope })))],
    );
    if (removed.some((r) => r.key === 'manager' && r.isSystem)) await this.assertNotLastManager(schoolId, membershipId);

    await this.prisma.$transaction([
      this.prisma.membershipRole.deleteMany({ where: { schoolId, membershipId, roleId: { in: removed.map((r) => r.id) } } }),
      this.prisma.membershipRole.createMany({ data: added.map((r) => ({ schoolId, membershipId, roleId: r.id })) }),
    ]);
    // Permissions are re-read on every request, so the change applies to their next action.
    await this.log('staff.roles_change', schoolId, membershipId, actor, {
      added: added.map((r) => r.name),
      removed: removed.map((r) => r.name),
    });
    return this.get(schoolId, membershipId, actor);
  }

  async deactivate(schoolId: string, membershipId: string, reason: string, actor: StaffActor) {
    if (membershipId === actor.auth.membershipId) throw selfChange();
    const m = await this.loadTarget(schoolId, membershipId);
    if (m.status !== 'ACTIVE') throw conflict('ALREADY_DEACTIVATED', 'This account is already deactivated.');
    assertCanGrantAll(actor.auth.permissions, grantsOfMember(m), "You can't deactivate someone who has permissions you don't have.");
    if (m.roles.some((r) => r.role.key === 'manager' && r.role.isSystem)) await this.assertNotLastManager(schoolId, membershipId);

    const removed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.schoolMembership.updateMany({ where: { id: membershipId, status: 'ACTIVE' }, data: { status: 'DISABLED' } });
      if (updated.count !== 1) throw conflict('CHANGED', 'Someone else just changed this account. Reload and try again.');
      await tx.session.updateMany({ where: { userId: m.user.id, schoolId, revokedAt: null }, data: { revokedAt: new Date() } });
      // Free their current classes so someone else can be assigned; closed years keep their history.
      const open = { academicYear: { status: { not: 'CLOSED' as const } } };
      const classes = await tx.classTeacher.deleteMany({ where: { schoolId, membershipId, class: open } });
      const subjects = await tx.subjectTeacher.deleteMany({ where: { schoolId, membershipId, classSubject: { class: open } } });
      return classes.count + subjects.count;
    });

    await this.log('staff.deactivate', schoolId, membershipId, actor, { reason, assignmentsRemoved: removed });
    return this.get(schoolId, membershipId, actor);
  }

  async reactivate(schoolId: string, membershipId: string, reason: string, actor: StaffActor) {
    if (membershipId === actor.auth.membershipId) throw selfChange();
    const m = await this.loadTarget(schoolId, membershipId);
    if (m.status !== 'DISABLED') throw conflict('ALREADY_ACTIVE', 'This account is already active.');
    assertCanGrantAll(actor.auth.permissions, grantsOfMember(m), "You can't reactivate someone who has permissions you don't have.");
    await this.prisma.schoolMembership.update({ where: { id: membershipId }, data: { status: 'ACTIVE' } });
    await this.log('staff.reactivate', schoolId, membershipId, actor, { reason });
    return this.get(schoolId, membershipId, actor);
  }

  async resendInvitation(schoolId: string, membershipId: string, actor: StaffActor) {
    const m = await this.loadTarget(schoolId, membershipId);
    if (m.user.status !== 'INVITED') throw conflict('ALREADY_ACTIVE', 'This person has already activated their account.');
    if (m.status !== 'ACTIVE') throw conflict('DEACTIVATED', 'Reactivate this account before sending an invitation.');
    const sent = await this.notify(schoolId, membershipId, m.user, actor);
    return { data: { invitationQueued: sent } };
  }

  async history(schoolId: string, membershipId: string) {
    await this.loadTarget(schoolId, membershipId);
    return { data: await auditHistory(this.prisma, schoolId, 'membership', membershipId) };
  }

  /** The signed-in person's own teaching assignments in the current year. */
  async myAssignments(schoolId: string, membershipId: string) {
    const year = await this.prisma.academicYear.findFirst({ where: { schoolId, status: 'ACTIVE' }, select: { id: true, name: true } });
    if (!year) return { data: { year: null, classes: [] } };
    const classes = await this.prisma.schoolClass.findMany({
      where: {
        schoolId,
        academicYearId: year.id,
        OR: [{ classTeacher: { is: { membershipId } } }, { subjects: { some: { teacher: { is: { membershipId } } } } }],
      },
      select: {
        id: true,
        name: true,
        classTeacher: { select: { membershipId: true } },
        subjects: { where: { teacher: { is: { membershipId } } }, select: { subject: { select: { name: true } } } },
      },
      orderBy: [{ level: { sortOrder: 'asc' } }, { name: 'asc' }],
    });
    return {
      data: {
        year,
        classes: classes.map((c) => ({
          id: c.id,
          name: c.name,
          isClassTeacher: c.classTeacher?.membershipId === membershipId,
          subjects: c.subjects.map((s) => s.subject.name),
        })),
      },
    };
  }

  private summary(r: StaffRow) {
    return {
      membershipId: r.id,
      status: r.status,
      accountStatus: r.user.status,
      email: r.user.email,
      fullName: r.user.fullName,
      lastLoginAt: r.user.lastLoginAt,
      jobTitle: r.staffProfile?.jobTitle ?? null,
      staffNumber: r.staffProfile?.staffNumber ?? null,
      roles: r.roles.map((x) => ({ id: x.role.id, name: x.role.name, isSystem: x.role.isSystem })),
      joinedAt: r.createdAt,
    };
  }

  private async loadTarget(schoolId: string, membershipId: string) {
    const m = await this.prisma.schoolMembership.findFirst({ where: { schoolId, id: membershipId, kind: 'STAFF' }, select: STAFF });
    if (!m) throw staffNotFound();
    return m;
  }

  private async loadRoles(schoolId: string, roleIds: string[]) {
    const roles = await this.prisma.role.findMany({
      where: { schoolId, id: { in: roleIds } },
      select: { id: true, key: true, name: true, isSystem: true, permissions: { select: { permissionKey: true, scope: true } } },
    });
    if (roles.length !== roleIds.length) throw notFound('Role not found');
    return roles.map((r) => ({ ...r, grants: r.permissions.map((p) => ({ key: p.permissionKey, scope: p.scope })) }));
  }

  private async assertNotLastManager(schoolId: string, excludingMembershipId: string) {
    const others = await this.prisma.schoolMembership.count({
      where: {
        schoolId,
        id: { not: excludingMembershipId },
        status: 'ACTIVE',
        roles: { some: { role: { key: 'manager', isSystem: true } } },
      },
    });
    if (others === 0) throw conflict('LAST_MANAGER', 'A school must always have at least one active Manager.');
  }

  /** Queues the invitation; the worker sends it with retries and creates the activation link then. */
  private async notify(schoolId: string, membershipId: string, user: { id: string; email: string; status: string }, actor: StaffActor) {
    await queueAccountEmail(this.prisma, { userId: user.id, schoolId, template: 'INVITE', audience: 'STAFF' });
    await this.log('staff.invitation_sent', schoolId, membershipId, actor, {});
    return true;
  }

  private log(action: string, schoolId: string, resourceId: string, actor: StaffActor, summary: Prisma.InputJsonObject) {
    return this.audit.record({
      action,
      outcome: 'SUCCESS',
      resourceType: 'membership',
      resourceId,
      schoolId,
      actorUserId: actor.auth.userId,
      summary,
      correlationId: actor.correlationId,
    });
  }
}
