import { Injectable } from '@nestjs/common';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { FileStorage } from '../../storage/file-storage';

/**
 * Everything a school has put in the system, as one JSON file: for leaving the platform, for
 * data-protection access requests, and as the school's own copy. Never included: passwords, sign-in
 * secrets, sessions or tokens. Uploaded files (documents, images) are listed but not embedded.
 */
@Injectable()
export class ExportSchoolDataHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorage,
    private readonly notifications: NotificationsService,
  ) {}

  async handle(schoolId: string, payload: { jobId: string }): Promise<'sent' | 'skipped'> {
    const job = await this.prisma.exportJob.findFirst({ where: { schoolId, id: payload.jobId }, select: { status: true, createdByUserId: true, fileName: true } });
    if (!job || job.status === 'READY') return 'skipped';
    await this.prisma.exportJob.update({ where: { id: payload.jobId }, data: { status: 'RUNNING', error: null } });
    const w = { where: { schoolId } };

    const data = {
      exportedAt: new Date().toISOString(),
      format: 'school-portal-export/v1',
      school: await this.prisma.school.findUniqueOrThrow({
        where: { id: schoolId },
        select: { name: true, slug: true, motto: true, addressLine: true, city: true, region: true, phone: true, contactEmail: true, timezone: true, currency: true, createdAt: true },
      }),
      academicYears: await this.prisma.academicYear.findMany({ ...w, select: { id: true, name: true, startDate: true, endDate: true, status: true, terms: { select: { id: true, name: true, startDate: true, endDate: true } } } }),
      levels: await this.prisma.educationLevel.findMany({ ...w, select: { id: true, name: true, stage: true } }),
      subjects: await this.prisma.subject.findMany({ ...w, select: { id: true, name: true, code: true } }),
      classes: await this.prisma.schoolClass.findMany({ ...w, select: { id: true, name: true, academicYearId: true, levelId: true, subjects: { select: { subjectId: true } } } }),
      staff: (
        await this.prisma.schoolMembership.findMany({
          where: { schoolId, kind: 'STAFF' },
          select: { id: true, status: true, user: { select: { email: true, fullName: true } }, staffProfile: { select: { staffNumber: true, jobTitle: true, phone: true } }, roles: { select: { role: { select: { name: true } } } } },
        })
      ).map((m) => ({ id: m.id, status: m.status, email: m.user.email, name: m.user.fullName, ...m.staffProfile, roles: m.roles.map((r) => r.role.name) })),
      students: await this.prisma.student.findMany({
        ...w,
        select: {
          id: true, admissionNumber: true, firstName: true, otherNames: true, lastName: true, dateOfBirth: true, sex: true, admissionDate: true,
          previousSchool: true, homeAddress: true, status: true, statusReason: true,
          enrollments: { select: { classId: true, academicYearId: true, status: true, startDate: true, endDate: true, endReason: true } },
          guardians: { select: { guardianId: true, relationship: true, isPrimaryContact: true } },
          documents: { select: { kind: true, originalName: true, contentType: true, sizeBytes: true, createdAt: true } },
        },
      }),
      guardians: await this.prisma.guardian.findMany({ ...w, select: { id: true, fullName: true, phone: true, email: true, occupation: true, address: true } }),
      attendance: (
        await this.prisma.attendanceRecord.findMany({ ...w, select: { studentId: true, status: true, note: true, session: { select: { date: true, classId: true } } } })
      ).map((r) => ({ studentId: r.studentId, classId: r.session.classId, date: r.session.date, status: r.status, note: r.note })),
      results: (
        await this.prisma.subjectResult.findMany({ ...w, select: { studentId: true, totalPercent: true, grade: true, remark: true, position: true, sheet: { select: { termId: true, classId: true, subjectId: true } } } })
      ).map((r) => ({ studentId: r.studentId, ...r.sheet, totalPercent: r.totalPercent.toNumber(), grade: r.grade, remark: r.remark, position: r.position })),
      invoices: await this.prisma.invoice.findMany({
        ...w,
        select: { id: true, number: true, studentId: true, termId: true, status: true, currency: true, totalMinor: true, paidMinor: true, dueDate: true, createdAt: true, items: { select: { description: true, amountMinor: true } }, adjustments: { select: { kind: true, amountMinor: true, reason: true, createdAt: true } } },
      }),
      payments: await this.prisma.payment.findMany({
        ...w,
        select: { id: true, studentId: true, amountMinor: true, currency: true, method: true, reference: true, receivedOn: true, payerName: true, status: true, reversalReason: true, receipt: { select: { number: true } }, allocations: { select: { invoiceId: true, amountMinor: true } } },
      }),
    };

    const body = Buffer.from(JSON.stringify(data, null, 2));
    const storageKey = `schools/${schoolId}/exports/${payload.jobId}`;
    await this.storage.delete(storageKey).catch(() => undefined);
    await this.storage.put(storageKey, body, 'application/json');
    await this.prisma.exportJob.update({ where: { id: payload.jobId }, data: { status: 'READY', storageKey, completedAt: new Date() } });
    await this.notifications.create([{ schoolId, userId: job.createdByUserId, kind: 'export.ready', title: 'School data export ready', body: `${job.fileName} is ready to download.`, link: '/exports' }]);
    return 'sent';
  }
}
