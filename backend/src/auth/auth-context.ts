import type { Scope } from '../access/permissions';

export type AuthContext = {
  userId: string;
  email: string;
  fullName: string | null;
  sessionId: string;
  platformRole: 'SUPER_ADMIN' | 'SUPPORT' | null;
  /** Null on the platform admin host. */
  membershipId: string | null;
  /** Permission key -> scope. A key present at all means the permission is held. */
  permissions: ReadonlyMap<string, Scope>;
};
