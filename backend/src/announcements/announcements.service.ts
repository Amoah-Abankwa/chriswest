import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import type { Actor } from '../auth/decorators';
import { Clock } from '../common/clock';
import { badRequest, conflict, notFound } from '../common/errors';
import type { AnnouncementAudience, Prisma } from '../generated/prisma/client';
import { enqueue } from '../outbox/outbox';
import { PrismaService } from '../prisma/prisma.service';

const AUDIENCES = ['EVERYONE', 'STAFF', 'PARENTS', 'STUDENTS'] as const;
export const AnnouncementSchema = z.object({
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(1).max(5000),
  audience: z.enum(AUDIENCES),
  classIds: z.array(z.uuid()).max(50).default([]),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  notify: z.boolean().default(false),
});
export const UpdateAnnouncementSchema = AnnouncementSchema.partial();
export const PublishSchema = z.object({ publishAt: z.iso.datetime({ offset: true }).optional() });
export type AnnouncementInput = z.infer<typeof AnnouncementSchema>;
export type UpdateAnnouncementInput = z.infer<typeof UpdateAnnouncementSchema>;

const SELECT = {
  id: true,
  title: true,
  body: true,
  audience: true,
  publishedAt: true,
  expiresAt: true,
  notify: true,
  createdAt: true,
  updatedAt: true,
  classes: { select: { class: { select: { id: true, name: true } } } },
} satisfies Prisma.AnnouncementSelect;
type Row = Prisma.AnnouncementGetPayload<{ select: typeof SELECT }>;

@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private dto(a: Row) {
    const now = this.clock.now();
    const state = !a.publishedAt ? 'DRAFT' : a.publishedAt > now ? 'SCHEDULED' : a.expiresAt && a.expiresAt <= now ? 'EXPIRED' : 'LIVE';
    return { ...a, classes: a.classes.map((c) => c.class), state };
  }

  /** Everything, including drafts, for people who manage announcements. */
  async all(schoolId: string) {
    const rows = await this.prisma.announcement.findMany({ where: { schoolId }, select: SELECT, orderBy: [{ updatedAt: 'desc' }] });
    return { data: rows.map((a) => this.dto(a)) };
  }

  /**
   * What the signed-in person should see, by who they are in this school:
   * staff see EVERYONE and STAFF; parents see EVERYONE and PARENTS for their children's classes;
   * students see EVERYONE and STUDENTS for their own class. Class-targeted posts reach only those classes.
   */
  async feed(schoolId: string, auth: AuthContext) {
    const now = this.clock.now();
    const [membership, children, self] = await Promise.all([
      this.prisma.schoolMembership.findUnique({ where: { id: auth.membershipId! }, select: { kind: true } }),
      this.prisma.studentGuardian.findMany({
        where: { schoolId, portalAccess: true, guardian: { userId: auth.userId } },
        select: { student: { select: { enrollments: { where: { status: 'ACTIVE' }, select: { classId: true } } } } },
      }),
      this.prisma.student.findFirst({ where: { schoolId, userId: auth.userId }, select: { enrollments: { where: { status: 'ACTIVE' }, select: { classId: true } } } }),
    ]);
    const childClasses = children.flatMap((c) => c.student.enrollments.map((e) => e.classId));
    const ownClasses = self?.enrollments.map((e) => e.classId) ?? [];
    const forClasses = (ids: string[]): Prisma.AnnouncementWhereInput => ({ OR: [{ classes: { none: {} } }, { classes: { some: { classId: { in: ids } } } }] });

    const reach: Prisma.AnnouncementWhereInput[] = [];
    if (membership?.kind === 'STAFF') reach.push({ audience: { in: ['EVERYONE', 'STAFF'] } });
    if (children.length) reach.push({ AND: [{ audience: { in: ['EVERYONE', 'PARENTS'] } }, forClasses(childClasses)] });
    if (self) reach.push({ AND: [{ audience: { in: ['EVERYONE', 'STUDENTS'] } }, forClasses(ownClasses)] });
    if (reach.length === 0) return { data: [] };

    const rows = await this.prisma.announcement.findMany({
      where: { schoolId, publishedAt: { lte: now }, AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, { OR: reach }] },
      select: SELECT,
      orderBy: { publishedAt: 'desc' },
      take: 50,
    });
    return { data: rows.map((a) => ({ id: a.id, title: a.title, body: a.body, publishedAt: a.publishedAt, audience: a.audience })) };
  }

  async create(schoolId: string, input: AnnouncementInput, actor: Actor) {
    await this.assertClasses(schoolId, input.classIds);
    const a = await this.prisma.announcement.create({
      data: {
        schoolId,
        title: input.title,
        body: input.body,
        audience: input.audience,
        notify: input.notify,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdByUserId: actor.userId,
        classes: { create: input.classIds.map((classId) => ({ schoolId, classId })) },
      },
      select: SELECT,
    });
    await this.log('announcement.create', schoolId, a.id, actor, { audience: input.audience });
    return { data: this.dto(a) };
  }

  async update(schoolId: string, id: string, input: UpdateAnnouncementInput, actor: Actor) {
    await this.get(schoolId, id);
    if (input.classIds) await this.assertClasses(schoolId, input.classIds);
    await this.prisma.$transaction(async (tx) => {
      await tx.announcement.update({
        where: { id },
        data: {
          title: input.title,
          body: input.body,
          audience: input.audience,
          notify: input.notify,
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null } : {}),
        },
      });
      if (input.classIds) {
        await tx.announcementClass.deleteMany({ where: { announcementId: id } });
        await tx.announcementClass.createMany({ data: input.classIds.map((classId) => ({ schoolId, announcementId: id, classId })) });
      }
    });
    await this.log('announcement.update', schoolId, id, actor, { fields: Object.keys(input) });
    return this.get(schoolId, id);
  }

  /** Publishes now or at a set time. With notify on, people are told when it goes live (not before). */
  async publish(schoolId: string, id: string, publishAt: string | undefined, actor: Actor) {
    const a = await this.get(schoolId, id);
    if (a.data.publishedAt) throw conflict('ALREADY_PUBLISHED', 'This announcement is already published.');
    const at = publishAt ? new Date(publishAt) : this.clock.now();
    if (a.data.expiresAt && a.data.expiresAt <= at) throw badRequest('INVALID_DATES', 'It would expire before it’s published.');
    await this.prisma.$transaction(async (tx) => {
      await tx.announcement.update({ where: { id }, data: { publishedAt: at } });
      if (a.data.notify) {
        await enqueue(tx, [
          {
            schoolId,
            type: 'announcement.published',
            payload: { announcementId: id },
            dedupeKey: `announcement.published:${id}:${at.toISOString()}`,
            delayMs: Math.max(0, at.getTime() - Date.now()),
          },
        ]);
      }
    });
    await this.log('announcement.publish', schoolId, id, actor, { publishAt: at.toISOString() });
    return this.get(schoolId, id);
  }

  /** Takes a published announcement down. It stays on record as expired. */
  async withdraw(schoolId: string, id: string, actor: Actor) {
    const a = await this.get(schoolId, id);
    if (!a.data.publishedAt) throw conflict('NOT_PUBLISHED', 'Drafts can be deleted instead.');
    await this.prisma.announcement.update({ where: { id }, data: { expiresAt: this.clock.now() } });
    await this.log('announcement.withdraw', schoolId, id, actor, {});
    return this.get(schoolId, id);
  }

  async remove(schoolId: string, id: string, actor: Actor) {
    const a = await this.get(schoolId, id);
    if (a.data.publishedAt) throw conflict('ALREADY_PUBLISHED', 'Published announcements are withdrawn, not deleted.');
    await this.prisma.announcement.delete({ where: { id } });
    await this.log('announcement.delete', schoolId, id, actor, {});
  }

  async get(schoolId: string, id: string) {
    const a = await this.prisma.announcement.findFirst({ where: { schoolId, id }, select: SELECT });
    if (!a) throw notFound('Announcement not found');
    return { data: this.dto(a) };
  }

  private async assertClasses(schoolId: string, ids: string[]) {
    if (!ids.length) return;
    const found = await this.prisma.schoolClass.count({ where: { schoolId, id: { in: ids } } });
    if (found !== new Set(ids).size) throw notFound('Class not found');
  }

  private log(action: string, schoolId: string, id: string, actor: Actor, summary: Prisma.InputJsonObject) {
    return this.audit.record({ action, outcome: 'SUCCESS', resourceType: 'announcement', resourceId: id, schoolId, actorUserId: actor.userId, summary, correlationId: actor.correlationId });
  }
}

export type { AnnouncementAudience };
