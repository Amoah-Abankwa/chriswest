import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { badRequest, conflict, isUniqueViolation, notFound } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional();
export const RouteSchema = z.object({
  name: z.string().trim().min(2).max(80),
  vehicle: z.string().trim().max(60).nullable().optional(),
  driverName: z.string().trim().max(120).nullable().optional(),
  driverPhone: z.string().trim().max(30).regex(/^[+0-9 ()-]*$/).nullable().optional(),
  capacity: z.number().int().min(1).max(200).nullable().optional(),
  isActive: z.boolean().optional(),
});
export const StopsSchema = z.object({
  stops: z
    .array(z.object({ id: z.uuid().optional(), name: z.string().trim().min(1).max(80), pickupTime: time, dropoffTime: time }))
    .max(40)
    .refine((xs) => new Set(xs.map((x) => x.name.toLowerCase())).size === xs.length, { message: 'Each stop needs a different name' }),
});
export const AssignSchema = z.object({ routeId: z.uuid(), stopId: z.uuid(), direction: z.enum(['BOTH', 'MORNING', 'AFTERNOON']).default('BOTH') });

const ROUTE = {
  id: true,
  name: true,
  vehicle: true,
  driverName: true,
  driverPhone: true,
  capacity: true,
  isActive: true,
  stops: { orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, pickupTime: true, dropoffTime: true } },
  _count: { select: { assignments: true } },
} satisfies Prisma.TransportRouteSelect;

@Injectable()
export class TransportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async routes(schoolId: string) {
    const rows = await this.prisma.transportRoute.findMany({ where: { schoolId }, select: ROUTE, orderBy: { name: 'asc' } });
    return { data: rows.map(({ _count, ...r }) => ({ ...r, riders: _count.assignments })) };
  }

  /** A route with everyone on it, by stop. */
  async route(schoolId: string, id: string) {
    const r = await this.prisma.transportRoute.findFirst({
      where: { schoolId, id },
      select: {
        ...ROUTE,
        assignments: {
          select: {
            direction: true,
            stopId: true,
            student: { select: { id: true, firstName: true, lastName: true, admissionNumber: true, enrollments: { where: { status: 'ACTIVE' }, take: 1, select: { class: { select: { name: true } } } } } },
          },
          orderBy: { student: { lastName: 'asc' } },
        },
      },
    });
    if (!r) throw notFound('Route not found');
    const { _count, assignments, ...route } = r;
    return {
      data: {
        ...route,
        riders: _count.assignments,
        roster: assignments.map((a) => ({
          studentId: a.student.id,
          name: `${a.student.firstName} ${a.student.lastName}`,
          admissionNumber: a.student.admissionNumber,
          className: a.student.enrollments[0]?.class.name ?? null,
          stopId: a.stopId,
          direction: a.direction,
        })),
      },
    };
  }

  async createRoute(schoolId: string, input: z.infer<typeof RouteSchema>, actor: Actor) {
    try {
      const r = await this.prisma.transportRoute.create({ data: { schoolId, ...input }, select: { id: true } });
      await this.log('transport.route_create', schoolId, r.id, actor, { name: input.name });
      return this.route(schoolId, r.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'A route with this name already exists.');
      throw err;
    }
  }

  async updateRoute(schoolId: string, id: string, input: Partial<z.infer<typeof RouteSchema>>, actor: Actor) {
    const current = await this.route(schoolId, id);
    if (input.capacity && input.capacity < current.data.riders) throw conflict('OVER_CAPACITY', `${current.data.riders} students already ride this route.`);
    try {
      await this.prisma.transportRoute.update({ where: { id }, data: input });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'A route with this name already exists.');
      throw err;
    }
    await this.log('transport.route_update', schoolId, id, actor, { fields: Object.keys(input) });
    return this.route(schoolId, id);
  }

  /** Replaces the route's stops. A stop someone is assigned to can't be removed. */
  async setStops(schoolId: string, routeId: string, stops: z.infer<typeof StopsSchema>['stops'], actor: Actor) {
    const current = await this.route(schoolId, routeId);
    const kept = new Set(stops.flatMap((s) => (s.id ? [s.id] : [])));
    if ([...kept].some((id) => !current.data.stops.some((s) => s.id === id))) throw notFound('Stop not found');
    const removed = current.data.stops.filter((s) => !kept.has(s.id)).map((s) => s.id);
    if (current.data.roster.some((r) => removed.includes(r.stopId))) throw conflict('STOP_IN_USE', 'Move the students at a stop before removing it.');

    await this.prisma.$transaction(async (tx) => {
      await tx.transportStop.deleteMany({ where: { schoolId, routeId, id: { in: removed } } });
      for (const s of stops.filter((x) => x.id)) await tx.transportStop.update({ where: { id: s.id }, data: { name: `__renaming__${s.id}` } });
      for (const [i, s] of stops.entries()) {
        const data = { name: s.name, pickupTime: s.pickupTime ?? null, dropoffTime: s.dropoffTime ?? null, sortOrder: i };
        if (s.id) await tx.transportStop.update({ where: { id: s.id }, data });
        else await tx.transportStop.create({ data: { schoolId, routeId, ...data } });
      }
    });
    await this.log('transport.stops_set', schoolId, routeId, actor, { stops: stops.length });
    return this.route(schoolId, routeId);
  }

  async assign(schoolId: string, studentId: string, input: z.infer<typeof AssignSchema>, actor: Actor) {
    const [student, route, stop, existing] = await Promise.all([
      this.prisma.student.findUnique({ where: { schoolId_id: { schoolId, id: studentId } }, select: { status: true } }),
      this.prisma.transportRoute.findFirst({ where: { schoolId, id: input.routeId }, select: { isActive: true, capacity: true, _count: { select: { assignments: true } } } }),
      this.prisma.transportStop.findFirst({ where: { schoolId, id: input.stopId }, select: { routeId: true } }),
      this.prisma.transportAssignment.findUnique({ where: { schoolId_studentId: { schoolId, studentId } }, select: { routeId: true } }),
    ]);
    if (!student) throw notFound('Student not found');
    if (!route) throw notFound('Route not found');
    if (!stop) throw notFound('Stop not found');
    if (stop.routeId !== input.routeId) throw badRequest('STOP_NOT_ON_ROUTE', 'That stop isn’t on this route.');
    if (student.status !== 'ACTIVE') throw conflict('STUDENT_NOT_ACTIVE', 'Only current students can be assigned to a bus.');
    if (!route.isActive) throw conflict('ROUTE_INACTIVE', 'This route isn’t running.');
    const joining = existing?.routeId !== input.routeId;
    if (joining && route.capacity !== null && route._count.assignments >= route.capacity) throw conflict('ROUTE_FULL', `This bus is full (${route.capacity} seats).`);

    await this.prisma.transportAssignment.upsert({
      where: { schoolId_studentId: { schoolId, studentId } },
      create: { schoolId, studentId, ...input },
      update: { ...input, assignedAt: new Date() },
    });
    await this.log('transport.assign', schoolId, studentId, actor, { routeId: input.routeId, stopId: input.stopId });
    return this.forStudent(schoolId, studentId);
  }

  async unassign(schoolId: string, studentId: string, actor: Actor) {
    const removed = await this.prisma.transportAssignment.deleteMany({ where: { schoolId, studentId } });
    if (!removed.count) throw notFound('This student isn’t assigned to a bus');
    await this.log('transport.unassign', schoolId, studentId, actor, {});
  }

  /** A student's bus, for staff and (through the portal) their parents. */
  async forStudent(schoolId: string, studentId: string) {
    if (!(await this.prisma.student.count({ where: { schoolId, id: studentId } }))) throw notFound('Student not found');
    const a = await this.prisma.transportAssignment.findUnique({
      where: { schoolId_studentId: { schoolId, studentId } },
      select: {
        direction: true,
        route: { select: { id: true, name: true, vehicle: true, driverName: true, driverPhone: true } },
        stop: { select: { id: true, name: true, pickupTime: true, dropoffTime: true } },
      },
    });
    return { data: a };
  }

  private log(action: string, schoolId: string, resourceId: string, actor: Actor, summary: Prisma.InputJsonObject) {
    return this.audit.record({ action, outcome: 'SUCCESS', resourceType: 'transport', resourceId, schoolId, actorUserId: actor.userId, summary, correlationId: actor.correlationId });
  }
}
