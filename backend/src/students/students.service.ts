import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { fromDbDate, toDbDate } from '../common/dates';
import { todayIn } from '../common/dates-tz';
import { badRequest, conflict, isUniqueViolation, notFound } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { auditHistory } from '../staff/audit-history';
import type { SchoolContext } from '../tenancy/host-context';
import type {
  AdmitStudentInput,
  EnrollInput,
  ListStudentsInput,
  TransferInput,
  UpdateStudentInput,
  WithdrawInput,
} from './students.schemas';

const CURRENT_CLASS = {
  where: { status: 'ACTIVE' },
  select: { id: true, class: { select: { id: true, name: true, academicYear: { select: { name: true } } } } },
  take: 1,
} as const;

const SUMMARY = {
  id: true,
  admissionNumber: true,
  firstName: true,
  lastName: true,
  otherNames: true,
  sex: true,
  dateOfBirth: true,
  status: true,
  enrollments: CURRENT_CLASS,
} satisfies Prisma.StudentSelect;

type SummaryRow = Prisma.StudentGetPayload<{ select: typeof SUMMARY }>;

const summary = (s: SummaryRow) => ({
  id: s.id,
  admissionNumber: s.admissionNumber,
  firstName: s.firstName,
  lastName: s.lastName,
  otherNames: s.otherNames,
  sex: s.sex,
  dateOfBirth: s.dateOfBirth ? fromDbDate(s.dateOfBirth) : null,
  status: s.status,
  currentClass: s.enrollments[0]
    ? { id: s.enrollments[0].class.id, name: s.enrollments[0].class.name, yearName: s.enrollments[0].class.academicYear.name }
    : null,
});

/** Changing these is a correction of identity, so it needs a reason and is audited. */
const SENSITIVE = ['firstName', 'lastName', 'otherNames', 'dateOfBirth', 'admissionNumber'] as const;

const studentNotFound = () => notFound('Student not found');
const admissionTaken = () => conflict('ADMISSION_NUMBER_TAKEN', 'Another student already has this admission number.');

/**
 * Every query is scoped by the server-resolved schoolId plus a visibility filter for the caller
 * (everyone, or students enrolled in the caller's own classes).
 */
@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(schoolId: string, q: ListStudentsInput, visible: Prisma.StudentWhereInput = {}) {
    const where: Prisma.StudentWhereInput = {
      AND: [
        { schoolId },
        visible,
        q.status ? { status: q.status } : {},
        q.classId ? { enrollments: { some: { classId: q.classId, status: 'ACTIVE' } } } : {},
        q.search
          ? {
              OR: [
                { firstName: { contains: q.search, mode: 'insensitive' } },
                { lastName: { contains: q.search, mode: 'insensitive' } },
                { otherNames: { contains: q.search, mode: 'insensitive' } },
                { admissionNumber: { contains: q.search, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.student.findMany({
        where,
        select: SUMMARY,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.student.count({ where }),
    ]);
    return { data: rows.map(summary), meta: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) } };
  }

  async get(schoolId: string, id: string, visible: Prisma.StudentWhereInput = {}) {
    // Same 404 whether the student doesn't exist, belongs to another school, or is outside the caller's classes.
    const s = await this.prisma.student.findFirst({
      where: { AND: [{ schoolId, id }, visible] },
      select: {
        ...SUMMARY,
        admissionDate: true,
        previousSchool: true,
        homeAddress: true,
        statusReason: true,
        statusChangedAt: true,
        enrollments: {
          orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
          select: {
            id: true,
            status: true,
            startDate: true,
            endDate: true,
            endReason: true,
            class: { select: { id: true, name: true, academicYear: { select: { name: true } } } },
          },
        },
        _count: { select: { documents: true } },
        user: { select: { email: true, status: true } },
      },
    });
    if (!s) throw studentNotFound();
    const active = s.enrollments.find((e) => e.status === 'ACTIVE');
    return {
      data: {
        ...summary({ ...s, enrollments: active ? [active] : [] }),
        admissionDate: fromDbDate(s.admissionDate),
        previousSchool: s.previousSchool,
        homeAddress: s.homeAddress,
        statusReason: s.statusReason,
        statusChangedAt: s.statusChangedAt,
        enrollments: s.enrollments.map((e) => ({
          id: e.id,
          status: e.status,
          startDate: fromDbDate(e.startDate),
          endDate: e.endDate ? fromDbDate(e.endDate) : null,
          endReason: e.endReason,
          className: e.class.name,
          yearName: e.class.academicYear.name,
        })),
        documentCount: s._count.documents,
        account: s.user ? { email: s.user.email, status: s.user.status === 'ACTIVE' ? 'ACTIVE' : 'INVITED' } : null,
      },
    };
  }

  async admit(school: SchoolContext, input: AdmitStudentInput, actor: Actor) {
    const { schoolId } = school;
    const dob = input.dateOfBirth ? toDbDate(input.dateOfBirth) : null;

    if (!input.confirmDuplicate) {
      const matches = await this.prisma.student.findMany({
        where: {
          schoolId,
          firstName: { equals: input.firstName, mode: 'insensitive' },
          lastName: { equals: input.lastName, mode: 'insensitive' },
          ...(dob ? { OR: [{ dateOfBirth: dob }, { dateOfBirth: null }] } : {}),
        },
        select: { id: true, firstName: true, lastName: true, admissionNumber: true, status: true },
        take: 5,
      });
      if (matches.length > 0) {
        throw conflict('POSSIBLE_DUPLICATE', 'A student with this name is already on record. Check before admitting again.', { matches });
      }
    }

    const admissionDate = toDbDate(input.admissionDate ?? todayIn(school.timezone));
    const target = input.classId ? await this.enrollableClass(schoolId, input.classId) : null;

    try {
      const student = await this.prisma.$transaction(async (tx) => {
        const admissionNumber = input.admissionNumber ?? (await this.nextAdmissionNumber(tx, schoolId, admissionDate));
        const created = await tx.student.create({
          data: {
            schoolId,
            admissionNumber,
            firstName: input.firstName,
            lastName: input.lastName,
            otherNames: input.otherNames ?? null,
            dateOfBirth: dob,
            sex: input.sex ?? null,
            admissionDate,
            previousSchool: input.previousSchool ?? null,
            homeAddress: input.homeAddress ?? null,
          },
          select: { id: true, admissionNumber: true },
        });
        if (target) {
          await this.assertCapacity(tx, target);
          await tx.enrollment.create({
            data: { schoolId, studentId: created.id, classId: target.id, academicYearId: target.academicYearId, startDate: admissionDate },
          });
        }
        return created;
      });
      await this.log('student.admit', schoolId, student.id, actor, {
        admissionNumber: student.admissionNumber,
        ...(target ? { classId: target.id } : {}),
        ...(input.confirmDuplicate ? { duplicateWarningDismissed: true } : {}),
      });
      return this.get(schoolId, student.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw admissionTaken();
      throw err;
    }
  }

  async update(schoolId: string, id: string, input: UpdateStudentInput, actor: Actor) {
    const current = await this.prisma.student.findUnique({
      where: { schoolId_id: { schoolId, id } },
      select: { firstName: true, lastName: true, otherNames: true, dateOfBirth: true, admissionNumber: true },
    });
    if (!current) throw studentNotFound();

    const { reason, dateOfBirth, ...rest } = input;
    const data: Prisma.StudentUpdateInput = {
      ...rest,
      ...(dateOfBirth !== undefined ? { dateOfBirth: dateOfBirth ? toDbDate(dateOfBirth) : null } : {}),
    };
    const currentDob = current.dateOfBirth ? fromDbDate(current.dateOfBirth) : null;
    const corrected = SENSITIVE.filter((field) => {
      if (input[field] === undefined) return false;
      const before = field === 'dateOfBirth' ? currentDob : current[field];
      return input[field] !== before;
    });
    if (corrected.length > 0 && !reason) {
      throw badRequest('REASON_REQUIRED', 'Give a reason when correcting a name, date of birth or admission number.');
    }

    try {
      await this.prisma.student.update({ where: { id }, data });
    } catch (err) {
      if (isUniqueViolation(err)) throw admissionTaken();
      throw err;
    }
    // Field names only: the record itself holds the new values, and the log shouldn't duplicate personal data.
    await this.log(corrected.length ? 'student.correct' : 'student.update', schoolId, id, actor, {
      fields: Object.keys(input).filter((k) => k !== 'reason'),
      ...(corrected.length ? { corrected, reason: reason! } : {}),
    });
    return this.get(schoolId, id);
  }

  async enroll(school: SchoolContext, studentId: string, input: EnrollInput, actor: Actor) {
    const { schoolId } = school;
    const student = await this.prisma.student.findUnique({ where: { schoolId_id: { schoolId, id: studentId } }, select: { status: true } });
    if (!student) throw studentNotFound();
    if (student.status !== 'ACTIVE') throw conflict('STUDENT_NOT_ACTIVE', 'Only active students can be enrolled.');
    const target = await this.enrollableClass(schoolId, input.classId);

    try {
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.enrollment.findFirst({
          where: { schoolId, studentId, academicYearId: target.academicYearId, status: 'ACTIVE' },
          select: { id: true },
        });
        if (existing) throw conflict('ALREADY_ENROLLED', 'This student already has a class this year. Use transfer instead.');
        await this.assertCapacity(tx, target);
        await tx.enrollment.create({
          data: {
            schoolId,
            studentId,
            classId: target.id,
            academicYearId: target.academicYearId,
            startDate: toDbDate(input.startDate ?? todayIn(school.timezone)),
          },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('ALREADY_ENROLLED', 'This student already has a class this year. Use transfer instead.');
      throw err;
    }
    await this.log('student.enroll', schoolId, studentId, actor, { classId: target.id });
    return this.get(schoolId, studentId);
  }

  /** Moves a student to another class in the same year, keeping the old enrollment as history. */
  async transfer(school: SchoolContext, studentId: string, input: TransferInput, actor: Actor) {
    const { schoolId } = school;
    const target = await this.enrollableClass(schoolId, input.classId);
    const date = toDbDate(input.date ?? todayIn(school.timezone));

    const fromClassId = await this.prisma.$transaction(async (tx) => {
      const current = await tx.enrollment.findFirst({
        where: { schoolId, studentId, academicYearId: target.academicYearId, status: 'ACTIVE' },
        select: { id: true, classId: true, startDate: true },
      });
      if (!current) {
        const exists = await tx.student.findUnique({ where: { schoolId_id: { schoolId, id: studentId } }, select: { id: true } });
        if (!exists) throw studentNotFound();
        throw conflict('NOT_ENROLLED', 'This student has no class in that year yet. Enroll them instead.');
      }
      if (current.classId === target.id) throw conflict('SAME_CLASS', 'The student is already in this class.');
      if (date < current.startDate) throw badRequest('INVALID_DATES', 'The transfer date is before the current enrollment started.');
      await this.assertCapacity(tx, target);
      await tx.enrollment.update({ where: { id: current.id }, data: { status: 'TRANSFERRED', endDate: date, endReason: input.reason } });
      await tx.enrollment.create({
        data: { schoolId, studentId, classId: target.id, academicYearId: target.academicYearId, startDate: date },
      });
      return current.classId;
    });
    await this.log('student.transfer', schoolId, studentId, actor, { fromClassId, toClassId: target.id, reason: input.reason });
    return this.get(schoolId, studentId);
  }

  async withdraw(school: SchoolContext, studentId: string, input: WithdrawInput, actor: Actor) {
    const { schoolId } = school;
    const date = toDbDate(input.date ?? todayIn(school.timezone));
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.student.updateMany({
        where: { schoolId, id: studentId, status: 'ACTIVE' },
        data: { status: input.status, statusReason: input.reason, statusChangedAt: new Date() },
      });
      if (updated.count !== 1) {
        const exists = await tx.student.findUnique({ where: { schoolId_id: { schoolId, id: studentId } }, select: { id: true } });
        if (!exists) throw studentNotFound();
        throw conflict('STUDENT_NOT_ACTIVE', 'This student has already left.');
      }
      await tx.enrollment.updateMany({
        where: { schoolId, studentId, status: 'ACTIVE' },
        data: { status: input.status === 'GRADUATED' ? 'COMPLETED' : 'WITHDRAWN', endDate: date, endReason: input.reason },
      });
    });
    await this.log('student.withdraw', schoolId, studentId, actor, { status: input.status, reason: input.reason });
    return this.get(schoolId, studentId);
  }

  async history(schoolId: string, id: string) {
    await this.get(schoolId, id);
    return { data: await auditHistory(this.prisma, schoolId, 'student', id) };
  }

  /** A class of a year that isn't closed. */
  private async enrollableClass(schoolId: string, classId: string) {
    const c = await this.prisma.schoolClass.findUnique({
      where: { schoolId_id: { schoolId, id: classId } },
      select: { id: true, academicYearId: true, capacity: true, academicYear: { select: { status: true } } },
    });
    if (!c) throw notFound('Class not found');
    if (c.academicYear.status === 'CLOSED') throw conflict('YEAR_CLOSED', 'That class belongs to a closed academic year.');
    return c;
  }

  private async assertCapacity(tx: Prisma.TransactionClient, c: { id: string; capacity: number | null }) {
    if (c.capacity === null) return;
    const count = await tx.enrollment.count({ where: { classId: c.id, status: 'ACTIVE' } });
    if (count >= c.capacity) throw conflict('CLASS_FULL', `This class is full (${c.capacity} places).`);
  }

  /** PREFIX-YYYY-0001, from an atomic per-school counter. Skips numbers already used manually. */
  private async nextAdmissionNumber(tx: Prisma.TransactionClient, schoolId: string, admissionDate: Date) {
    const school = await tx.school.findUniqueOrThrow({ where: { id: schoolId }, select: { slug: true, admissionNumberPrefix: true } });
    const prefix = school.admissionNumberPrefix ?? school.slug.replace(/[^a-z0-9]/g, '').slice(0, 3).toUpperCase();
    const year = admissionDate.getUTCFullYear();
    for (let attempt = 0; attempt < 20; attempt++) {
      const [row] = await tx.$queryRaw<{ value: number }[]>`
        INSERT INTO school_counters ("schoolId", key, value) VALUES (${schoolId}::uuid, ${`admission:${year}`}, 1)
        ON CONFLICT ("schoolId", key) DO UPDATE SET value = school_counters.value + 1
        RETURNING value`;
      const candidate = `${prefix}-${year}-${String(row!.value).padStart(4, '0')}`;
      const taken = await tx.student.findUnique({ where: { schoolId_admissionNumber: { schoolId, admissionNumber: candidate } }, select: { id: true } });
      if (!taken) return candidate;
    }
    throw conflict('ADMISSION_NUMBER_EXHAUSTED', 'Could not generate an admission number. Enter one manually.');
  }

  private log(action: string, schoolId: string, resourceId: string, actor: Actor, summary: Prisma.InputJsonObject) {
    return this.audit.record({
      action,
      outcome: 'SUCCESS',
      resourceType: 'student',
      resourceId,
      schoolId,
      actorUserId: actor.userId,
      summary,
      correlationId: actor.correlationId,
    });
  }
}
