import { Injectable } from '@nestjs/common';
import type { Scope } from '../access/permissions';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Loads the user's active membership in one school and the union of its role permissions.
   * Runs on every request, so role removal or deactivation takes effect immediately.
   */
  async loadSchoolAccess(userId: string, schoolId: string) {
    const membership = await this.prisma.schoolMembership.findUnique({
      where: { schoolId_userId: { schoolId, userId } },
      select: {
        id: true,
        status: true,
        roles: { select: { role: { select: { permissions: { select: { permissionKey: true, scope: true } } } } } },
      },
    });
    if (!membership || membership.status !== 'ACTIVE') return null;
    // Union across roles; a school-wide grant beats an assigned-only grant of the same permission.
    const permissions = new Map<string, Scope>();
    for (const { role } of membership.roles) {
      for (const p of role.permissions) {
        if (permissions.get(p.permissionKey) !== 'SCHOOL') permissions.set(p.permissionKey, p.scope);
      }
    }
    return { membershipId: membership.id, permissions };
  }
}
