import type { Prisma } from '../generated/prisma/client';

/** Atomically increments and returns a per-school counter, e.g. "invoice:2026". */
export async function nextCounter(tx: Prisma.TransactionClient, schoolId: string, key: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO school_counters ("schoolId", key, value) VALUES (${schoolId}::uuid, ${key}, 1)
    ON CONFLICT ("schoolId", key) DO UPDATE SET value = school_counters.value + 1
    RETURNING value`;
  return row!.value;
}

export const formatNumber = (prefix: string, year: number, n: number) => `${prefix}-${year}-${String(n).padStart(6, '0')}`;
