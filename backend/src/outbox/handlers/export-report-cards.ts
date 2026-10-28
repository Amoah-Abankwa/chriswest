import { Injectable } from '@nestjs/common';
import { NotificationsService } from '../../notifications/notifications.service';
import { reportCardsPdf } from '../../pdf/pdf';
import { PrismaService } from '../../prisma/prisma.service';
import { ReportCardsService } from '../../results/report-cards.service';
import { FileStorage } from '../../storage/file-storage';

/** Builds one PDF with every report card for a class and term, stores it privately and tells the requester. */
@Injectable()
export class ExportReportCardsHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cards: ReportCardsService,
    private readonly storage: FileStorage,
    private readonly notifications: NotificationsService,
  ) {}

  async handle(schoolId: string, payload: { jobId: string }): Promise<'sent' | 'skipped'> {
    const job = await this.prisma.exportJob.findFirst({ where: { schoolId, id: payload.jobId }, select: { status: true, params: true, createdByUserId: true, fileName: true } });
    if (!job || job.status === 'READY') return 'skipped';
    await this.prisma.exportJob.update({ where: { id: payload.jobId }, data: { status: 'RUNNING', error: null } });
    const { termId, classId } = job.params as { termId: string; classId: string };

    const students = await this.prisma.subjectResult.findMany({
      where: { schoolId, sheet: { termId, classId, status: 'PUBLISHED' } },
      distinct: ['studentId'],
      select: { studentId: true, student: { select: { lastName: true, firstName: true } } },
    });
    students.sort((a, b) => `${a.student.lastName} ${a.student.firstName}`.localeCompare(`${b.student.lastName} ${b.student.firstName}`));
    const cards = [];
    for (const s of students) cards.push((await this.cards.card(schoolId, s.studentId, termId)).data);

    const pdf = await reportCardsPdf(cards);
    const storageKey = `schools/${schoolId}/exports/${payload.jobId}`;
    await this.storage.delete(storageKey).catch(() => undefined); // a retry may have written part of it
    await this.storage.put(storageKey, pdf, 'application/pdf');
    await this.prisma.exportJob.update({ where: { id: payload.jobId }, data: { status: 'READY', storageKey, completedAt: new Date() } });
    await this.notifications.create([
      { schoolId, userId: job.createdByUserId, kind: 'export.ready', title: 'Report cards ready', body: `${job.fileName} (${cards.length} students) is ready to download.`, link: '/exports' },
    ]);
    return 'sent';
  }
}
