// Platform names a school can never claim as its slug.
export const RESERVED_SLUGS = new Set([
  'www', 'admin', 'api', 'app', 'auth', 'support', 'billing', 'mail',
  'status', 'docs', 'help', 'static', 'assets', 'cdn', 'dashboard', 'login',
]);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lower-cases, strips port and trailing dot, rejects anything that isn't a valid hostname. */
export function normalizeHostname(raw: string | undefined): string | null {
  if (!raw) return null;
  let host = raw.trim().toLowerCase();
  if (host.startsWith('[')) return null; // IPv6 literal
  host = host.replace(/:\d+$/, '').replace(/\.$/, '');
  if (host.length === 0 || host.length > 253) return null;
  return host.split('.').every((l) => LABEL.test(l)) ? host : null;
}

export function isValidSchoolSlug(slug: string): boolean {
  return LABEL.test(slug) && !RESERVED_SLUGS.has(slug);
}
