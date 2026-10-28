import { createBuiltInRoles } from '../src/access/built-in-roles';
import { PERMISSIONS } from '../src/access/permissions';
import { hashPassword } from '../src/auth/crypto';
import type { PrismaService } from '../src/prisma/prisma.service';

export const PASSWORD = 'correct-horse-battery-staple';
export const HOSTS = {
  oakwood: 'oakwood.test',
  maple: 'maple.test',
  cedar: 'cedar.test',
  pending: 'pending.test',
  admin: 'admin.test', // must match PLATFORM_ADMIN_HOST in .env.test
};

export async function resetDatabase(prisma: PrismaService) {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE leave_requests, leave_types, transport_assignments, transport_stops, transport_routes,
     library_loans, library_copies, library_books, contact_messages, site_media, site_posts, site_pages, export_jobs, email_deliveries, worker_heartbeats, notifications, announcement_classes, announcements, timetable_entries, timetable_periods, result_corrections, subject_results, marks, result_sheets, assessments, grading_bands, receipts, payment_allocations, payments, invoice_adjustments, invoice_items, invoices,
     fee_structure_items, fee_structures, fee_categories, outbox_events, attendance_corrections, attendance_records, attendance_sessions, audit_logs, student_documents, student_guardians, guardians, enrollments, school_counters, staff_profiles, subject_teachers, class_teachers, class_subjects, classes, subjects,
     education_levels, terms, academic_years, membership_roles, role_permissions, roles, sessions,
     auth_tokens, school_memberships, students, school_domains, schools, users RESTART IDENTITY CASCADE`,
  );
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({ where: { key: p.key }, update: {}, create: p });
  }
}

export async function member(prisma: PrismaService, schoolId: string, email: string, opts: { passwordHash?: string; roleId?: string; invited?: boolean }) {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: opts.invited ? null : opts.passwordHash,
      status: opts.invited ? 'INVITED' : 'ACTIVE',
    },
  });
  const membership = await prisma.schoolMembership.create({ data: { schoolId, userId: user.id } });
  if (opts.roleId) {
    await prisma.membershipRole.create({ data: { schoolId, membershipId: membership.id, roleId: opts.roleId } });
  }
  return { user, membership };
}

async function readerRole(prisma: PrismaService, schoolId: string) {
  const role = await prisma.role.create({ data: { schoolId, key: 'student-reader', name: 'Student reader' } });
  await prisma.rolePermission.create({ data: { schoolId, roleId: role.id, permissionKey: 'students.read' } });
  return role;
}

/**
 * Production runs exactly one school. Several schools are seeded here on purpose: every table still
 * carries schoolId, and these fixtures prove each query stays scoped to its school (a cheap guard
 * against mistakes, and what makes reuse for another school safe later).
 *
 * Oakwood (A) and Maple (B) are active; Cedar is suspended; pending.test is an unverified Oakwood domain.
 */
export async function seedSchools(prisma: PrismaService) {
  const passwordHash = await hashPassword(PASSWORD);

  const oakwood = await prisma.school.create({
    data: {
      name: 'Oakwood Academy',
      slug: 'oakwood',
      domains: {
        create: [
          { hostname: HOSTS.oakwood, kind: 'SUBDOMAIN', isVerified: true, isPrimary: true },
          { hostname: HOSTS.pending, kind: 'CUSTOM', isVerified: false },
        ],
      },
    },
  });
  const maple = await prisma.school.create({
    data: {
      name: 'Maple Primary',
      slug: 'maple',
      domains: { create: [{ hostname: HOSTS.maple, kind: 'SUBDOMAIN', isVerified: true, isPrimary: true }] },
    },
  });
  const cedar = await prisma.school.create({
    data: {
      name: 'Cedar School',
      slug: 'cedar',
      status: 'SUSPENDED',
      domains: { create: [{ hostname: HOSTS.cedar, kind: 'SUBDOMAIN', isVerified: true, isPrimary: true }] },
    },
  });

  const oakRole = await readerRole(prisma, oakwood.id);
  const mapleRole = await readerRole(prisma, maple.id);

  const alice = await member(prisma, oakwood.id, 'alice@example.test', { passwordHash, roleId: oakRole.id });
  const bob = await member(prisma, maple.id, 'bob@example.test', { passwordHash, roleId: mapleRole.id });
  const carol = await member(prisma, oakwood.id, 'carol@example.test', { passwordHash }); // no roles
  const dave = await member(prisma, oakwood.id, 'dave@example.test', { invited: true });

  // Each active school gets the real built-in roles and a Manager, as Phase 2 onboarding does.
  const oakBuiltIn = await prisma.$transaction((tx) => createBuiltInRoles(tx, oakwood.id));
  const mapleBuiltIn = await prisma.$transaction((tx) => createBuiltInRoles(tx, maple.id));
  const maya = await member(prisma, oakwood.id, 'maya@example.test', { passwordHash, roleId: oakBuiltIn.manager });
  const mo = await member(prisma, maple.id, 'mo@example.test', { passwordHash, roleId: mapleBuiltIn.manager });
  const tom = await member(prisma, oakwood.id, 'tom@example.test', { passwordHash, roleId: oakBuiltIn.teacher });

  const superAdmin = await prisma.user.create({
    data: { email: 'root@platform.test', passwordHash, status: 'ACTIVE', platformRole: 'SUPER_ADMIN' },
  });
  const support = await prisma.user.create({
    data: { email: 'helpdesk@platform.test', passwordHash, status: 'ACTIVE', platformRole: 'SUPPORT' },
  });

  const oakStudent = await prisma.student.create({
    data: { schoolId: oakwood.id, admissionNumber: 'OAK-001', firstName: 'Ama', lastName: 'Mensah' },
  });
  const mapleStudent = await prisma.student.create({
    data: { schoolId: maple.id, admissionNumber: 'MAP-001', firstName: 'Kofi', lastName: 'Owusu' },
  });

  return {
    oakwood, maple, cedar, oakRole, mapleRole, alice, bob, carol, dave, maya, mo, tom,
    superAdmin, support, oakStudent, mapleStudent,
  };
}

/** Just the super admin and support accounts, with no school: the state before the school is created. */
export async function seedPlatformOnly(prisma: PrismaService) {
  const passwordHash = await hashPassword(PASSWORD);
  const superAdmin = await prisma.user.create({ data: { email: 'root@platform.test', passwordHash, status: 'ACTIVE', platformRole: 'SUPER_ADMIN' } });
  const support = await prisma.user.create({ data: { email: 'helpdesk@platform.test', passwordHash, status: 'ACTIVE', platformRole: 'SUPPORT' } });
  return { superAdmin, support };
}
