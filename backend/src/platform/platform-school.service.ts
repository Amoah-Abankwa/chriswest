import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createBuiltInRoles } from '../access/built-in-roles';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { getEnv } from '../config/env';
import type { Prisma } from '../generated/prisma/client';
import { queueAccountEmail } from '../outbox/account-email';
import { PrismaService } from '../prisma/prisma.service';
import type { AddOwnerInput, ChangeStatusInput, CreateSchoolInput } from './platform.schemas';

/** Owners are members holding the built-in "School owner" role (key 'manager'). */
const OWNERS = { kind: 'STAFF', roles: { some: { role: { key: 'manager', isSystem: true } } } } satisfies Prisma.SchoolMembershipWhereInput;

type Actor = { auth: AuthContext; correlationId?: string };

const slugify = (name: string) =>
  name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'school';

/**
 * The super admin's view of the single school this system runs. The super admin creates the school
 * once, together with its owner; the owner does everything else (setup, staff, roles).
 */
@Injectable()
export class PlatformSchoolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The school, or null before it has been created. */
  async current() {
    const school = await this.prisma.school.findFirst({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        status: true,
        timezone: true,
        currency: true,
        createdAt: true,
        setupCompletedAt: true,
        domains: { where: { isPrimary: true }, select: { hostname: true } },
        memberships: { where: OWNERS, select: { user: { select: { id: true, email: true, fullName: true, status: true, lastLoginAt: true, mfaEnabled: true } } } },
        _count: { select: { students: true } },
        // Audit metadata only. Never student records.
        auditLogs: { orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, action: true, outcome: true, createdAt: true, summary: true } },
      },
    });
    if (!school) return { data: null };
    const staff = await this.prisma.schoolMembership.count({ where: { schoolId: school.id, kind: 'STAFF', status: 'ACTIVE' } });
    const { memberships, _count, auditLogs, domains, ...rest } = school;
    return {
      data: {
        ...rest,
        hostname: domains[0]?.hostname ?? null,
        owners: memberships.map((m) => m.user),
        counts: { staff, students: _count.students },
        recentActivity: auditLogs,
      },
    };
  }

  /** Creates the school and invites its owner. Allowed exactly once. */
  async create(input: CreateSchoolInput, actor: Actor) {
    const hostname = getEnv().SCHOOL_HOST;
    const created = await this.prisma.$transaction(async (tx) => {
      // Serialise concurrent attempts, then check: there can only ever be one school.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7311001)`;
      if (await tx.school.count()) throw new ConflictException({ code: 'SCHOOL_EXISTS', message: 'The school has already been created.' });

      const school = await tx.school.create({
        data: {
          name: input.name,
          slug: slugify(input.name),
          timezone: input.timezone,
          currency: input.currency,
          domains: { create: { hostname, kind: 'CUSTOM', isVerified: true, isPrimary: true, verifiedAt: new Date() } },
        },
        select: { id: true },
      });
      const roles = await createBuiltInRoles(tx, school.id);
      const user = await this.ownerAccount(tx, input.ownerEmail, input.ownerName);
      const membership = await tx.schoolMembership.create({ data: { schoolId: school.id, userId: user.id, kind: 'STAFF' }, select: { id: true } });
      await tx.membershipRole.create({ data: { schoolId: school.id, membershipId: membership.id, roleId: roles.manager! } });
      await queueAccountEmail(tx, { userId: user.id, schoolId: school.id, template: 'INVITE', audience: 'MANAGER' });
      return { schoolId: school.id, user };
    });

    await this.log('school.create', created.schoolId, created.schoolId, actor, { hostname, owner: created.user.email });
    return this.current();
  }

  /** Adds another owner, e.g. a co-owner or a replacement when the owner changes. */
  async addOwner(input: AddOwnerInput, actor: Actor) {
    const school = await this.requireSchool();
    if (school.status !== 'ACTIVE') throw new ConflictException({ code: 'SCHOOL_NOT_ACTIVE', message: 'Reactivate the school first.' });

    const userId = await this.prisma.$transaction(async (tx) => {
      const user = await this.ownerAccount(tx, input.email, input.fullName);
      const ownerRole = await tx.role.findFirstOrThrow({ where: { schoolId: school.id, key: 'manager', isSystem: true }, select: { id: true } });
      let membership = await tx.schoolMembership.findUnique({
        where: { schoolId_userId: { schoolId: school.id, userId: user.id } },
        select: { id: true, kind: true, roles: { select: { roleId: true } } },
      });
      if (membership && membership.kind !== 'STAFF') {
        throw new ConflictException({ code: 'EMAIL_IN_USE', message: 'This email belongs to a parent or student account. Owners need their own email.' });
      }
      if (membership?.roles.some((r) => r.roleId === ownerRole.id)) throw new ConflictException({ code: 'ALREADY_OWNER', message: 'This person is already an owner.' });
      membership ??= await tx.schoolMembership.create({ data: { schoolId: school.id, userId: user.id, kind: 'STAFF' }, select: { id: true, kind: true, roles: { select: { roleId: true } } } });
      await tx.schoolMembership.update({ where: { id: membership.id }, data: { status: 'ACTIVE' } });
      await tx.membershipRole.create({ data: { schoolId: school.id, membershipId: membership.id, roleId: ownerRole.id } });
      await queueAccountEmail(tx, { userId: user.id, schoolId: school.id, template: 'INVITE', audience: 'MANAGER' });
      return user.id;
    });

    await this.log('school.owner_added', school.id, userId, actor, { email: input.email });
    return this.current();
  }

  async resendInvitation(userId: string, actor: Actor) {
    const school = await this.requireSchool();
    const owner = await this.prisma.schoolMembership.findFirst({ where: { schoolId: school.id, userId, ...OWNERS }, select: { user: { select: { status: true } } } });
    if (!owner) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Owner not found' });
    if (owner.user.status !== 'INVITED') throw new ConflictException({ code: 'ALREADY_ACTIVE', message: 'This owner has already activated their account.' });
    if (school.status !== 'ACTIVE') throw new ConflictException({ code: 'SCHOOL_NOT_ACTIVE', message: 'Reactivate the school before sending invitations.' });
    await queueAccountEmail(this.prisma, { userId, schoolId: school.id, template: 'INVITE', audience: 'MANAGER' });
    await this.log('school.owner_invited', school.id, userId, actor, {});
    return { data: { invitationQueued: true } };
  }

  /** Suspending signs everyone at the school out and keeps them out until it's reactivated. Nothing is deleted. */
  async changeStatus(input: ChangeStatusInput, actor: Actor) {
    const school = await this.requireSchool();
    if (school.status === input.status) throw new ConflictException({ code: 'NO_CHANGE', message: `The school is already ${input.status.toLowerCase()}.` });
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.school.updateMany({ where: { id: school.id, status: school.status }, data: { status: input.status } });
      if (updated.count !== 1) throw new ConflictException({ code: 'CHANGED', message: 'Someone else just changed this. Reload and try again.' });
      if (input.status !== 'ACTIVE') await tx.session.updateMany({ where: { schoolId: school.id, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    await this.log('school.status_change', school.id, school.id, actor, { from: school.status, to: input.status, reason: input.reason });
    return this.current();
  }

  private async requireSchool() {
    const school = await this.prisma.school.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true, status: true } });
    if (!school) throw new NotFoundException({ code: 'NO_SCHOOL', message: 'The school hasn’t been created yet.' });
    return school;
  }

  /** Finds or creates the account for an owner. Platform and disabled accounts can't be owners. */
  private async ownerAccount(tx: Prisma.TransactionClient, email: string, fullName?: string) {
    const existing = await tx.user.findUnique({ where: { email }, select: { id: true, email: true, status: true, platformRole: true } });
    if (existing?.platformRole) throw new ConflictException({ code: 'EMAIL_NOT_ALLOWED', message: 'Super admin accounts can’t also own the school. Use a different email.' });
    if (existing?.status === 'DISABLED') throw new ConflictException({ code: 'ACCOUNT_DISABLED', message: 'That email belongs to a disabled account. Use a different email.' });
    return existing ?? tx.user.create({ data: { email, fullName: fullName ?? null, status: 'INVITED' }, select: { id: true, email: true, status: true, platformRole: true } });
  }

  private log(action: string, schoolId: string, resourceId: string, actor: Actor, summary: Prisma.InputJsonObject) {
    return this.audit.record({ action, outcome: 'SUCCESS', resourceType: 'school', resourceId, schoolId, actorUserId: actor.auth.userId, summary, correlationId: actor.correlationId });
  }
}
