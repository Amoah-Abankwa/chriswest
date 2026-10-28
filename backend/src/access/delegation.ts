import { ForbiddenException } from '@nestjs/common';
import type { Scope } from './permissions';

export type Grant = { key: string; scope: Scope };

/** You can only hand out what you hold, at no wider scope than you hold it. */
export function canGrant(actor: ReadonlyMap<string, Scope>, grant: Grant): boolean {
  const mine = actor.get(grant.key);
  if (!mine) return false;
  return mine === 'SCHOOL' || grant.scope === 'ASSIGNED';
}

export const canGrantAll = (actor: ReadonlyMap<string, Scope>, grants: Grant[]) => grants.every((g) => canGrant(actor, g));

export function assertCanGrantAll(actor: ReadonlyMap<string, Scope>, grants: Grant[], message?: string) {
  const denied = [...new Set(grants.filter((g) => !canGrant(actor, g)).map((g) => g.key))];
  if (denied.length > 0) {
    throw new ForbiddenException({
      code: 'DELEGATION_DENIED',
      message: message ?? 'You can only give out permissions you have yourself.',
      details: { permissions: denied },
    });
  }
}
