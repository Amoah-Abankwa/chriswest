import type { CookieOptions } from 'express';
import { getEnv } from '../config/env';

/**
 * Production uses the __Host- prefix: Secure, Path=/, and no Domain attribute, so the browser
 * only ever sends a school's cookie back to that exact school hostname.
 */
export function sessionCookieName(): string {
  return getEnv().NODE_ENV === 'production' ? '__Host-sid' : 'sid';
}

export function sessionCookieOptions(expiresAt?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: getEnv().NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}
