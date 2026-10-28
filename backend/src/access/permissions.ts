// Stable permission identifiers. Never rename one that is already persisted;
// add a migration instead.
export const PERMISSIONS = [
  { key: 'school.read', description: 'View school profile' },
  { key: 'school.update', description: 'Update school profile and settings' },
  { key: 'staff.read', description: 'View staff' },
  { key: 'staff.create', description: 'Invite staff' },
  { key: 'staff.update', description: 'Update staff profiles and their roles' },
  { key: 'staff.deactivate', description: 'Deactivate and reactivate staff accounts' },
  { key: 'academics.read', description: 'View academic years, levels, classes and subjects' },
  { key: 'academics.manage', description: 'Set up academic years, terms, levels, classes, subjects and teacher assignments' },
  { key: 'timetable.manage', description: 'Set up periods and class timetables' },
  { key: 'announcements.manage', description: 'Write and publish announcements' },
  { key: 'website.manage', description: 'Edit the public website and read contact-form messages' },
  { key: 'library.read', description: 'View the library catalogue and loans' },
  { key: 'library.manage', description: 'Add books, lend and return them' },
  { key: 'transport.read', description: 'View bus routes and who rides them' },
  { key: 'transport.manage', description: 'Set up routes and assign students' },
  { key: 'leave.approve', description: 'Approve or decline staff leave requests' },
  { key: 'leave.manage', description: 'Set up leave types and allowances' },
  { key: 'roles.read', description: 'View roles' },
  { key: 'roles.manage', description: 'Create and edit custom roles' },
  { key: 'students.read', description: 'View students' },
  { key: 'students.create', description: 'Admit students' },
  { key: 'students.update', description: 'Update student records' },
  { key: 'students.transfer', description: 'Transfer or withdraw students' },
  { key: 'parents.read', description: 'View parents and guardians' },
  { key: 'parents.manage', description: 'Add parents and guardians, link them to students and give portal access' },
  { key: 'documents.read', description: 'View and download student documents' },
  { key: 'documents.manage', description: 'Upload and delete student documents' },
  { key: 'attendance.read', description: 'View attendance' },
  { key: 'attendance.record', description: 'Record attendance' },
  { key: 'attendance.correct', description: 'Correct attendance' },
  { key: 'fees.read', description: 'View fees, invoices, payments and balances' },
  { key: 'fees.manage', description: 'Set up fee categories and fee structures' },
  { key: 'invoices.create', description: 'Create invoices' },
  { key: 'invoices.adjust', description: 'Adjust invoices' },
  { key: 'payments.record', description: 'Record payments' },
  { key: 'payments.reverse', description: 'Reverse payments' },
  { key: 'receipts.read', description: 'View receipts' },
  { key: 'assessments.manage', description: 'Set up assessments, weights and the grading scale' },
  { key: 'results.read', description: 'View marks, results and report cards' },
  { key: 'marks.enter', description: 'Enter marks' },
  { key: 'results.submit', description: 'Submit results for review' },
  { key: 'results.approve', description: 'Approve results' },
  { key: 'results.publish', description: 'Publish results and correct published results' },
  { key: 'reports.read', description: 'View reports' },
  { key: 'audit.read', description: 'View school audit log' },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];
export type Scope = 'SCHOOL' | 'ASSIGNED';

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key) as [PermissionKey, ...PermissionKey[]];

/** Permissions that can be limited to the classes a person is assigned to. */
export const SCOPABLE = new Set<PermissionKey>([
  'academics.read',
  'students.read',
  'parents.read',
  'attendance.read',
  'attendance.record',
  'attendance.correct',
  'marks.enter',
  'results.submit',
  'results.read',
]);

const AREAS: [string, string][] = [
  ['school', 'School'],
  ['staff', 'Staff'],
  ['roles', 'Staff'],
  ['academics', 'Academic setup'],
  ['timetable', 'Academic setup'],
  ['announcements', 'Communication'],
  ['website', 'Communication'],
  ['library', 'Library'],
  ['transport', 'Transport'],
  ['leave', 'Staff'],
  ['students', 'Students and parents'],
  ['parents', 'Students and parents'],
  ['documents', 'Students and parents'],
  ['attendance', 'Attendance'],
  ['fees', 'Fees and payments'],
  ['invoices', 'Fees and payments'],
  ['payments', 'Fees and payments'],
  ['receipts', 'Fees and payments'],
  ['assessments', 'Assessments and results'],
  ['marks', 'Assessments and results'],
  ['results', 'Assessments and results'],
  ['reports', 'Reports and audit'],
  ['audit', 'Reports and audit'],
];
const AREA_BY_PREFIX = new Map(AREAS);

export const permissionArea = (key: string) => AREA_BY_PREFIX.get(key.split('.')[0]!) ?? 'Other';
