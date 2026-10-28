import { Injectable } from '@nestjs/common';
import { portalUrl } from '../../common/urls';
import { Mailer } from '../../mail/mailer';
import { NotificationsService } from '../../notifications/notifications.service';
import { recipientsForStudent } from '../../notifications/recipients';
import { PrismaService } from '../../prisma/prisma.service';

export type ResultsPublishedPayload = { termId: string; classId: string; studentId: string };

/** Tells linked parents (with portal access) that a report card is ready. */
@Injectable()
export class ResultsPublishedHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
    private readonly notifications: NotificationsService,
  ) {}

  async handle(schoolId: string, p: ResultsPublishedPayload): Promise<'sent' | 'skipped'> {
    const published = await this.prisma.subjectResult.count({
      where: { schoolId, studentId: p.studentId, sheet: { termId: p.termId, classId: p.classId, status: 'PUBLISHED' } },
    });
    if (published === 0) return 'skipped';
    const [student, term, school] = await Promise.all([
      this.prisma.student.findUnique({
        where: { schoolId_id: { schoolId, id: p.studentId } },
        select: { firstName: true, guardians: { where: { portalAccess: true, guardian: { email: { not: null } } }, select: { guardian: { select: { email: true } } } } },
      }),
      this.prisma.term.findUnique({ where: { schoolId_id: { schoolId, id: p.termId } }, select: { name: true } }),
      this.prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { name: true, contactEmail: true, status: true, domains: { where: { isPrimary: true }, select: { hostname: true } } } }),
    ]);
    if (!student || !term || school.status !== 'ACTIVE') return 'skipped';
    const recipients = [...new Set(student.guardians.map((g) => g.guardian.email!))];
    const inApp = await recipientsForStudent(this.prisma, schoolId, p.studentId, { includeStudent: true });
    await this.notifications.create(
      inApp.userIds.map((userId) => ({
        schoolId,
        userId,
        kind: 'results.published',
        title: `${term.name} results are out`,
        body: `${student.firstName}'s report card is ready.`,
        link: inApp.link,
      })),
    );
    if (recipients.length === 0) return inApp.userIds.length ? 'sent' : 'skipped';
    const hostname = school.domains[0]?.hostname;
    for (const to of recipients) {
      await this.mailer.send({
        to,
        subject: `${school.name}: ${term.name} results for ${student.firstName}`,
        text:
          `${student.firstName}'s ${term.name} results have been published.` +
          (hostname ? `\n\nSign in to see the report card: ${portalUrl(hostname, '/dashboard')}` : ''),
        replyTo: school.contactEmail,
        idempotencyKey: `results:${p.termId}:${p.classId}:${p.studentId}:${to}`,
      }, { schoolId, kind: 'results.published' });
    }
    return 'sent';
  }
}
