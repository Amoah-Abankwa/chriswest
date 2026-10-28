import { ForbiddenException, Injectable } from '@nestjs/common';
import { ScopeService } from '../access/scope.service';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { Clock } from '../common/clock';
import { fromDbDate, toDbDate } from '../common/dates';
import { badRequest, conflict, notFound } from '../common/errors';
import type { AttendanceStatus, Prisma } from '../generated/prisma/client';
import { enqueue } from '../outbox/outbox';
import { PrismaService } from '../prisma/prisma.service';
import { auditHistory } from '../staff/audit-history';
import type { SchoolContext } from '../tenancy/host-context';
import type { SaveRegisterInput } from './attendance.schemas';

const SLOT = 'DAY';
const DAY_MS = 86_400_000;
/** Wait before emailing parents, so a teacher can fix a slip without a false alarm. */
export const ABSENCE_NOTICE_DELAY_MS = 10 * 60_000;

type Mode = 'RECORD' | 'CORRECT' | 'READ_ONLY';
type Decision = { mode: Mode; code?: string; message?: string };

const daysBetween = (from: string, to: string) => Math.round((toDbDate(to).getTime() - toDbDate(from).getTime()) / DAY_MS);

/** Students in a class on a date. Someone who moved class that day counts in the new class only. */
export const rosterWhere = (schoolId: string, classId: string | { in: string[] }, date: Date): Prisma.EnrollmentWhereInput => ({
  schoolId,
  classId,
  startDate: { lte: date },
  OR: [{ endDate: null }, { endDate: { gt: date } }, { endDate: date, status: { not: 'TRANSFERRED' } }],
});

const errorFor = (d: Decision) => {
  switch (d.code) {
    case 'FUTURE_DATE':
      return badRequest(d.code, d.message!);
    case 'NO_PERMISSION':
      return new ForbiddenException({ code: 'FORBIDDEN', message: d.message });
    default:
      return conflict(d.code ?? 'READ_ONLY', d.message ?? 'This register can’t be changed.');
  }
};

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Classes the caller can see for a date, with whether the register has been taken. */
  async classesForDate(school: SchoolContext, auth: AuthContext, dateStr?: string) {
    const date = dateStr ?? this.clock.today(school.timezone);
    const d = toDbDate(date);
    const year = await this.prisma.academicYear.findFirst({ where: { schoolId: school.schoolId, status: 'ACTIVE' }, select: { id: true } });
    if (!year) return { data: [], meta: { date } };

    const classes = await this.prisma.schoolClass.findMany({
      where: { schoolId: school.schoolId, academicYearId: year.id, ...this.scope.classFilter(auth, 'attendance.read') },
      select: { id: true, name: true, attendance: { where: { date: d, slot: SLOT }, select: { _count: { select: { records: true } } } } },
      orderBy: [{ level: { sortOrder: 'asc' } }, { name: 'asc' }],
    });
    const ids = classes.map((c) => c.id);
    const [rosters, recordable] = await Promise.all([
      this.prisma.enrollment.groupBy({
        by: ['classId'],
        where: rosterWhere(school.schoolId, { in: ids }, d),
        _count: { _all: true },
      }),
      this.prisma.schoolClass.findMany({
        where: { id: { in: ids }, ...this.scope.classFilter(auth, 'attendance.record') },
        select: { id: true },
      }),
    ]);
    const size = new Map(rosters.map((r) => [r.classId, r._count._all]));
    const canRecord = new Set(recordable.map((c) => c.id));
    return {
      data: classes.map((c) => ({
        id: c.id,
        name: c.name,
        students: size.get(c.id) ?? 0,
        recorded: c.attendance[0]?._count.records ?? null,
        canRecord: canRecord.has(c.id),
      })),
      meta: { date },
    };
  }

  async register(school: SchoolContext, auth: AuthContext, classId: string, dateStr?: string) {
    const date = dateStr ?? this.clock.today(school.timezone);
    const cls = await this.visibleClass(school.schoolId, classId, this.scope.classFilter(auth, 'attendance.read'));
    const ctx = await this.context(school, auth, cls, date);
    const roster = await this.roster(school.schoolId, classId, toDbDate(date));

    const session = await this.prisma.attendanceSession.findUnique({
      where: { classId_date_slot: { classId, date: toDbDate(date), slot: SLOT } },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        recordedByUserId: true,
        records: { select: { studentId: true, status: true, note: true } },
        corrections: {
          orderBy: { createdAt: 'desc' },
          select: { studentId: true, fromStatus: true, toStatus: true, reason: true, correctedByUserId: true, createdAt: true },
        },
      },
    });
    const decision = this.decide(ctx, Boolean(session));
    const records = new Map(session?.records.map((r) => [r.studentId, r]) ?? []);
    const names = await this.userNames([
      ...(session ? [session.recordedByUserId] : []),
      ...(session?.corrections.map((c) => c.correctedByUserId) ?? []),
    ]);
    const studentName = new Map(roster.map((s) => [s.id, `${s.firstName} ${s.lastName}`]));

    return {
      data: {
        class: { id: cls.id, name: cls.name },
        date,
        today: ctx.today,
        term: ctx.term ? { id: ctx.term.id, name: ctx.term.name } : null,
        mode: decision.mode,
        readOnlyReason: decision.mode === 'READ_ONLY' ? decision.message : null,
        reasonRequired: decision.mode === 'CORRECT',
        correctionDays: ctx.windowDays,
        session: session
          ? { id: session.id, recordedBy: names.get(session.recordedByUserId) ?? 'Unknown', recordedAt: session.createdAt, updatedAt: session.updatedAt }
          : null,
        students: roster.map((s) => ({
          studentId: s.id,
          firstName: s.firstName,
          lastName: s.lastName,
          otherNames: s.otherNames,
          admissionNumber: s.admissionNumber,
          status: records.get(s.id)?.status ?? null,
          note: records.get(s.id)?.note ?? null,
        })),
        corrections: (session?.corrections ?? []).map((c) => ({
          student: studentName.get(c.studentId) ?? 'Former student',
          from: c.fromStatus,
          to: c.toStatus,
          reason: c.reason,
          by: names.get(c.correctedByUserId) ?? 'Unknown',
          at: c.createdAt,
        })),
      },
    };
  }

  async save(school: SchoolContext, auth: AuthContext, input: SaveRegisterInput, correlationId?: string) {
    const { schoolId } = school;
    const cls = await this.visibleClass(schoolId, input.classId, {
      OR: [this.scope.classFilter(auth, 'attendance.record'), this.scope.classFilter(auth, 'attendance.correct')],
    });
    const ctx = await this.context(school, auth, cls, input.date);
    const d = toDbDate(input.date);
    const existing = await this.prisma.attendanceSession.findUnique({
      where: { classId_date_slot: { classId: cls.id, date: d, slot: SLOT } },
      select: { id: true },
    });
    const decision = this.decide(ctx, Boolean(existing));
    if (decision.mode === 'READ_ONLY') throw errorFor(decision);

    if (decision.mode === 'CORRECT' && !input.reason) {
      throw badRequest('REASON_REQUIRED', 'Give a reason for changing a register after its day.');
    }
    const roster = new Set((await this.roster(schoolId, cls.id, d)).map((s) => s.id));
    const outsiders = input.records.filter((r) => !roster.has(r.studentId)).map((r) => r.studentId);
    if (outsiders.length > 0) {
      throw badRequest('NOT_IN_CLASS', 'Some students are not in this class on this date. Reload the register.');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const session = await tx.attendanceSession.upsert({
        where: { classId_date_slot: { classId: cls.id, date: d, slot: SLOT } },
        create: {
          schoolId,
          classId: cls.id,
          academicYearId: cls.academicYearId,
          termId: ctx.term!.id,
          date: d,
          slot: SLOT,
          recordedByUserId: auth.userId,
        },
        update: {},
        select: { id: true },
      });
      const before = new Map(
        (await tx.attendanceRecord.findMany({ where: { sessionId: session.id }, select: { studentId: true, status: true, note: true } })).map(
          (r) => [r.studentId, r],
        ),
      );

      const corrections: Prisma.AttendanceCorrectionCreateManyInput[] = [];
      const absentNow: string[] = [];
      let changed = 0;
      for (const r of input.records) {
        const prev = before.get(r.studentId);
        const note = r.note ?? null;
        if (prev && prev.status === r.status && (prev.note ?? null) === note) continue;
        changed++;
        if (decision.mode === 'CORRECT' && prev && prev.status !== r.status) {
          corrections.push({
            schoolId,
            sessionId: session.id,
            studentId: r.studentId,
            fromStatus: prev.status,
            toStatus: r.status,
            reason: input.reason!,
            correctedByUserId: auth.userId,
          });
        }
        if (r.status === 'ABSENT' && prev?.status !== 'ABSENT') absentNow.push(r.studentId);
        await tx.attendanceRecord.upsert({
          where: { sessionId_studentId: { sessionId: session.id, studentId: r.studentId } },
          create: { schoolId, sessionId: session.id, studentId: r.studentId, status: r.status, note, recordedByUserId: auth.userId },
          update: { status: r.status, note, recordedByUserId: auth.userId },
        });
      }

      if (corrections.length > 0) await tx.attendanceCorrection.createMany({ data: corrections });

      // Only same-day absences trigger a parent email; late backfills and corrections don't.
      if (input.date === ctx.today && ctx.notifyAbsence && absentNow.length > 0) {
        await enqueue(
          tx,
          absentNow.map((studentId) => ({
            schoolId,
            type: 'attendance.absent',
            payload: { sessionId: session.id, studentId },
            dedupeKey: `attendance.absent:${session.id}:${studentId}`,
            delayMs: ABSENCE_NOTICE_DELAY_MS,
          })),
        );
      }
      if (changed > 0) await tx.attendanceSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
      return { sessionId: session.id, changed, corrected: corrections.length };
    });

    if (result.changed > 0) {
      await this.audit.record({
        action: decision.mode === 'CORRECT' ? 'attendance.correct' : 'attendance.record',
        outcome: 'SUCCESS',
        resourceType: 'attendance_session',
        resourceId: result.sessionId,
        schoolId,
        actorUserId: auth.userId,
        summary: {
          classId: cls.id,
          date: input.date,
          changed: result.changed,
          ...(decision.mode === 'CORRECT' ? { corrected: result.corrected, reason: input.reason! } : {}),
        },
        correlationId,
      });
    }
    return this.register(school, auth, cls.id, input.date);
  }

  /** Per-student totals for a class over a date range. */
  async summary(school: SchoolContext, auth: AuthContext, classId: string, fromStr?: string, toStr?: string) {
    const cls = await this.visibleClass(school.schoolId, classId, this.scope.classFilter(auth, 'attendance.read'));
    const { from, to } = await this.range(school, fromStr, toStr);
    const where = { schoolId: school.schoolId, classId, date: { gte: toDbDate(from), lte: toDbDate(to) } };

    const [registers, grouped, roster] = await Promise.all([
      this.prisma.attendanceSession.count({ where }),
      this.prisma.attendanceRecord.groupBy({
        by: ['studentId', 'status'],
        where: { schoolId: school.schoolId, session: where },
        _count: { _all: true },
      }),
      this.roster(school.schoolId, classId, toDbDate(to)),
    ]);

    const ids = [...new Set([...roster.map((s) => s.id), ...grouped.map((g) => g.studentId)])];
    const students = await this.prisma.student.findMany({
      where: { schoolId: school.schoolId, id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, admissionNumber: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    const counts = new Map<string, Record<AttendanceStatus, number>>();
    for (const g of grouped) {
      const c = counts.get(g.studentId) ?? { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 };
      c[g.status] = g._count._all;
      counts.set(g.studentId, c);
    }
    const onRoll = new Set(roster.map((s) => s.id));

    return {
      data: {
        class: { id: cls.id, name: cls.name },
        from,
        to,
        registers,
        students: students.map((s) => {
          const c = counts.get(s.id) ?? { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 };
          const recorded = c.PRESENT + c.ABSENT + c.LATE + c.EXCUSED;
          return {
            studentId: s.id,
            name: `${s.firstName} ${s.lastName}`,
            admissionNumber: s.admissionNumber,
            stillInClass: onRoll.has(s.id),
            present: c.PRESENT,
            absent: c.ABSENT,
            late: c.LATE,
            excused: c.EXCUSED,
            recorded,
            // Present or late, out of days recorded. Excused days count as recorded but not attended.
            rate: recorded ? Math.round(((c.PRESENT + c.LATE) / recorded) * 1000) / 10 : null,
          };
        }),
      },
    };
  }

  /** One student's attendance. Callers check access to the student first. */
  async forStudent(school: SchoolContext, studentId: string, fromStr?: string, toStr?: string) {
    const { from, to } = await this.range(school, fromStr, toStr);
    const records = await this.prisma.attendanceRecord.findMany({
      where: { schoolId: school.schoolId, studentId, session: { date: { gte: toDbDate(from), lte: toDbDate(to) } } },
      select: { status: true, note: true, session: { select: { date: true, class: { select: { name: true } } } } },
      orderBy: { session: { date: 'desc' } },
    });
    const totals = { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 } as Record<AttendanceStatus, number>;
    for (const r of records) totals[r.status]++;
    const recorded = records.length;
    return {
      data: {
        from,
        to,
        totals: { present: totals.PRESENT, absent: totals.ABSENT, late: totals.LATE, excused: totals.EXCUSED, recorded },
        rate: recorded ? Math.round(((totals.PRESENT + totals.LATE) / recorded) * 1000) / 10 : null,
        records: records.map((r) => ({ date: fromDbDate(r.session.date), className: r.session.class.name, status: r.status, note: r.note })),
      },
    };
  }

  async sessionHistory(schoolId: string, sessionId: string) {
    return auditHistory(this.prisma, schoolId, 'attendance_session', sessionId);
  }

  // ---------- helpers ----------

  private async visibleClass(schoolId: string, classId: string, filter: Prisma.SchoolClassWhereInput) {
    const cls = await this.prisma.schoolClass.findFirst({
      where: { AND: [{ schoolId, id: classId }, filter] },
      select: { id: true, name: true, academicYearId: true, academicYear: { select: { status: true } } },
    });
    if (!cls) throw notFound('Class not found');
    return cls;
  }

  private async context(
    school: SchoolContext,
    auth: AuthContext,
    cls: { id: string; academicYearId: string; academicYear: { status: string } },
    date: string,
  ) {
    const d = toDbDate(date);
    const [term, settings, canRecord, canCorrect] = await Promise.all([
      this.prisma.term.findFirst({
        where: { schoolId: school.schoolId, academicYearId: cls.academicYearId, startDate: { lte: d }, endDate: { gte: d } },
        select: { id: true, name: true },
      }),
      this.prisma.school.findUniqueOrThrow({ where: { id: school.schoolId }, select: { attendanceCorrectionDays: true, notifyAbsence: true } }),
      this.canAct(auth, cls.id, 'attendance.record'),
      this.canAct(auth, cls.id, 'attendance.correct'),
    ]);
    return {
      date,
      today: this.clock.today(school.timezone),
      term,
      yearActive: cls.academicYear.status === 'ACTIVE',
      windowDays: settings.attendanceCorrectionDays,
      notifyAbsence: settings.notifyAbsence,
      canRecord,
      canCorrect,
    };
  }

  /**
   * The correction policy in one place:
   * - today: record or change freely (with attendance.record);
   * - an earlier day never recorded: may be filled in late, within the window;
   * - an earlier day already recorded: a correction, needing attendance.correct and a reason, within the window;
   * - future dates, dates outside a term, and years that aren't current are read-only.
   */
  private decide(ctx: Awaited<ReturnType<AttendanceService['context']>>, sessionExists: boolean): Decision {
    if (!ctx.yearActive) return { mode: 'READ_ONLY', code: 'YEAR_NOT_CURRENT', message: 'This class belongs to an academic year that isn’t current.' };
    if (!ctx.term) return { mode: 'READ_ONLY', code: 'NOT_A_SCHOOL_DAY', message: 'This date isn’t inside a term.' };
    const ago = daysBetween(ctx.date, ctx.today);
    if (ago < 0) return { mode: 'READ_ONLY', code: 'FUTURE_DATE', message: 'Attendance can’t be taken for a future date.' };
    if (ago === 0) {
      return ctx.canRecord ? { mode: 'RECORD' } : { mode: 'READ_ONLY', code: 'NO_PERMISSION', message: 'You can view but not take this register.' };
    }
    if (ago > ctx.windowDays) {
      return {
        mode: 'READ_ONLY',
        code: 'CORRECTION_WINDOW_CLOSED',
        message: `Registers can only be changed within ${ctx.windowDays} days. Ask an administrator if this needs fixing.`,
      };
    }
    if (!sessionExists) {
      return ctx.canRecord ? { mode: 'RECORD' } : { mode: 'READ_ONLY', code: 'NO_PERMISSION', message: 'You can view but not take this register.' };
    }
    return ctx.canCorrect
      ? { mode: 'CORRECT' }
      : { mode: 'READ_ONLY', code: 'NO_PERMISSION', message: 'You can view this register but not correct it.' };
  }

  private async canAct(auth: AuthContext, classId: string, permission: 'attendance.record' | 'attendance.correct') {
    if (!auth.permissions.has(permission)) return false;
    return (await this.prisma.schoolClass.count({ where: { id: classId, ...this.scope.classFilter(auth, permission) } })) > 0;
  }

  private async roster(schoolId: string, classId: string, date: Date) {
    const rows = await this.prisma.enrollment.findMany({
      where: rosterWhere(schoolId, classId, date),
      select: { student: { select: { id: true, firstName: true, lastName: true, otherNames: true, admissionNumber: true } } },
      orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
    });
    const seen = new Map(rows.map((r) => [r.student.id, r.student]));
    return [...seen.values()];
  }

  /** Defaults to the current term so far (or the last 30 days if there's no current term). */
  private async range(school: SchoolContext, from?: string, to?: string) {
    const today = this.clock.today(school.timezone);
    const end = to ?? today;
    let start = from;
    if (!start) {
      const term = await this.prisma.term.findFirst({
        where: { schoolId: school.schoolId, academicYear: { status: 'ACTIVE' }, startDate: { lte: toDbDate(end) }, endDate: { gte: toDbDate(end) } },
        select: { startDate: true },
      });
      start = term ? fromDbDate(term.startDate) : fromDbDate(new Date(toDbDate(end).getTime() - 30 * DAY_MS));
    }
    if (daysBetween(start, end) < 0) throw badRequest('INVALID_DATES', 'The start date must be before the end date.');
    if (daysBetween(start, end) > 366) throw badRequest('RANGE_TOO_LONG', 'Choose a period of a year or less.');
    return { from: start, to: end };
  }

  private async userNames(ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map<string, string>();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true, email: true } });
    return new Map(users.map((u) => [u.id, u.fullName ?? u.email]));
  }
}
