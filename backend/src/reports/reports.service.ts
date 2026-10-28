import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context';
import { Clock } from '../common/clock';
import { fromDbDate, toDbDate } from '../common/dates';
import { badRequest, notFound } from '../common/errors';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toCsv } from './csv';

const DAY = 86_400_000;
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : v === null || v === undefined ? 0 : Number(v));

/**
 * School reports. Every query is filtered by schoolId and aggregated in the database.
 * Each report also needs school-wide access to its area (not "own classes only"), checked here.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  requireArea(auth: AuthContext, permission: string, label: string) {
    if (auth.permissions.get(permission) !== 'SCHOOL') {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: `You need school-wide access to ${label} to see this report.` });
    }
  }

  /** Headline numbers for the dashboard. Each part only appears if the person may see that area. */
  async overview(schoolId: string, auth: AuthContext) {
    const can = (p: string) => auth.permissions.get(p) === 'SCHOOL';
    const today = toDbDate(this.clock.today('Africa/Accra'));
    const monthAgo = new Date(today.getTime() - 30 * DAY);
    const out: Record<string, unknown> = {};

    if (can('students.read')) {
      const bySex = await this.prisma.student.groupBy({ by: ['sex'], where: { schoolId, status: 'ACTIVE' }, _count: { _all: true } });
      out.students = { total: bySex.reduce((n, r) => n + r._count._all, 0), female: bySex.find((r) => r.sex === 'FEMALE')?._count._all ?? 0, male: bySex.find((r) => r.sex === 'MALE')?._count._all ?? 0 };
      out.staff = await this.prisma.schoolMembership.count({ where: { schoolId, kind: 'STAFF', status: 'ACTIVE' } });
    }
    if (can('attendance.read')) {
      const [row] = await this.prisma.$queryRaw<{ attended: bigint; recorded: bigint }[]>`
        SELECT COUNT(*) FILTER (WHERE r.status IN ('PRESENT','LATE')) AS attended, COUNT(*) AS recorded
        FROM attendance_records r JOIN attendance_sessions s ON s.id = r."sessionId"
        WHERE r."schoolId" = ${schoolId}::uuid AND s.date >= ${monthAgo} AND s.date <= ${today}`;
      out.attendanceLast30Days = pct(num(row?.attended), num(row?.recorded));
    }
    if (can('fees.read')) {
      const term = await this.currentTerm(schoolId);
      if (term) {
        const t = await this.prisma.invoice.aggregate({ where: { schoolId, termId: term.id, status: { not: 'VOID' } }, _sum: { totalMinor: true, paidMinor: true } });
        const billed = t._sum.totalMinor ?? 0;
        const paid = t._sum.paidMinor ?? 0;
        out.fees = { term: term.name, billedMinor: billed, collectedMinor: paid, outstandingMinor: billed - paid, collectionRate: pct(paid, billed) };
      }
    }
    return { data: out };
  }

  /** Students by level and class (with a sex split), and admissions and leavers by month. */
  async enrollment(schoolId: string) {
    const year = await this.prisma.academicYear.findFirst({ where: { schoolId, status: 'ACTIVE' }, select: { id: true, name: true } });
    const byClass = year
      ? await this.prisma.$queryRaw<{ level: string; class: string; female: bigint; male: bigint; unrecorded: bigint; total: bigint }[]>`
          SELECT l.name AS level, c.name AS class,
                 COUNT(*) FILTER (WHERE s.sex = 'FEMALE') AS female,
                 COUNT(*) FILTER (WHERE s.sex = 'MALE') AS male,
                 COUNT(*) FILTER (WHERE s.sex IS NULL) AS unrecorded,
                 COUNT(*) AS total
          FROM enrollments e
          JOIN classes c ON c.id = e."classId"
          JOIN education_levels l ON l.id = c."levelId"
          JOIN students s ON s.id = e."studentId"
          WHERE e."schoolId" = ${schoolId}::uuid AND e."academicYearId" = ${year.id}::uuid AND e.status = 'ACTIVE'
          GROUP BY l."sortOrder", l.name, c.name
          ORDER BY l."sortOrder", c.name`
      : [];
    const since = new Date(this.clock.now().getTime() - 365 * DAY);
    const flow = await this.prisma.$queryRaw<{ month: string; admitted: bigint; leavers: bigint }[]>`
      SELECT to_char(m, 'YYYY-MM') AS month,
             (SELECT COUNT(*) FROM students WHERE "schoolId" = ${schoolId}::uuid AND date_trunc('month', "admissionDate") = m) AS admitted,
             (SELECT COUNT(*) FROM students WHERE "schoolId" = ${schoolId}::uuid AND status IN ('WITHDRAWN','GRADUATED') AND date_trunc('month', "statusChangedAt") = m) AS leavers
      FROM generate_series(date_trunc('month', ${since}::timestamptz), date_trunc('month', now()), interval '1 month') AS m
      ORDER BY m`;
    return {
      data: {
        year: year?.name ?? null,
        byClass: byClass.map((r) => ({ level: r.level, class: r.class, female: num(r.female), male: num(r.male), unrecorded: num(r.unrecorded), total: num(r.total) })),
        byMonth: flow.map((r) => ({ month: r.month, admitted: num(r.admitted), left: num(r.leavers) })),
      },
    };
  }

  /** Daily attendance rate, rate by class, and students below a threshold (chronic absence). */
  async attendance(schoolId: string, from?: string, to?: string, threshold = 90) {
    const range = this.range(from, to);
    const [daily, byClass, low] = await Promise.all([
      this.prisma.$queryRaw<{ date: Date; attended: bigint; recorded: bigint }[]>`
        SELECT s.date, COUNT(*) FILTER (WHERE r.status IN ('PRESENT','LATE')) AS attended, COUNT(*) AS recorded
        FROM attendance_records r JOIN attendance_sessions s ON s.id = r."sessionId"
        WHERE r."schoolId" = ${schoolId}::uuid AND s.date BETWEEN ${range.from} AND ${range.to}
        GROUP BY s.date ORDER BY s.date`,
      this.prisma.$queryRaw<{ class: string; attended: bigint; recorded: bigint }[]>`
        SELECT c.name AS class, COUNT(*) FILTER (WHERE r.status IN ('PRESENT','LATE')) AS attended, COUNT(*) AS recorded
        FROM attendance_records r JOIN attendance_sessions s ON s.id = r."sessionId" JOIN classes c ON c.id = s."classId"
        WHERE r."schoolId" = ${schoolId}::uuid AND s.date BETWEEN ${range.from} AND ${range.to}
        GROUP BY c.name ORDER BY c.name`,
      this.prisma.$queryRaw<{ id: string; name: string; admission: string; attended: bigint; absent: bigint; recorded: bigint }[]>`
        SELECT st.id, st."firstName" || ' ' || st."lastName" AS name, st."admissionNumber" AS admission,
               COUNT(*) FILTER (WHERE r.status IN ('PRESENT','LATE')) AS attended,
               COUNT(*) FILTER (WHERE r.status = 'ABSENT') AS absent,
               COUNT(*) AS recorded
        FROM attendance_records r JOIN attendance_sessions s ON s.id = r."sessionId" JOIN students st ON st.id = r."studentId"
        WHERE r."schoolId" = ${schoolId}::uuid AND s.date BETWEEN ${range.from} AND ${range.to} AND st.status = 'ACTIVE'
        GROUP BY st.id
        HAVING COUNT(*) >= 5 AND COUNT(*) FILTER (WHERE r.status IN ('PRESENT','LATE')) * 100.0 / COUNT(*) < ${threshold}
        ORDER BY COUNT(*) FILTER (WHERE r.status IN ('PRESENT','LATE')) * 1.0 / COUNT(*) ASC
        LIMIT 100`,
    ]);
    return {
      data: {
        from: fromDbDate(range.from),
        to: fromDbDate(range.to),
        threshold,
        daily: daily.map((d) => ({ date: fromDbDate(d.date), rate: pct(num(d.attended), num(d.recorded)), recorded: num(d.recorded) })),
        byClass: byClass.map((c) => ({ class: c.class, rate: pct(num(c.attended), num(c.recorded)), recorded: num(c.recorded) })),
        belowThreshold: low.map((s) => ({ studentId: s.id, name: s.name, admissionNumber: s.admission, rate: pct(num(s.attended), num(s.recorded)), absent: num(s.absent), recorded: num(s.recorded) })),
      },
    };
  }

  /** Published results: average by class and subject, grade spread, and the strongest students. */
  async academic(schoolId: string, termId: string) {
    const term = await this.prisma.term.findUnique({ where: { schoolId_id: { schoolId, id: termId } }, select: { name: true } });
    if (!term) throw notFound('Term not found');
    const [bySubject, grades, top] = await Promise.all([
      this.prisma.$queryRaw<{ class: string; subject: string; average: Prisma.Decimal; students: bigint }[]>`
        SELECT c.name AS class, sub.name AS subject, ROUND(AVG(r."totalPercent"), 1) AS average, COUNT(*) AS students
        FROM subject_results r JOIN result_sheets sh ON sh.id = r."sheetId"
        JOIN classes c ON c.id = sh."classId" JOIN subjects sub ON sub.id = sh."subjectId"
        WHERE r."schoolId" = ${schoolId}::uuid AND sh."termId" = ${termId}::uuid AND sh.status = 'PUBLISHED'
        GROUP BY c.name, sub.name ORDER BY c.name, sub.name`,
      this.prisma.$queryRaw<{ grade: string; students: bigint }[]>`
        SELECT r.grade, COUNT(*) AS students
        FROM subject_results r JOIN result_sheets sh ON sh.id = r."sheetId"
        WHERE r."schoolId" = ${schoolId}::uuid AND sh."termId" = ${termId}::uuid AND sh.status = 'PUBLISHED'
        GROUP BY r.grade ORDER BY r.grade`,
      this.prisma.$queryRaw<{ id: string; name: string; class: string; average: Prisma.Decimal }[]>`
        SELECT st.id, st."firstName" || ' ' || st."lastName" AS name, c.name AS class, ROUND(AVG(r."totalPercent"), 1) AS average
        FROM subject_results r JOIN result_sheets sh ON sh.id = r."sheetId"
        JOIN students st ON st.id = r."studentId" JOIN classes c ON c.id = sh."classId"
        WHERE r."schoolId" = ${schoolId}::uuid AND sh."termId" = ${termId}::uuid AND sh.status = 'PUBLISHED'
        GROUP BY st.id, c.name ORDER BY AVG(r."totalPercent") DESC LIMIT 10`,
    ]);
    return {
      data: {
        term: term.name,
        bySubject: bySubject.map((r) => ({ class: r.class, subject: r.subject, average: Number(r.average), students: num(r.students) })),
        grades: grades.map((g) => ({ grade: g.grade, students: num(g.students) })),
        top: top.map((t) => ({ studentId: t.id, name: t.name, class: t.class, average: Number(t.average) })),
      },
    };
  }

  /** Collections week by week and what's owed by class, for one term. */
  async finance(schoolId: string, termId: string) {
    const term = await this.prisma.term.findUnique({ where: { schoolId_id: { schoolId, id: termId } }, select: { name: true } });
    if (!term) throw notFound('Term not found');
    const [weekly, byClass] = await Promise.all([
      this.prisma.$queryRaw<{ week: Date; amount: bigint }[]>`
        SELECT date_trunc('week', p."receivedOn")::date AS week, SUM(a."amountMinor") AS amount
        FROM payment_allocations a JOIN payments p ON p.id = a."paymentId" JOIN invoices i ON i.id = a."invoiceId"
        WHERE a."schoolId" = ${schoolId}::uuid AND i."termId" = ${termId}::uuid AND p.status = 'RECORDED'
        GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<{ class: string | null; billed: bigint; paid: bigint }[]>`
        SELECT c.name AS class, SUM(i."totalMinor") AS billed, SUM(i."paidMinor") AS paid
        FROM invoices i
        LEFT JOIN enrollments e ON e."studentId" = i."studentId" AND e.status = 'ACTIVE'
        LEFT JOIN classes c ON c.id = e."classId"
        WHERE i."schoolId" = ${schoolId}::uuid AND i."termId" = ${termId}::uuid AND i.status <> 'VOID'
        GROUP BY c.name ORDER BY c.name NULLS LAST`,
    ]);
    return {
      data: {
        term: term.name,
        weekly: weekly.map((w) => ({ week: fromDbDate(w.week), collectedMinor: num(w.amount) })),
        byClass: byClass.map((c) => ({ class: c.class ?? 'Not in a class', billedMinor: num(c.billed), collectedMinor: num(c.paid), outstandingMinor: num(c.billed) - num(c.paid), collectionRate: pct(num(c.paid), num(c.billed)) })),
      },
    };
  }

  /** CSV downloads, one row per student. */
  async csv(schoolId: string, kind: 'students' | 'attendance' | 'results' | 'balances', opts: { termId?: string; from?: string; to?: string }) {
    if (kind === 'students') {
      const rows = await this.prisma.student.findMany({
        where: { schoolId },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        select: { admissionNumber: true, firstName: true, otherNames: true, lastName: true, sex: true, dateOfBirth: true, status: true, admissionDate: true, enrollments: { where: { status: 'ACTIVE' }, take: 1, select: { class: { select: { name: true } } } } },
      });
      return toCsv(
        ['Admission number', 'First name', 'Other names', 'Last name', 'Sex', 'Date of birth', 'Class', 'Status', 'Admitted'],
        rows.map((r) => [r.admissionNumber, r.firstName, r.otherNames, r.lastName, r.sex, r.dateOfBirth ? fromDbDate(r.dateOfBirth) : null, r.enrollments[0]?.class.name ?? null, r.status, fromDbDate(r.admissionDate)]),
      );
    }
    if (kind === 'attendance') {
      const range = this.range(opts.from, opts.to);
      const rows = await this.prisma.$queryRaw<{ admission: string; name: string; present: bigint; late: bigint; absent: bigint; excused: bigint }[]>`
        SELECT st."admissionNumber" AS admission, st."firstName" || ' ' || st."lastName" AS name,
               COUNT(*) FILTER (WHERE r.status = 'PRESENT') AS present, COUNT(*) FILTER (WHERE r.status = 'LATE') AS late,
               COUNT(*) FILTER (WHERE r.status = 'ABSENT') AS absent, COUNT(*) FILTER (WHERE r.status = 'EXCUSED') AS excused
        FROM attendance_records r JOIN attendance_sessions s ON s.id = r."sessionId" JOIN students st ON st.id = r."studentId"
        WHERE r."schoolId" = ${schoolId}::uuid AND s.date BETWEEN ${range.from} AND ${range.to}
        GROUP BY st.id ORDER BY st."lastName", st."firstName"`;
      return toCsv(['Admission number', 'Name', 'Present', 'Late', 'Absent', 'Excused', 'Attendance %'], rows.map((r) => {
        const total = num(r.present) + num(r.late) + num(r.absent) + num(r.excused);
        return [r.admission, r.name, num(r.present), num(r.late), num(r.absent), num(r.excused), pct(num(r.present) + num(r.late), total)];
      }));
    }
    if (!opts.termId) throw badRequest('TERM_REQUIRED', 'Choose a term.');
    if (kind === 'results') {
      const rows = await this.prisma.$queryRaw<{ admission: string; name: string; class: string; subject: string; total: Prisma.Decimal; grade: string; position: number }[]>`
        SELECT st."admissionNumber" AS admission, st."firstName" || ' ' || st."lastName" AS name, c.name AS class, sub.name AS subject,
               r."totalPercent" AS total, r.grade, r.position
        FROM subject_results r JOIN result_sheets sh ON sh.id = r."sheetId" JOIN students st ON st.id = r."studentId"
        JOIN classes c ON c.id = sh."classId" JOIN subjects sub ON sub.id = sh."subjectId"
        WHERE r."schoolId" = ${schoolId}::uuid AND sh."termId" = ${opts.termId}::uuid AND sh.status = 'PUBLISHED'
        ORDER BY c.name, st."lastName", st."firstName", sub.name`;
      return toCsv(['Admission number', 'Name', 'Class', 'Subject', 'Total %', 'Grade', 'Position'], rows.map((r) => [r.admission, r.name, r.class, r.subject, Number(r.total), r.grade, r.position]));
    }
    const rows = await this.prisma.$queryRaw<{ admission: string; name: string; billed: bigint; paid: bigint }[]>`
      SELECT st."admissionNumber" AS admission, st."firstName" || ' ' || st."lastName" AS name, SUM(i."totalMinor") AS billed, SUM(i."paidMinor") AS paid
      FROM invoices i JOIN students st ON st.id = i."studentId"
      WHERE i."schoolId" = ${schoolId}::uuid AND i."termId" = ${opts.termId}::uuid AND i.status <> 'VOID'
      GROUP BY st.id ORDER BY st."lastName", st."firstName"`;
    return toCsv(['Admission number', 'Name', 'Billed', 'Paid', 'Balance'], rows.map((r) => [r.admission, r.name, (num(r.billed) / 100).toFixed(2), (num(r.paid) / 100).toFixed(2), ((num(r.billed) - num(r.paid)) / 100).toFixed(2)]));
  }

  private range(from?: string, to?: string) {
    const end = toDbDate(to ?? this.clock.today('Africa/Accra'));
    const start = from ? toDbDate(from) : new Date(end.getTime() - 30 * DAY);
    if (start > end) throw badRequest('INVALID_DATES', 'The start date must be before the end date.');
    if (end.getTime() - start.getTime() > 400 * DAY) throw badRequest('RANGE_TOO_LONG', 'Choose a period of about a year or less.');
    return { from: start, to: end };
  }

  private currentTerm(schoolId: string) {
    const today = toDbDate(this.clock.today('Africa/Accra'));
    return this.prisma.term.findFirst({
      where: { schoolId, academicYear: { status: 'ACTIVE' }, startDate: { lte: today } },
      orderBy: { startDate: 'desc' },
      select: { id: true, name: true },
    });
  }
}
