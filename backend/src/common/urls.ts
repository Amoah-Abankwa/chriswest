import { getEnv } from '../config/env';

/** Builds a link to a portal from a trusted hostname (never from the request's Host header). */
export function portalOrigin(hostname: string): string {
  const { PORTAL_URL_SCHEME, PORTAL_URL_PORT } = getEnv();
  return `${PORTAL_URL_SCHEME}://${hostname}${PORTAL_URL_PORT ? `:${PORTAL_URL_PORT}` : ''}`;
}

export const portalUrl = (hostname: string, path: string) => `${portalOrigin(hostname)}${path}`;
