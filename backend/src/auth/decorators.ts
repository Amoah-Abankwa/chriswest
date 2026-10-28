import { createParamDecorator, ExecutionContext, SetMetadata, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { PermissionKey } from '../access/permissions';
import type { AuthContext } from './auth-context';

export const IS_PUBLIC = 'auth:isPublic';
export const REQUIRED_PERMISSIONS = 'auth:requiredPermissions';

/** Opts a route out of session authentication. Everything else requires a session. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const NO_ORIGIN_CHECK = 'auth:noOriginCheck';
/**
 * For the few public endpoints a native app calls before it has a token. Only safe on routes that
 * set no cookie and whose response a cross-site page couldn't read anyway (no CORS is enabled).
 */
export const NoOriginCheck = () => SetMetadata(NO_ORIGIN_CHECK, true);

/** All listed permissions are required. Resource ownership is still checked in the service. */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.auth) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Sign in to continue' });
  return req.auth;
});

/** Who is acting, for audit entries. Always taken from the verified session. */
export type Actor = { userId: string; correlationId?: string };

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.auth) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Sign in to continue' });
  return { userId: req.auth.userId, correlationId: req.correlationId };
});
