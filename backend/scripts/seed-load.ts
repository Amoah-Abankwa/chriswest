// Creates a large practice school for load tests: classes, students, a year of registers.
// Refuses to run in production. Usage: npm run seed:load -w backend -- 1500
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { createBuiltInRoles } from '../src/access/built-in-roles';
import { hashPassword } from '../src/auth/crypto';
import { getEnv } from '../src/config/env';
import { PrismaClient } from '../src/generated/prisma/client';

async function main() {
  const env = getEnv();
  if (env.NODE_ENV === 'production') throw new Error('Not in production');
  const students = Number(process.argv[2] ?? 1500);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DIRECT_URL }) });
  try {
    const host = `loadtest.${env.PLATFORM_BASE_DOMAIN}`;
    const school = await prisma.school.create({ data: { name: 'Load Test School', slug: `loadtest${Date.now() % 100000}`, domains: { create: { hostname: host, kind: 'SUBDOMAIN', isVerified: true, isPrimary: true } } } });
    const roles = await prisma.$transaction((tx) => createBuiltInRoles(tx, school.id));
    const passwordHash = await hashPassword('load-test-password');
    for (const [email, role] of [['loadmanager@example.test', roles.manager], ['loadteacher@example.test', roles.teacher]] as const) {
      const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email, passwordHash, status: 'ACTIVE', fullName: email.split('@')[0] } });
      const m = await prisma.schoolMembership.create({ data: { schoolId: school.id, userId: user.id } });
      await prisma.membershipRole.create({ data: { schoolId: school.id, membershipId: m.id, roleId: role! } });
    }
    const year = await prisma.academicYear.create({ data: { schoolId: school.id, name: '2026/2027', startDate: new Date('2026-09-01'), endDate: new Date('2027-07-31'), status: 'ACTIVE' } });
    await prisma.term.create({ data: { schoolId: school.id, academicYearId: year.id, name: 'Term 1', startDate: new Date('2026-09-01'), endDate: new Date('2026-12-18') } });
    const level = await prisma.educationLevel.create({ data: { schoolId: school.id, name: 'Primary 1', stage: 'PRIMARY', sortOrder: 10 } });
    const classes = await Promise.all(Array.from({ length: Math.ceil(students / 40) }, (_, i) => prisma.schoolClass.create({ data: { schoolId: school.id, academicYearId: year.id, levelId: level.id, name: `P1 ${i + 1}` } })));
    for (let i = 0; i < students; i += 500) {
      const batch = Array.from({ length: Math.min(500, students - i) }, (_, j) => ({ schoolId: school.id, admissionNumber: `LT-${i + j}`, firstName: `Student${i + j}`, lastName: 'Load', admissionDate: new Date('2026-09-01') }));
      await prisma.student.createMany({ data: batch });
    }
    const all = await prisma.student.findMany({ where: { schoolId: school.id }, select: { id: true } });
    await prisma.enrollment.createMany({ data: all.map((s, i) => ({ schoolId: school.id, studentId: s.id, classId: classes[Math.floor(i / 40)]!.id, academicYearId: year.id, startDate: new Date('2026-09-01') })) });
    console.log(`Created ${host} with ${students} students in ${classes.length} classes. Sign in as loadmanager@example.test / load-test-password`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
