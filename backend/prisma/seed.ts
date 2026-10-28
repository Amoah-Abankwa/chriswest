import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { BUILT_IN_ROLES, grantsOf } from '../src/access/built-in-roles';
import { PERMISSIONS } from '../src/access/permissions';
import { PrismaClient } from '../src/generated/prisma/client';

// Idempotent: safe to run on every deploy. Seeds reference data only, never demo accounts.
async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL! }),
  });
  try {
    for (const p of PERMISSIONS) {
      await prisma.permission.upsert({
        where: { key: p.key },
        update: { description: p.description },
        create: p,
      });
    }
    console.log(`Seeded ${PERMISSIONS.length} permissions`);

    // Make every school's built-in roles match the current definitions exactly.
    for (const def of BUILT_IN_ROLES) {
      const grants = grantsOf(def);
      const roles = await prisma.role.findMany({ where: { key: def.key, isSystem: true }, select: { id: true, schoolId: true } });
      for (const role of roles) {
        
await prisma.$transaction(
  async (tx) => {
    await tx.role.update({
      where: { id: role.id },
      data: {
        name: def.name,
        description: def.description,
      },
    });

    await tx.rolePermission.deleteMany({
      where: {
        roleId: role.id,
        permissionKey: {
          notIn: grants.map((g) => g.key),
        },
      },
    });

    for (const grant of grants) {
      await tx.rolePermission.upsert({
        where: {
          roleId_permissionKey: {
            roleId: role.id,
            permissionKey: grant.key,
          },
        },
        create: {
          schoolId: role.schoolId,
          roleId: role.id,
          permissionKey: grant.key,
          scope: grant.scope,
        },
        update: {
          scope: grant.scope,
        },
      });
    }
  },
  {
    maxWait: 10000,
    timeout: 30000,
  },
);

      }
      console.log(`Synced built-in role "${def.name}" in ${roles.length} schools`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
