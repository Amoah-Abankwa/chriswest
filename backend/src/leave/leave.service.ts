import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import type { Actor } from '../auth/decorators';
import { Clock } from '../common/clock';
import { fromDbDate, IsoDate, toDbDate } from '../common/dates';
import { badRequest, conflict, isUniqueViolation, notFound } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

export const LeaveTypeSchema = z.object({ name: z.string().trim().min(2).max(60), daysPerYear: z.number().int().min(0).max(365), isActive: z.boolean().optional() });
export const LeaveRequestSchema = z.object({ typeId: z.uuid(), startDate: IsoDate, endDate: IsoDate, reason: z.string().trim().min(3).max(500) });
export const DecisionSchema = z.object({ note: z.string().trim().max(500).optional() });
export const RequestsQuery = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional() });

/** Monday to Friday between two dates, inclusive. */
export function workingDays(start: string, end: string) {
  let n = 0;
  for (let d = toDbDate(start); d <= toDbDate(end); d = new Date(d.getTime() + 86_400_000)) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

const REQUEST = {
  id: true,
  startDate: true,
  endDate: true,
  days: true,
  reason: true,
  status: true,
  decisionNote: true,
  decidedAt: true,
  createdAt: true,
  type: { select: { id: true, name: true } },
  membership: { select: { id: true, user: { select: { fullName: true, email: true } } } },
} satisfies Prisma.LeaveRequestSelect;
type RequestRow = Prisma.LeaveRequestGetPayload<{ select: typeof REQUEST }>;
const dto = (r: RequestRow) => ({
  ...r,
  startDate: fromDbDate(r.startDate),
  endDate: fromDbDate(r.endDate),
  membership: undefined,
  staff: { membershipId: r.membership.id, name: r.membership.user.fullName ?? r.membership.user.email },
});

@Injectable()
export class LeaveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly clock: Clock,
  ) {}

  async types(schoolId: string) {
    return { data: await this.prisma.leaveType.findMany({ where: { schoolId }, orderBy: { name: 'asc' }, select: { id: true, name: true, daysPerYear: true, isActive: true } }) };
  }

  async createType(schoolId: string, input: z.infer<typeof LeaveTypeSchema>, actor: Actor) {
    try {
      const t = await this.prisma.leaveType.create({ data: { schoolId, ...input }, select: { id: true } });
      await this.log('leave.type_create', schoolId, t.id, actor, { name: input.name, daysPerYear: input.daysPerYear });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'A leave type with this name already exists.');
      throw err;
    }
    return this.types(schoolId);
  }

  async updateType(schoolId: string, id: string, input: Partial<z.infer<typeof LeaveTypeSchema>>, actor: Actor) {
    if (!(await this.prisma.leaveType.count({ where: { schoolId, id } }))) throw notFound('Leave type not found');
    await this.prisma.leaveType.update({ where: { id }, data: input });
    await this.log('leave.type_update', schoolId, id, actor, { fields: Object.keys(input) });
    return this.types(schoolId);
  }

  /** The signed-in staff member's allowances for a calendar year and their requests. */
  async mine(schoolId: string, auth: AuthContext, year?: number) {
    const y = year ?? Number(this.clock.today('Africa/Accra').slice(0, 4));
    const [types, used, requests] = await Promise.all([
      this.prisma.leaveType.findMany({ where: { schoolId, isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, daysPerYear: true } }),
      this.usedDays(schoolId, auth.membershipId!, y),
      this.prisma.leaveRequest.findMany({ where: { schoolId, membershipId: auth.membershipId! }, orderBy: { startDate: 'desc' }, take: 50, select: REQUEST }),
    ]);
    return {
      data: {
        year: y,
        balances: types.map((t) => ({ ...t, used: used.get(t.id) ?? 0, remaining: t.daysPerYear - (used.get(t.id) ?? 0) })),
        requests: requests.map(dto),
      },
    };
  }

  /** A staff member asks for leave. It can't overlap their other leave or exceed the year's allowance. */
  async request(schoolId: string, auth: AuthContext, input: z.infer<typeof LeaveRequestSchema>, actor: Actor) {
    const membership = await this.prisma.schoolMembership.findUnique({ where: { id: auth.membershipId! }, select: { kind: true } });
    if (membership?.kind !== 'STAFF') throw conflict('STAFF_ONLY', 'Only staff can request leave.');
    if (input.endDate < input.startDate) throw badRequest('INVALID_DATES', 'The leave must end on or after its first day.');
    if (input.startDate.slice(0, 4) !== input.endDate.slice(0, 4)) throw badRequest('SPANS_YEARS', 'Split leave that crosses into a new year into two requests.');
    const days = workingDays(input.startDate, input.endDate);
    if (days === 0) throw badRequest('NO_WORKING_DAYS', 'These dates are all on a weekend.');
    const type = await this.prisma.leaveType.findFirst({ where: { schoolId, id: input.typeId, isActive: true }, select: { daysPerYear: true, name: true } });
    if (!type) throw notFound('Leave type not found');

    const overlap = await this.prisma.leaveRequest.findFirst({
      where: { schoolId, membershipId: auth.membershipId!, status: { in: ['PENDING', 'APPROVED'] }, startDate: { lte: toDbDate(input.endDate) }, endDate: { gte: toDbDate(input.startDate) } },
      select: { id: true },
    });
    if (overlap) throw conflict('OVERLAPS', 'You already have leave requested or approved for some of these days.');
    const used = (await this.usedDays(schoolId, auth.membershipId!, Number(input.startDate.slice(0, 4)))).get(input.typeId) ?? 0;
    if (used + days > type.daysPerYear) {
      throw conflict('NOT_ENOUGH_DAYS', `This needs ${days} working days, but only ${type.daysPerYear - used} of your ${type.daysPerYear} days of ${type.name.toLowerCase()} are left this year.`);
    }

    const r = await this.prisma.leaveRequest.create({
      data: { schoolId, membershipId: auth.membershipId!, typeId: input.typeId, startDate: toDbDate(input.startDate), endDate: toDbDate(input.endDate), days, reason: input.reason },
      select: REQUEST,
    });
    await this.log('leave.request', schoolId, r.id, actor, { days, type: type.name });
    const approvers = await this.prisma.schoolMembership.findMany({
      where: { schoolId, kind: 'STAFF', status: 'ACTIVE', id: { not: auth.membershipId! }, roles: { some: { role: { permissions: { some: { permissionKey: 'leave.approve' } } } } } },
      select: { userId: true },
    });
    await this.notifications.create(approvers.map((a) => ({ schoolId, userId: a.userId, kind: 'leave.requested', title: 'Leave request to review', body: `${dto(r).staff.name}: ${days} day(s) of ${type.name.toLowerCase()} from ${input.startDate}.`, link: '/leave?tab=review' })));
    return { data: dto(r) };
  }

  async cancel(schoolId: string, auth: AuthContext, id: string, actor: Actor) {
    const r = await this.prisma.leaveRequest.findFirst({ where: { schoolId, id, membershipId: auth.membershipId! }, select: { status: true, startDate: true } });
    if (!r) throw notFound('Leave request not found');
    if (r.status === 'REJECTED' || r.status === 'CANCELLED') throw conflict('INVALID_TRANSITION', 'This request is already closed.');
    if (r.status === 'APPROVED' && fromDbDate(r.startDate) <= this.clock.today('Africa/Accra')) {
      throw conflict('ALREADY_STARTED', 'Leave that has started can’t be cancelled here. Speak to your approver.');
    }
    await this.prisma.leaveRequest.update({ where: { id }, data: { status: 'CANCELLED' } });
    await this.log('leave.cancel', schoolId, id, actor, {});
    return this.mine(schoolId, auth);
  }

  async requests(schoolId: string, status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED') {
    const rows = await this.prisma.leaveRequest.findMany({ where: { schoolId, ...(status ? { status } : {}) }, orderBy: [{ status: 'asc' }, { startDate: 'asc' }], take: 200, select: REQUEST });
    return { data: rows.map(dto) };
  }

  /** Approvers can't decide on their own requests. The requester is told either way. */
  async decide(schoolId: string, id: string, decision: 'APPROVED' | 'REJECTED', note: string | undefined, auth: AuthContext, actor: Actor) {
    const r = await this.prisma.leaveRequest.findFirst({ where: { schoolId, id }, select: { membershipId: true, status: true, membership: { select: { userId: true } } } });
    if (!r) throw notFound('Leave request not found');
    if (r.membershipId === auth.membershipId) throw conflict('SELF_APPROVAL', 'Someone else needs to decide on your own leave.');
    const updated = await this.prisma.leaveRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: decision, decidedByUserId: auth.userId, decidedAt: this.clock.now(), decisionNote: note ?? null },
    });
    if (!updated.count) throw conflict('INVALID_TRANSITION', 'This request has already been decided or cancelled.');
    await this.log(decision === 'APPROVED' ? 'leave.approve' : 'leave.reject', schoolId, id, actor, note ? { note } : {});
    await this.notifications.create([
      { schoolId, userId: r.membership.userId, kind: 'leave.decided', title: `Leave ${decision === 'APPROVED' ? 'approved' : 'declined'}`, body: note ?? 'See your leave page for details.', link: '/leave' },
    ]);
    return this.requests(schoolId);
  }

  private async usedDays(schoolId: string, membershipId: string, year: number) {
    const rows = await this.prisma.leaveRequest.groupBy({
      by: ['typeId'],
      where: { schoolId, membershipId, status: { in: ['PENDING', 'APPROVED'] }, startDate: { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) } },
      _sum: { days: true },
    });
    return new Map(rows.map((r) => [r.typeId, r._sum.days ?? 0]));
  }

  private log(action: string, schoolId: string, resourceId: string, actor: Actor, summary: Prisma.InputJsonObject) {
    return this.audit.record({ action, outcome: 'SUCCESS', resourceType: 'leave', resourceId, schoolId, actorUserId: actor.userId, summary, correlationId: actor.correlationId });
  }
}
