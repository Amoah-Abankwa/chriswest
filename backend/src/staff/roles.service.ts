import { Injectable } from '@nestjs/common';
import { assertCanGrantAll, canGrantAll, type Grant } from '../access/delegation';
import { PERMISSIONS, SCOPABLE, permissionArea, type PermissionKey, type Scope } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
import type { AuthContext } from '../auth/auth-context';
import { badRequest, conflict, isUniqueViolation, notFound } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { auditHistory } from './audit-history';
import type { RoleInput, UpdateRoleInput } from './staff.schemas';

export type StaffActor = { auth: AuthContext; correlationId?: string };

const ROLE = {
  id: true,
  key: true,
  name: true,
  description: true,
  isSystem: true,
  permissions: { select: { permissionKey: true, scope: true }, orderBy: { permissionKey: 'asc' } },
  _count: { select: { members: true } },
} as const;

const grantsOf = (role: { permissions: { permissionKey: string; scope: Scope }[] }): Grant[] =>
  role.permissions.map((p) => ({ key: p.permissionKey, scope: p.scope }));

function assertScopesValid(grants: Grant[]) {
  const invalid = grants.filter((g) => g.scope === 'ASSIGNED' && !SCOPABLE.has(g.key as PermissionKey));
  if (invalid.length > 0) {
    throw badRequest('SCOPE_NOT_ALLOWED', `These permissions can't be limited to assigned classes: ${invalid.map((g) => g.key).join(', ')}`);
  }
}

const roleKey = (name: string) =>
  `custom-${name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}-${Date.now().toString(36)}`;

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The catalog, with how widely the caller could grant each permission. */
  catalog(auth: AuthContext) {
    return {
      data: PERMISSIONS.map((p) => ({
        key: p.key,
        description: p.description,
        area: permissionArea(p.key),
        scopable: SCOPABLE.has(p.key),
        maxScope: auth.permissions.get(p.key) ?? null,
      })),
    };
  }

  async list(schoolId: string, auth: AuthContext) {
    const roles = await this.prisma.role.findMany({
      where: { schoolId },
      select: ROLE,
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return { data: roles.map((r) => this.toDto(r, auth)) };
  }

  async get(schoolId: string, id: string, auth: AuthContext) {
    const role = await this.prisma.role.findUnique({ where: { schoolId_id: { schoolId, id } }, select: ROLE });
    if (!role) throw notFound('Role not found');
    return { data: this.toDto(role, auth) };
  }

  async create(schoolId: string, input: RoleInput, actor: StaffActor) {
    const grants: Grant[] = input.permissions;
    assertScopesValid(grants);
    assertCanGrantAll(actor.auth.permissions, grants);
    try {
      const role = await this.prisma.$transaction(async (tx) => {
        const created = await tx.role.create({
          data: { schoolId, key: roleKey(input.name), name: input.name, description: input.description ?? null },
          select: { id: true },
        });
        await tx.rolePermission.createMany({
          data: grants.map((g) => ({ schoolId, roleId: created.id, permissionKey: g.key, scope: g.scope })),
        });
        return created;
      });
      await this.log('role.create', schoolId, role.id, actor, { name: input.name, permissions: grants.map((g) => `${g.key}:${g.scope}`) });
      return this.get(schoolId, role.id, actor.auth);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'A role with this name already exists.');
      throw err;
    }
  }

  async update(schoolId: string, id: string, input: UpdateRoleInput, actor: StaffActor) {
    const role = await this.prisma.role.findUnique({ where: { schoolId_id: { schoolId, id } }, select: ROLE });
    if (!role) throw notFound('Role not found');
    if (role.isSystem) throw conflict('SYSTEM_ROLE', "Built-in roles can't be changed. Create a custom role instead.");

    const before = grantsOf(role);
    // You can't edit a role that's more powerful than you.
    assertCanGrantAll(actor.auth.permissions, before, "You can't change a role that has permissions you don't have.");

    let diff: { added: string[]; removed: string[]; rescoped: string[] } | undefined;
    if (input.permissions) {
      const after: Grant[] = input.permissions;
      assertScopesValid(after);
      assertCanGrantAll(actor.auth.permissions, after);
      const beforeMap = new Map(before.map((g) => [g.key, g.scope]));
      const afterMap = new Map(after.map((g) => [g.key, g.scope]));
      diff = {
        added: after.filter((g) => !beforeMap.has(g.key)).map((g) => g.key),
        removed: before.filter((g) => !afterMap.has(g.key)).map((g) => g.key),
        rescoped: after.filter((g) => beforeMap.has(g.key) && beforeMap.get(g.key) !== g.scope).map((g) => `${g.key}:${g.scope}`),
      };
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.role.update({
          where: { id },
          data: { name: input.name, description: input.description === undefined ? undefined : input.description },
        });
        if (input.permissions) {
          await tx.rolePermission.deleteMany({ where: { roleId: id } });
          await tx.rolePermission.createMany({
            data: input.permissions.map((g) => ({ schoolId, roleId: id, permissionKey: g.key, scope: g.scope })),
          });
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'A role with this name already exists.');
      throw err;
    }
    await this.log('role.update', schoolId, id, actor, { ...(input.name ? { name: input.name } : {}), ...(diff ?? {}) });
    return this.get(schoolId, id, actor.auth);
  }

  async remove(schoolId: string, id: string, actor: StaffActor) {
    const role = await this.prisma.role.findUnique({ where: { schoolId_id: { schoolId, id } }, select: ROLE });
    if (!role) throw notFound('Role not found');
    if (role.isSystem) throw conflict('SYSTEM_ROLE', "Built-in roles can't be deleted.");
    if (role._count.members > 0) throw conflict('ROLE_IN_USE', 'Remove this role from everyone who has it first.');
    assertCanGrantAll(actor.auth.permissions, grantsOf(role), "You can't delete a role that has permissions you don't have.");
    await this.prisma.role.delete({ where: { id } });
    await this.log('role.delete', schoolId, id, actor, { name: role.name });
  }

  async history(schoolId: string, id: string) {
    const exists = await this.prisma.role.findUnique({ where: { schoolId_id: { schoolId, id } }, select: { id: true } });
    if (!exists) throw notFound('Role not found');
    return { data: await auditHistory(this.prisma, schoolId, 'role', id) };
  }

  private toDto(role: { id: string; key: string; name: string; description: string | null; isSystem: boolean; permissions: { permissionKey: string; scope: Scope }[]; _count: { members: number } }, auth: AuthContext) {
    const grants = grantsOf(role);
    const canAssign = canGrantAll(auth.permissions, grants);
    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      memberCount: role._count.members,
      permissions: grants,
      canAssign,
      canEdit: !role.isSystem && canAssign && auth.permissions.has('roles.manage'),
    };
  }

  private log(action: string, schoolId: string, resourceId: string, actor: StaffActor, summary: Prisma.InputJsonObject) {
    return this.audit.record({
      action,
      outcome: 'SUCCESS',
      resourceType: 'role',
      resourceId,
      schoolId,
      actorUserId: actor.auth.userId,
      summary,
      correlationId: actor.correlationId,
    });
  }
}

