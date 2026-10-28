import type { AuthContext } from '../auth/auth-context';
import type { HostContext } from '../tenancy/host-context';

declare module 'express-serve-static-core' {
  interface Request {
    correlationId?: string;
    /** Set only by TenantResolverMiddleware from the trusted domain registry. */
    hostContext?: HostContext;
    /** Set only by SessionGuard after session, membership and permissions are verified. */
    auth?: AuthContext;
  }
}
