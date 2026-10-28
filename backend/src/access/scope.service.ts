import { Global, Injectable, Module } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context';
import type { Prisma } from '../generated/prisma/client';
import type { PermissionKey } from './permissions';

/**
 * Turns a permission's scope into a database filter. A permission granted ASSIGNED only reaches
 * classes where the person is the class teacher or teaches a subject.
 */
@Injectable()
export class ScopeService {
  /** Filter for classes the caller may act on with `permission`. Guards have already checked they hold it. */
  classFilter(auth: AuthContext, permission: PermissionKey): Prisma.SchoolClassWhereInput {
    const scope = auth.permissions.get(permission);
    if (scope === 'SCHOOL') return {};
    if (scope === 'ASSIGNED' && auth.membershipId) {
      const membershipId = auth.membershipId;
      return {
        OR: [
          { classTeacher: { is: { membershipId } } },
          { subjects: { some: { teacher: { is: { membershipId } } } } },
        ],
      };
    }
    // No permission: match nothing. Guards should already have refused the request.
    return { id: { in: [] } };
  }

  /** Students the caller may see: everyone, or those actively enrolled in their assigned classes. */
  studentFilter(auth: AuthContext, permission: PermissionKey): Prisma.StudentWhereInput {
    const scope = auth.permissions.get(permission);
    if (scope === 'SCHOOL') return {};
    if (scope === 'ASSIGNED' && auth.membershipId) {
      return { enrollments: { some: { status: 'ACTIVE', class: this.classFilter(auth, permission) } } };
    }
    return { id: { in: [] } };
  }

  /** Guardians the caller may see: everyone, or guardians of students they may see. */
  guardianFilter(auth: AuthContext, permission: PermissionKey): Prisma.GuardianWhereInput {
    const scope = auth.permissions.get(permission);
    if (scope === 'SCHOOL') return {};
    if (scope === 'ASSIGNED') return { students: { some: { student: this.studentFilter(auth, permission) } } };
    return { id: { in: [] } };
  }

  isSchoolWide(auth: AuthContext, permission: PermissionKey): boolean {
    return auth.permissions.get(permission) === 'SCHOOL';
  }
}

@Global()
@Module({ providers: [ScopeService], exports: [ScopeService] })
export class AccessModule {}
