import { Injectable } from '@nestjs/common';
import { notFound } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { positions, type MarkValue, type Snapshot } from './grading';

/** Report cards are built only from published results. */
@Injectable()
export class ReportCardsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Terms in which this student has published results, newest first. */
  async terms(schoolId: string, studentId: string) {
    const sheets = await this.prisma.resultSheet.findMany({
      where: { schoolId, status: 'PUBLISHED', results: { some: { studentId } } },
      select: { term: { select: { id: true, name: true, startDate: true, academicYear: { select: { name: true } } } } },
      distinct: ['termId'],
    });
    return {
      data: sheets
        .map((s) => s.term)
        .sort((a, b) => b.startDate.getTime() - a.startDate.getTime())
        .map((t) => ({ termId: t.id, termName: t.name, yearName: t.academicYear.name })),
    };
  }

  async card(schoolId: string, studentId: string, termId: string) {
    const [student, term, school] = await Promise.all([
      this.prisma.student.findUnique({ where: { schoolId_id: { schoolId, id: studentId } }, select: { id: true, firstName: true, lastName: true, otherNames: true, admissionNumber: true } }),
      this.prisma.term.findUnique({ where: { schoolId_id: { schoolId, id: termId } }, select: { id: true, name: true, startDate: true, endDate: true, academicYear: { select: { name: true } } } }),
      this.prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { name: true, motto: true, addressLine: true, city: true, phone: true } }),
    ]);
    if (!student || !term) throw notFound('Report card not found');

    const mine = await this.prisma.subjectResult.findMany({
      where: { schoolId, studentId, sheet: { termId, status: 'PUBLISHED' } },
      select: {
        totalPercent: true,
        grade: true,
        remark: true,
        position: true,
        sheet: {
          select: {
            id: true,
            classId: true,
            snapshot: true,
            publishedAt: true,
            classSubject: { select: { subject: { select: { name: true } }, class: { select: { name: true } } } },
            _count: { select: { results: true } },
            marks: { where: { studentId }, select: { assessmentId: true, score: true, absent: true } },
          },
        },
      },
      orderBy: { sheet: { classSubject: { subject: { name: 'asc' } } } },
    });
    if (mine.length === 0) throw notFound('No published results for this term');

    const classId = mine[0]!.sheet.classId;
    // Overall position: average across subjects, compared with classmates in the same class and term.
    const classResults = await this.prisma.subjectResult.findMany({
      where: { schoolId, sheet: { termId, classId, status: 'PUBLISHED' } },
      select: { studentId: true, totalPercent: true },
    });
    const sums = new Map<string, { total: number; n: number }>();
    for (const r of classResults) {
      const s = sums.get(r.studentId) ?? { total: 0, n: 0 };
      s.total += r.totalPercent.toNumber();
      s.n++;
      sums.set(r.studentId, s);
    }
    const averages = [...sums].map(([id, s]) => ({ id, total: Math.round((s.total / s.n) * 10) / 10 }));
    const overall = positions(averages);

    const attendance = await this.prisma.attendanceRecord.groupBy({
      by: ['status'],
      where: { schoolId, studentId, session: { termId } },
      _count: { _all: true },
    });
    const att = Object.fromEntries(attendance.map((a) => [a.status, a._count._all])) as Record<string, number>;

    return {
      data: {
        school,
        student,
        term: { id: term.id, name: term.name, yearName: term.academicYear.name },
        className: mine[0]!.sheet.classSubject.class.name,
        classSize: sums.size,
        subjects: mine.map((r) => {
          const snap = r.sheet.snapshot as unknown as Snapshot;
          const marks = new Map<string, MarkValue>(r.sheet.marks.map((m) => [m.assessmentId, { score: m.score?.toNumber() ?? null, absent: m.absent }]));
          return {
            subject: r.sheet.classSubject.subject.name,
            components: snap.components.map((c) => ({ name: c.name, maxMarks: c.maxMarks, weight: c.weight, score: marks.get(c.id)?.score ?? null, absent: marks.get(c.id)?.absent ?? false })),
            totalPercent: r.totalPercent.toNumber(),
            grade: r.grade,
            remark: r.remark,
            position: r.position,
            outOf: r.sheet._count.results,
          };
        }),
        average: averages.find((a) => a.id === studentId)?.total ?? null,
        overallPosition: overall.get(studentId) ?? null,
        attendance: {
          present: att.PRESENT ?? 0,
          late: att.LATE ?? 0,
          absent: att.ABSENT ?? 0,
          excused: att.EXCUSED ?? 0,
        },
        publishedAt: mine.reduce<Date | null>((latest, r) => (r.sheet.publishedAt && (!latest || r.sheet.publishedAt > latest) ? r.sheet.publishedAt : latest), null),
      },
    };
  }
}
