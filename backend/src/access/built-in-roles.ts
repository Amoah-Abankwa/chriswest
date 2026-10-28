import type { Prisma } from '../generated/prisma/client';
import { PERMISSIONS, type PermissionKey } from './permissions';

type BuiltInRole = {
  key: string;
  name: string;
  description: string;
  permissions: readonly PermissionKey[];
  /** Subset of permissions limited to the person's assigned classes. */
  assignedOnly?: readonly PermissionKey[];
};

/**
 * Built-in roles are fixed and kept in sync with this list by the seed script; schools that need
 * something different create custom roles. That way new permissions reach every school.
 *
 * Seeded when the school is created.
 */
export const BUILT_IN_ROLES: BuiltInRole[] = [
  {
    // The key stays 'manager' (it is referenced in code and data); people see "School owner".
    key: 'manager',
    name: 'School owner',
    description: 'Owns and runs the school: sets it up, invites staff and assigns their roles. Has every permission.',
    permissions: PERMISSIONS.map((p) => p.key),
  },
  {
    key: 'registrar',
    name: 'Registrar',
    description: 'Admissions, student records and parent details.',
    permissions: [
      'school.read', 'academics.read', 'students.read', 'students.create',
      'students.update', 'students.transfer', 'parents.read', 'parents.manage',
      'documents.read', 'documents.manage', 'attendance.read', 'results.read', 'reports.read',
    ],
  },
  {
    key: 'teacher',
    name: 'Teacher',
    description: 'Attendance, marks and results for the classes and subjects they teach.',
    permissions: [
      'school.read', 'academics.read', 'students.read', 'parents.read', 'attendance.read',
      'attendance.record', 'attendance.correct', 'marks.enter', 'results.submit', 'results.read',
    ],
    assignedOnly: [
      'students.read', 'parents.read', 'attendance.read', 'attendance.record',
      'attendance.correct', 'marks.enter', 'results.submit', 'results.read',
    ],
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Fees, invoices, payments and receipts.',
    permissions: [
      'school.read', 'academics.read', 'students.read', 'parents.read', 'fees.read', 'fees.manage', 'invoices.create', 'invoices.adjust',
      'payments.record', 'payments.reverse', 'receipts.read', 'reports.read',
    ],
  },
];

export const grantsOf = (def: BuiltInRole) =>
  def.permissions.map((key) => ({ key, scope: def.assignedOnly?.includes(key) ? ('ASSIGNED' as const) : ('SCHOOL' as const) }));

export async function createBuiltInRoles(tx: Prisma.TransactionClient, schoolId: string) {
  const ids: Record<string, string> = {};
  for (const def of BUILT_IN_ROLES) {
    const role = await tx.role.create({
      data: { schoolId, key: def.key, name: def.name, description: def.description, isSystem: true },
      select: { id: true },
    });
    await tx.rolePermission.createMany({
      data: grantsOf(def).map((g) => ({ schoolId, roleId: role.id, permissionKey: g.key, scope: g.scope })),
    });
    ids[def.key] = role.id;
  }
  return ids;
}
