import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { portalUrl } from '../../common/urls';
import { enqueue } from '../outbox';
import type { SendEmailPayload } from './send-email';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';

/** When a notifying announcement goes live: in-app notices to its audience, and email to parents. */
@Injectable()
export class AnnouncementPublishedHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly clock: Clock,
  ) {}

  async handle(schoolId: string, payload: { announcementId: string }): Promise<'sent' | 'skipped'> {
    const a = await this.prisma.announcement.findFirst({
      where: { schoolId, id: payload.announcementId },
      select: { title: true, body: true, audience: true, publishedAt: true, expiresAt: true, classes: { select: { classId: true } } },
    });
    const now = this.clock.now();
    if (!a || !a.publishedAt || a.publishedAt > now || (a.expiresAt && a.expiresAt <= now)) return 'skipped';
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { name: true, contactEmail: true, status: true, domains: { where: { isPrimary: true }, select: { hostname: true } } } });
    if (school.status !== 'ACTIVE') return 'skipped';

    const classIds = a.classes.map((c) => c.classId);
    const inScope = classIds.length ? { enrollments: { some: { status: 'ACTIVE' as const, classId: { in: classIds } } } } : {};
    const users = new Set<string>();
    const emails = new Set<string>();

    if (a.audience === 'EVERYONE' || a.audience === 'STAFF') {
      const staff = await this.prisma.schoolMembership.findMany({ where: { schoolId, kind: 'STAFF', status: 'ACTIVE' }, select: { userId: true } });
      staff.forEach((m) => users.add(m.userId));
    }
    if (a.audience === 'EVERYONE' || a.audience === 'PARENTS') {
      const links = await this.prisma.studentGuardian.findMany({
        where: { schoolId, student: { status: 'ACTIVE', ...inScope } },
        select: { portalAccess: true, guardian: { select: { userId: true, email: true } } },
      });
      for (const l of links) {
        if (l.portalAccess && l.guardian.userId) users.add(l.guardian.userId);
        if (l.guardian.email) emails.add(l.guardian.email);
      }
    }
    if (a.audience === 'EVERYONE' || a.audience === 'STUDENTS') {
      const students = await this.prisma.student.findMany({ where: { schoolId, status: 'ACTIVE', userId: { not: null }, ...inScope }, select: { userId: true } });
      students.forEach((s) => users.add(s.userId!));
    }

    const preview = a.body.length > 160 ? `${a.body.slice(0, 157)}…` : a.body;
    await this.notifications.create([...users].map((userId) => ({ schoolId, userId, kind: 'announcement', title: a.title, body: preview, link: '/announcements' })));
    // One queued email per parent: each is retried on its own, a failure never resends to everyone,
    // and a big school's mailing can't outlast the worker's lease on a single job.
    const hostname = school.domains[0]?.hostname;
    await enqueue(
      this.prisma,
      [...emails].map((to) => {
        const key = `announcement.email:${payload.announcementId}:${to}`;
        const email: SendEmailPayload = {
          to,
          subject: `${school.name}: ${a.title}`,
          text: `${a.body}${hostname ? `\n\n${portalUrl(hostname, '/announcements')}` : ''}`,
          replyTo: school.contactEmail,
          kind: 'announcement',
          idempotencyKey: key,
        };
        return { schoolId, type: 'email.send', payload: email, dedupeKey: key };
      }),
    );
    return users.size || emails.size ? 'sent' : 'skipped';
  }
}
