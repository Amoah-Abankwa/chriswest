import type { Prisma } from '../generated/prisma/client';

export type OutboxEventInput = {
  schoolId: string | null;
  type: string;
  payload: Prisma.InputJsonObject;
  dedupeKey: string;
  /** Delay before the worker may process it. */
  delayMs?: number;
};

/**
 * Queue events inside the caller's transaction. Duplicates (same dedupeKey) are ignored.
 * Delays use real time, not the app clock, because they're about how long to wait.
 */
export async function enqueue(tx: Prisma.TransactionClient, events: OutboxEventInput[]) {
  const now = new Date();
  if (events.length === 0) return;
  await tx.outboxEvent.createMany({
    data: events.map((e) => ({
      schoolId: e.schoolId,
      type: e.type,
      payload: e.payload,
      dedupeKey: e.dedupeKey,
      availableAt: new Date(now.getTime() + (e.delayMs ?? 0)),
    })),
    skipDuplicates: true,
  });
}
