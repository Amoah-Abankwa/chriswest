import { Injectable } from '@nestjs/common';
import { fromDbDate } from '../common/dates';
import { notFound } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

export type PortalArea = 'profile' | 'attendance' | 'results' | 'timetable' | 'fees';

/**
 * Who may see a student in the portal:
 * - a parent, through a staff-created link with portalAccess on;
 * - the student themselves, through their own account (fees only if the school allows it).
 * Everything else gets the same 404, whatever the reason.
 */
@Injectable()
export class PortalService {
  constructor(private readonly prisma: PrismaService) {}

  async relationTo(schoolId: string, userId: string, studentId: string): Promise<'SELF' | string | null> {
    const [link, self] = await Promise.all([
      this.prisma.studentGuardian.findFirst({
        where: { schoolId, studentId, portalAccess: true, guardian: { userId } },
        select: { relationship: true },
      }),
      this.prisma.student.findFirst({ where: { schoolId, id: studentId, userId }, select: { id: true } }),
    ]);
    if (link) return link.relationship;
    if (self) return 'SELF';
    return null;
  }

  async assertCanView(schoolId: string, userId: string, studentId: string, area: PortalArea = 'profile') {
    const relation = await this.relationTo(schoolId, userId, studentId);
    if (!relation) throw notFound('Not found');
    if (relation === 'SELF' && area === 'fees') {
      const school = await this.prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { studentPortalFees: true } });
      if (!school.studentPortalFees) throw notFound('Not found');
    }
    return relation;
  }

  /** Kept for existing callers: parent or self, profile-level access. */
  assertLinked(schoolId: string, userId: string, studentId: string) {
    return this.assertCanView(schoolId, userId, studentId);
  }

  async children(schoolId: string, userId: string) {
    const links = await this.prisma.studentGuardian.findMany({
      where: { schoolId, portalAccess: true, guardian: { userId } },
      select: {
        relationship: true,
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            otherNames: true,
            status: true,
            enrollments: { where: { status: 'ACTIVE' }, take: 1, select: { class: { select: { name: true } } } },
          },
        },
      },
      orderBy: { student: { firstName: 'asc' } },
    });
    return {
      data: links.map((l) => ({
        id: l.student.id,
        firstName: l.student.firstName,
        lastName: l.student.lastName,
        otherNames: l.student.otherNames,
        status: l.student.status,
        relationship: l.relationship,
        className: l.student.enrollments[0]?.class.name ?? null,
      })),
    };
  }

  /** For a student's own account: which student record it is, and what the school lets them see. */
  async me(schoolId: string, userId: string) {
    const student = await this.prisma.student.findFirst({
      where: { schoolId, userId },
      select: { id: true, firstName: true, lastName: true, enrollments: { where: { status: 'ACTIVE' }, take: 1, select: { class: { select: { name: true } } } } },
    });
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { studentPortalFees: true } });
    return {
      data: student
        ? { studentId: student.id, firstName: student.firstName, lastName: student.lastName, className: student.enrollments[0]?.class.name ?? null, canSeeFees: school.studentPortalFees }
        : null,
    };
  }

  async child(schoolId: string, userId: string, studentId: string) {
    const relation = await this.assertCanView(schoolId, userId, studentId);
    const s = await this.prisma.student.findFirstOrThrow({
      where: { schoolId, id: studentId },
      select: {
        id: true,
        admissionNumber: true,
        firstName: true,
        lastName: true,
        otherNames: true,
        dateOfBirth: true,
        status: true,
        enrollments: {
          where: { status: 'ACTIVE' },
          take: 1,
          select: {
            class: {
              select: {
                id: true,
                name: true,
                academicYear: { select: { name: true } },
                classTeacher: { select: { membership: { select: { user: { select: { fullName: true } } } } } },
                subjects: { select: { subject: { select: { name: true } } }, orderBy: { subject: { name: 'asc' } } },
              },
            },
          },
        },
      },
    });
    const cls = s.enrollments[0]?.class;
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { studentPortalFees: true } });
    return {
      data: {
        id: s.id,
        admissionNumber: s.admissionNumber,
        firstName: s.firstName,
        lastName: s.lastName,
        otherNames: s.otherNames,
        dateOfBirth: s.dateOfBirth ? fromDbDate(s.dateOfBirth) : null,
        status: s.status,
        relationship: relation,
        canSeeFees: relation !== 'SELF' || school.studentPortalFees,
        currentClass: cls
          ? {
              id: cls.id,
              name: cls.name,
              yearName: cls.academicYear.name,
              classTeacher: cls.classTeacher?.membership.user.fullName ?? null,
              subjects: cls.subjects.map((x) => x.subject.name),
            }
          : null,
      },
    };
  }

  /** The class a student is in now, for the timetable. */
  async currentClassId(schoolId: string, studentId: string) {
    const e = await this.prisma.enrollment.findFirst({ where: { schoolId, studentId, status: 'ACTIVE' }, select: { classId: true } });
    return e?.classId ?? null;
  }
}
