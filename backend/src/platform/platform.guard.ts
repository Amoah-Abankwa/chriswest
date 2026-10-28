import { CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

type PlatformRole = 'SUPER_ADMIN' | 'SUPPORT';
const PLATFORM_ROLES = 'platform:roles';

/** Defaults to SUPER_ADMIN only. Add SUPPORT explicitly for read-only routes. */
export const PlatformRoles = (...roles: PlatformRole[]) => SetMetadata(PLATFORM_ROLES, roles);

/**
 * Platform routes exist only on the admin host. On a school host they return 404,
 * so school users can't even confirm the routes exist.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (req.hostContext?.kind !== 'platform') {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
    }
    const allowed =
      this.reflector.getAllAndOverride<PlatformRole[]>(PLATFORM_ROLES, [ctx.getHandler(), ctx.getClass()]) ?? [
        'SUPER_ADMIN',
      ];
    const role = req.auth?.platformRole;
    if (!role || !allowed.includes(role)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: "You don't have permission to do this" });
    }
    return true;
  }
}
