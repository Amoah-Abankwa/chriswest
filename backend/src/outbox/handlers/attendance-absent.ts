import { Injectable } from '@nestjs/common';
import { portalUrl } from '../../common/urls';
import { Mailer } from '../../mail/mailer';
import { NotificationsService } from '../../notifications/notifications.service';
import { recipientsForStudent } from '../../notifications/recipients';
import { PrismaService } from '../../prisma/prisma.service';

export type AbsentPayload = { sessionId: string; studentId: string };

/**
 * Emails a child's linked parents that they were marked absent. Checks the register again at
 * send time, so a correction made during the delay means no message is sent.
 */
@Injectable()
export class AttendanceAbsentHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
    private readonly notifications: NotificationsService,
  ) {}

  async handle(schoolId: string, payload: AbsentPayload): Promise<'sent' | 'skipped'> {
    const record = await this.prisma.attendanceRecord.findFirst({
      where: { schoolId, sessionId: payload.sessionId, studentId: payload.studentId },
      select: {
        status: true,
        session: { select: { date: true, class: { select: { name: true } } } },
        student: {
          select: {
            firstName: true,
            status: true,
            guardians: { where: { guardian: { email: { not: null } } }, select: { guardian: { select: { email: true } } } },
          },
        },
      },
    });
    if (!record || record.status !== 'ABSENT' || record.student.status !== 'ACTIVE') return 'skipped';

    const school = await this.prisma.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: { name: true, contactEmail: true, notifyAbsence: true, status: true, domains: { where: { isPrimary: true }, select: { hostname: true } } },
    });
    if (!school.notifyAbsence || school.status !== 'ACTIVE') return 'skipped';

    const recipients = [...new Set(record.student.guardians.map((g) => g.guardian.email!))];
    const inApp = await recipientsForStudent(this.prisma, schoolId, payload.studentId, { includeStudent: false });

    const date = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(record.session.date);
    const hostname = school.domains[0]?.hostname;
    // Kept short on purpose: first name, class and date only.
    const text =
      `${record.student.firstName} was marked absent from ${record.session.class.name} on ${date}.\n\n` +
      `If you think this is a mistake, please contact the school.` +
      (hostname ? `\n\nSee attendance: ${portalUrl(hostname, '/dashboard')}` : '');

    await this.notifications.create(
      inApp.userIds.map((userId) => ({
        schoolId,
        userId,
        kind: 'attendance.absent',
        title: `${record.student.firstName} was marked absent`,
        body: `${record.session.class.name}, ${date}.`,
        link: inApp.link,
      })),
    );
    for (const to of recipients) {
      await this.mailer.send(
        { to, subject: `${school.name}: absence on ${date}`, text, replyTo: school.contactEmail, idempotencyKey: `absent:${payload.sessionId}:${payload.studentId}:${to}` },
        { schoolId, kind: 'attendance.absent' },
      );
    }
    return recipients.length || inApp.userIds.length ? 'sent' : 'skipped';
  }
}
