import type { PrismaService } from '../prisma/prisma.service';

/**
 * Who should hear about a student: parents linked with portal access (in-app), every linked parent
 * with an email address (email), and the student's own account if they have one.
 */
export async function recipientsForStudent(prisma: PrismaService, schoolId: string, studentId: string, opts: { includeStudent: boolean }) {
  const [links, student] = await Promise.all([
    prisma.studentGuardian.findMany({
      where: { schoolId, studentId },
      select: { portalAccess: true, guardian: { select: { userId: true, email: true } } },
    }),
    prisma.student.findUnique({ where: { schoolId_id: { schoolId, id: studentId } }, select: { userId: true } }),
  ]);
  const users = new Set(links.flatMap((l) => (l.portalAccess && l.guardian.userId ? [l.guardian.userId] : [])));
  if (opts.includeStudent && student?.userId) users.add(student.userId);
  const emails = [...new Set(links.flatMap((l) => (l.guardian.email ? [l.guardian.email] : [])))];
  return { userIds: [...users], emails, link: `/portal/children/${studentId}` };
}
