import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { badRequest, conflict, notFound } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Use 24-hour time, e.g. 08:30' });
export const PeriodsSchema = z.object({
  periods: z
    .array(z.object({ id: z.uuid().optional(), name: z.string().trim().min(1).max(40), startTime: time, endTime: time, isBreak: z.boolean().default(false) }))
    .min(1)
    .max(20)
    .refine((ps) => ps.every((p) => p.endTime > p.startTime), { message: 'Each period must end after it starts' })
    .refine((ps) => new Set(ps.map((p) => p.name.toLowerCase())).size === ps.length, { message: 'Each period needs a different name' }),
});
export const ClassTimetableSchema = z.object({
  entries: z
    .array(z.object({ dayOfWeek: z.number().int().min(1).max(5), periodId: z.uuid(), subjectId: z.uuid() }))
    .max(200)
    .refine((es) => new Set(es.map((e) => `${e.dayOfWeek}:${e.periodId}`)).size === es.length, { message: 'A class can only have one lesson per period' }),
});
export type PeriodsInput = z.infer<typeof PeriodsSchema>;
export type ClassTimetableInput = z.infer<typeof ClassTimetableSchema>;

const ENTRY = {
  dayOfWeek: true,
  periodId: true,
  subjectId: true,
  classId: true,
  classSubject: {
    select: {
      subject: { select: { name: true } },
      class: { select: { name: true } },
      teacher: { select: { membershipId: true, membership: { select: { user: { select: { fullName: true, email: true } } } } } },
    },
  },
} satisfies Prisma.TimetableEntrySelect;

type EntryRow = Prisma.TimetableEntryGetPayload<{ select: typeof ENTRY }>;
const entryDto = (e: EntryRow) => ({
  dayOfWeek: e.dayOfWeek,
  periodId: e.periodId,
  subjectId: e.subjectId,
  subjectName: e.classSubject.subject.name,
  classId: e.classId,
  className: e.classSubject.class.name,
  teacher: e.classSubject.teacher ? (e.classSubject.teacher.membership.user.fullName ?? e.classSubject.teacher.membership.user.email) : null,
});

@Injectable()
export class TimetableService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  periods(schoolId: string) {
    return this.prisma.timetablePeriod.findMany({
      where: { schoolId },
      orderBy: [{ sortOrder: 'asc' }, { startTime: 'asc' }],
      select: { id: true, name: true, startTime: true, endTime: true, isBreak: true },
    });
  }

  /** Replaces the school day's periods. Removing a period removes its lessons from every timetable. */
  async setPeriods(schoolId: string, input: PeriodsInput, actor: Actor) {
    const sorted = [...input.periods].sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.startTime < sorted[i - 1]!.endTime) throw badRequest('PERIODS_OVERLAP', `${sorted[i - 1]!.name} and ${sorted[i]!.name} overlap.`);
    }
    const existing = await this.periods(schoolId);
    const kept = new Set(input.periods.flatMap((p) => (p.id ? [p.id] : [])));
    if ([...kept].some((id) => !existing.some((e) => e.id === id))) throw notFound('Period not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.timetablePeriod.deleteMany({ where: { schoolId, id: { notIn: [...kept] } } });
      for (const p of input.periods.filter((x) => x.id)) {
        await tx.timetablePeriod.update({ where: { id: p.id }, data: { name: `__renaming__${p.id}` } });
      }
      for (const [i, p] of sorted.entries()) {
        const data = { name: p.name, startTime: p.startTime, endTime: p.endTime, isBreak: p.isBreak, sortOrder: i };
        if (p.id) await tx.timetablePeriod.update({ where: { id: p.id }, data });
        else await tx.timetablePeriod.create({ data: { schoolId, ...data } });
      }
      // Lessons can't sit in a break.
      await tx.timetableEntry.deleteMany({ where: { schoolId, period: { isBreak: true } } });
    });
    await this.audit.record({ action: 'timetable.periods_set', outcome: 'SUCCESS', resourceType: 'school', resourceId: schoolId, schoolId, actorUserId: actor.userId, summary: { periods: sorted.length }, correlationId: actor.correlationId });
    return { data: await this.periods(schoolId) };
  }

  async forClass(schoolId: string, classId: string, visible: Prisma.SchoolClassWhereInput = {}) {
    const cls = await this.prisma.schoolClass.findFirst({ where: { AND: [{ schoolId, id: classId }, visible] }, select: { id: true, name: true } });
    if (!cls) throw notFound('Class not found');
    const [periods, entries] = await Promise.all([
      this.periods(schoolId),
      this.prisma.timetableEntry.findMany({ where: { schoolId, classId }, select: ENTRY }),
    ]);
    return { data: { class: cls, periods, entries: entries.map(entryDto) } };
  }

  /**
   * Replaces a class's weekly timetable. Refuses lessons in breaks, subjects the class doesn't take,
   * and any lesson that would put a teacher in two classes at once.
   */
  async setForClass(schoolId: string, classId: string, input: ClassTimetableInput, actor: Actor) {
    const cls = await this.prisma.schoolClass.findUnique({
      where: { schoolId_id: { schoolId, id: classId } },
      select: { academicYearId: true, academicYear: { select: { status: true } }, subjects: { select: { subjectId: true, teacher: { select: { membershipId: true } } } } },
    });
    if (!cls) throw notFound('Class not found');
    if (cls.academicYear.status === 'CLOSED') throw conflict('YEAR_CLOSED', 'This class belongs to a closed academic year.');

    const periods = new Map((await this.periods(schoolId)).map((p) => [p.id, p]));
    const teacherOf = new Map(cls.subjects.map((s) => [s.subjectId, s.teacher?.membershipId ?? null]));
    for (const e of input.entries) {
      const p = periods.get(e.periodId);
      if (!p) throw notFound('Period not found');
      if (p.isBreak) throw badRequest('BREAK_PERIOD', `${p.name} is a break.`);
      if (!teacherOf.has(e.subjectId)) throw badRequest('SUBJECT_NOT_TAKEN', 'One of the subjects isn’t taken by this class. Add it on the Classes page first.');
    }

    const others = await this.prisma.timetableEntry.findMany({
      where: { schoolId, classId: { not: classId }, classSubject: { class: { academicYearId: cls.academicYearId }, teacher: { isNot: null } } },
      select: { ...ENTRY },
    });
    const busy = new Map(others.map((o) => [`${o.classSubject.teacher!.membershipId}:${o.dayOfWeek}:${o.periodId}`, o]));
    const clashes = input.entries.flatMap((e) => {
      const teacher = teacherOf.get(e.subjectId);
      const other = teacher ? busy.get(`${teacher}:${e.dayOfWeek}:${e.periodId}`) : undefined;
      return other ? [{ dayOfWeek: e.dayOfWeek, period: periods.get(e.periodId)!.name, teacher: entryDto(other).teacher, otherClass: other.classSubject.class.name }] : [];
    });
    if (clashes.length) {
      const c = clashes[0]!;
      throw conflict('TEACHER_CLASH', `${c.teacher} already teaches ${c.otherClass} at that time (${c.period}).`, { clashes });
    }

    await this.prisma.$transaction([
      this.prisma.timetableEntry.deleteMany({ where: { schoolId, classId } }),
      this.prisma.timetableEntry.createMany({ data: input.entries.map((e) => ({ schoolId, classId, ...e })) }),
    ]);
    await this.audit.record({ action: 'timetable.class_set', outcome: 'SUCCESS', resourceType: 'class', resourceId: classId, schoolId, actorUserId: actor.userId, summary: { lessons: input.entries.length }, correlationId: actor.correlationId });
    return this.forClass(schoolId, classId);
  }

  /** A teacher's own week across all their classes in the current year. */
  async forTeacher(schoolId: string, membershipId: string) {
    const [periods, entries] = await Promise.all([
      this.periods(schoolId),
      this.prisma.timetableEntry.findMany({
        where: { schoolId, classSubject: { teacher: { is: { membershipId } }, class: { academicYear: { status: 'ACTIVE' } } } },
        select: ENTRY,
      }),
    ]);
    return { data: { periods, entries: entries.map(entryDto) } };
  }
}
