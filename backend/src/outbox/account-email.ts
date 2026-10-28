import { randomUUID } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client';
import { enqueue } from './outbox';

export type AccountEmailAudience = 'MANAGER' | 'STAFF' | 'PARENT' | 'STUDENT';
export type AccountEmailPayload = {
  userId: string;
  /** Null for platform accounts (super admins). */
  schoolId: string | null;
  template: 'INVITE' | 'RESET';
  audience?: AccountEmailAudience;
};

/**
 * Queues an invitation or password-reset email. The one-time link is created by the worker at the
 * moment of sending, so no secret ever sits in the queue, and each retry gets a fresh link.
 */
export function queueAccountEmail(tx: Prisma.TransactionClient, payload: AccountEmailPayload) {
  return enqueue(tx, [
    {
      schoolId: payload.schoolId,
      type: 'account.email',
      payload: { ...payload },
      dedupeKey: `account.email:${payload.template}:${payload.userId}:${randomUUID()}`,
    },
  ]);
}
