import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { conflict, isUniqueViolation, notFound } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateClassInput, SetClassSubjectsInput, UpdateClassInput } from './academics.schemas';

const MEMBER = { select: { id: true, user: { select: { email: true, fullName: true } } } } as const;

const CLASS = {
  id: true,
  name: true,
  capacity: true,
  academicYearId: true,
  level: { select: { id: true, name: true } },
  classTeacher: { select: { membership: MEMBER } },
  subjects: {
    select: { subject: { select: { id: true, name: true, code: true } }, teacher: { select: { membership: MEMBER } } },
    orderBy: { subject: { name: 'asc' } },
  },
} satisfies Prisma.SchoolClassSelect;

type ClassRow = Prisma.SchoolClassGetPayload<{ select: typeof CLASS }>;
type MemberRow = { id: string; user: { email: string; fullName: string | null } };

const person = (m: MemberRow) => ({ membershipId: m.id, email: m.user.email, fullName: m.user.fullName });

const toDto = (c: ClassRow) => ({
  id: c.id,
  name: c.name,
  capacity: c.capacity,
  academicYearId: c.academicYearId,
  level: c.level,
  classTeacher: c.classTeacher ? person(c.classTeacher.membership) : null,
  subjects: c.subjects.map((s) => ({ ...s.subject, teacher: s.teacher ? person(s.teacher.membership) : null })),
});

const classNotFound = () => notFound('Class not found');
const yearClosed = () => conflict('YEAR_CLOSED', 'This academic year is closed and its classes can no longer be changed.');

@Injectable()
export class ClassesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Defaults to the current year. `visible` narrows to the classes the caller may see. */
  async list(schoolId: string, academicYearId?: string, visible: Prisma.SchoolClassWhereInput = {}) {
    const year = academicYearId
      ? await this.prisma.academicYear.findUnique({ where: { schoolId_id: { schoolId, id: academicYearId } }, select: { id: true } })
      : await this.prisma.academicYear.findFirst({ where: { schoolId, status: 'ACTIVE' }, select: { id: true } });
    if (academicYearId && !year) throw notFound('Academic year not found');
    if (!year) return { data: [], meta: { academicYearId: null } };

    const classes = await this.prisma.schoolClass.findMany({
      where: { schoolId, academicYearId: year.id, ...visible },
      select: CLASS,
      orderBy: [{ level: { sortOrder: 'asc' } }, { name: 'asc' }],
    });
    return { data: classes.map(toDto), meta: { academicYearId: year.id } };
  }

  async get(schoolId: string, id: string, visible: Prisma.SchoolClassWhereInput = {}) {
    const c = await this.prisma.schoolClass.findFirst({ where: { schoolId, id, ...visible }, select: CLASS });
    if (!c) throw classNotFound();
    return { data: toDto(c) };
  }

  async create(schoolId: string, input: CreateClassInput, actor: Actor) {
    const [year, level] = await Promise.all([
      this.prisma.academicYear.findUnique({ where: { schoolId_id: { schoolId, id: input.academicYearId } }, select: { status: true } }),
      this.prisma.educationLevel.findUnique({ where: { schoolId_id: { schoolId, id: input.levelId } }, select: { isActive: true } }),
    ]);
    if (!year) throw notFound('Academic year not found');
    if (year.status === 'CLOSED') throw yearClosed();
    if (!level) throw notFound('Level not found');
    if (!level.isActive) throw conflict('LEVEL_INACTIVE', 'This level is hidden. Show it again before adding classes.');

    try {
      const c = await this.prisma.schoolClass.create({
        data: { schoolId, academicYearId: input.academicYearId, levelId: input.levelId, name: input.name, capacity: input.capacity ?? null },
        select: CLASS,
      });
      await this.log('class.create', schoolId, c.id, actor, { name: input.name, academicYearId: input.academicYearId });
      return { data: toDto(c) };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'This year already has a class with that name.');
      throw err;
    }
  }

  async update(schoolId: string, id: string, input: UpdateClassInput, actor: Actor) {
    await this.assertEditable(schoolId, id);
    if (input.levelId) {
      const level = await this.prisma.educationLevel.findUnique({
        where: { schoolId_id: { schoolId, id: input.levelId } },
        select: { isActive: true },
      });
      if (!level) throw notFound('Level not found');
      if (!level.isActive) throw conflict('LEVEL_INACTIVE', 'This level is hidden. Show it again before using it.');
    }
    try {
      const c = await this.prisma.schoolClass.update({ where: { id }, data: input, select: CLASS });
      await this.log('class.update', schoolId, id, actor, { fields: Object.keys(input) });
      return { data: toDto(c) };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'This year already has a class with that name.');
      throw err;
    }
  }

  async remove(schoolId: string, id: string, actor: Actor) {
    await this.assertEditable(schoolId, id);
    const [enrolled, registers] = await Promise.all([
      this.prisma.enrollment.count({ where: { schoolId, classId: id } }),
      this.prisma.attendanceSession.count({ where: { schoolId, classId: id } }),
    ]);
    if (enrolled + registers > 0) throw conflict('CLASS_IN_USE', 'Students have been enrolled in this class, so it can’t be deleted.');
    await this.prisma.schoolClass.delete({ where: { id } });
    await this.log('class.delete', schoolId, id, actor);
  }

  async setClassTeacher(schoolId: string, classId: string, membershipId: string | null, actor: Actor) {
    await this.assertEditable(schoolId, classId);
    if (membershipId === null) {
      await this.prisma.classTeacher.deleteMany({ where: { schoolId, classId } });
    } else {
      await this.assertActiveMembers(schoolId, [membershipId]);
      await this.prisma.classTeacher.upsert({
        where: { classId },
        create: { schoolId, classId, membershipId },
        update: { membershipId, assignedAt: new Date() },
      });
    }
    await this.log('class.class_teacher_set', schoolId, classId, actor, { membershipId });
    return this.get(schoolId, classId);
  }

  /** Replaces the class's subject list and subject teachers in one step. */
  async setSubjects(schoolId: string, classId: string, input: SetClassSubjectsInput, actor: Actor) {
    await this.assertEditable(schoolId, classId);

    const subjectIds = input.subjects.map((s) => s.subjectId);
    const current = await this.prisma.classSubject.findMany({ where: { schoolId, classId }, select: { subjectId: true } });
    const currentIds = new Set(current.map((c) => c.subjectId));

    const subjects = await this.prisma.subject.findMany({
      where: { schoolId, id: { in: subjectIds } },
      select: { id: true, isActive: true },
    });
    if (subjects.length !== subjectIds.length) throw notFound('One or more subjects were not found');
    if (subjects.some((s) => !s.isActive && !currentIds.has(s.id))) {
      throw conflict('SUBJECT_INACTIVE', 'Hidden subjects can’t be added to a class.');
    }

    const teacherIds = [...new Set(input.subjects.flatMap((s) => (s.teacherMembershipId ? [s.teacherMembershipId] : [])))];
    await this.assertActiveMembers(schoolId, teacherIds);

    await this.prisma.$transaction(async (tx) => {
      await tx.classSubject.deleteMany({ where: { schoolId, classId, subjectId: { notIn: subjectIds } } });
      await tx.classSubject.createMany({
        data: subjectIds.map((subjectId) => ({ schoolId, classId, subjectId })),
        skipDuplicates: true,
      });
      for (const item of input.subjects) {
        if (item.teacherMembershipId) {
          await tx.subjectTeacher.upsert({
            where: { classId_subjectId: { classId, subjectId: item.subjectId } },
            create: { schoolId, classId, subjectId: item.subjectId, membershipId: item.teacherMembershipId },
            update: { membershipId: item.teacherMembershipId },
          });
        } else {
          await tx.subjectTeacher.deleteMany({ where: { schoolId, classId, subjectId: item.subjectId } });
        }
      }
    });

    await this.log('class.subjects_set', schoolId, classId, actor, {
      subjects: subjectIds.length,
      withTeacher: input.subjects.filter((s) => s.teacherMembershipId).length,
    });
    return this.get(schoolId, classId);
  }

  private async assertEditable(schoolId: string, classId: string) {
    const c = await this.prisma.schoolClass.findUnique({
      where: { schoolId_id: { schoolId, id: classId } },
      select: { academicYear: { select: { status: true } } },
    });
    if (!c) throw classNotFound();
    if (c.academicYear.status === 'CLOSED') throw yearClosed();
  }

  /** Every membership must belong to this school and be active. */
  private async assertActiveMembers(schoolId: string, membershipIds: string[]) {
    if (membershipIds.length === 0) return;
    const found = await this.prisma.schoolMembership.count({
      where: { schoolId, id: { in: membershipIds }, kind: 'STAFF', status: 'ACTIVE' },
    });
    if (found !== membershipIds.length) throw notFound('Staff member not found');
  }

  private log(action: string, schoolId: string, resourceId: string, actor: Actor, summary?: Prisma.InputJsonValue) {
    return this.audit.record({
      action,
      outcome: 'SUCCESS',
      resourceType: 'class',
      resourceId,
      schoolId,
      actorUserId: actor.userId,
      summary,
      correlationId: actor.correlationId,
    });
  }
}

/** Minimal staff picker until the Staff module (Phase 4) replaces it. */
@Injectable()
export class MembersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(schoolId: string) {
    const members = await this.prisma.schoolMembership.findMany({
      where: { schoolId, kind: 'STAFF', status: 'ACTIVE' },
      select: {
        id: true,
        user: { select: { email: true, fullName: true, status: true } },
        roles: { select: { role: { select: { name: true } } } },
      },
      orderBy: { user: { email: 'asc' } },
    });
    return {
      data: members.map((m) => ({
        membershipId: m.id,
        email: m.user.email,
        fullName: m.user.fullName,
        activated: m.user.status === 'ACTIVE',
        roles: m.roles.map((r) => r.role.name),
      })),
    };
  }
}
