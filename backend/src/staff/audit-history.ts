import type { PrismaService } from '../prisma/prisma.service';

/** Recent audit entries for one resource, with the actor's name attached. */
export async function auditHistory(prisma: PrismaService, schoolId: string, resourceType: string, resourceId: string) {
  const entries = await prisma.auditLog.findMany({
    where: { schoolId, resourceType, resourceId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, action: true, outcome: true, createdAt: true, summary: true, actorUserId: true },
  });
  const actorIds = [...new Set(entries.flatMap((e) => (e.actorUserId ? [e.actorUserId] : [])))];
  const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true, fullName: true } });
  const byId = new Map(actors.map((a) => [a.id, a.fullName ?? a.email]));
  return entries.map(({ actorUserId, ...e }) => ({ ...e, actor: actorUserId ? (byId.get(actorUserId) ?? 'Unknown') : 'System' }));
}
