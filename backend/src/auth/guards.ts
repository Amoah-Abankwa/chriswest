import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Scope } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { normalizeHostname } from '../tenancy/hostname';
import { AccessService } from './access.service';
import { IS_PUBLIC, NO_ORIGIN_CHECK, REQUIRED_PERMISSIONS } from './decorators';
import { sessionCookieName } from './session-cookie';
import { SessionsService } from './sessions.service';

const unauthenticated = () =>
  new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Your session has ended. Sign in again.' });

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF: every state-changing request must come from a page on the same host.
 * All school subdomains share one registrable domain, so SameSite alone would let
 * one school's pages post to another's. The exact-host Origin check closes that gap.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(NO_ORIGIN_CHECK, [ctx.getHandler(), ctx.getClass()])) return true;
    // The app authenticates with an Authorization header, which browsers never attach on their own
    // (a cross-site page can't set it without a CORS preflight, and the API allows none). With no
    // cookie on the request there is nothing for a forged request to ride on, so no Origin is needed.
    if (bearerToken(req) && !req.cookies?.[sessionCookieName()]) return true;

    const source = req.get('origin') ?? req.get('referer');
    let url: URL | undefined;
    try {
      url = source ? new URL(source) : undefined;
    } catch {
      url = undefined;
    }
    const sameHost = url && normalizeHostname(url.host) === normalizeHostname(req.hostname);
    const sameScheme = url && url.protocol === `${req.protocol}:`;
    if (!sameHost || !sameScheme) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'Request origin not allowed' });
    }
    return true;
  }
}

/** Deny by default: every route needs a valid session unless marked @Public(). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const host = req.hostContext;
    const bearer = bearerToken(req);
    const token: unknown = bearer ?? req.cookies?.[sessionCookieName()];
    if (!host || typeof token !== 'string' || token.length === 0) throw unauthenticated();

    const session = await this.sessions.findValid(token);
    if (!session || session.user.status !== 'ACTIVE') throw unauthenticated();
    // A token only works the way it was issued: app tokens as bearer, browser sessions as cookies.
    if ((bearer !== undefined) !== (session.client === 'MOBILE')) throw unauthenticated();

    // A session only works on the host it was created on.
    const expectedSchoolId = host.kind === 'school' ? host.schoolId : null;
    if (session.schoolId !== expectedSchoolId) {
      await this.audit.record({
        action: 'auth.session_host_mismatch',
        outcome: 'DENIED',
        resourceType: 'session',
        resourceId: session.id,
        schoolId: expectedSchoolId,
        actorUserId: session.user.id,
        correlationId: req.correlationId,
      });
      throw unauthenticated();
    }

    let membershipId: string | null = null;
    let permissions: ReadonlyMap<string, Scope> = new Map();
    if (host.kind === 'school') {
      const schoolAccess = await this.access.loadSchoolAccess(session.user.id, host.schoolId);
      if (!schoolAccess) throw unauthenticated();
      membershipId = schoolAccess.membershipId;
      permissions = schoolAccess.permissions;
    } else if (!session.user.platformRole) {
      throw unauthenticated();
    }

    await this.sessions.touch(session.id, session.lastSeenAt);
    req.auth = {
      userId: session.user.id,
      email: session.user.email,
      fullName: session.user.fullName,
      sessionId: session.id,
      platformRole: session.user.platformRole,
      membershipId,
      permissions,
    };
    return true;
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const auth = ctx.switchToHttp().getRequest<Request>().auth;
    if (!auth || !required.every((p) => auth.permissions.has(p))) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: "You don't have permission to do this" });
    }
    return true;
  }
}

/** The app's session token from `Authorization: Bearer …`, if present. */
export function bearerToken(req: Request): string | undefined {
  const h = req.get('authorization');
  if (!h) return undefined;
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(h.trim());
  return m?.[1];
}
