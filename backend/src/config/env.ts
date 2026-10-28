import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),
  /** The school's address, e.g. portal.myschool.edu.gh. Staff, parents and students sign in here. */
  SCHOOL_HOST: z.string().min(1).transform((h) => h.trim().toLowerCase()),
  /**
   * Development only, for testing the mobile app on a phone: listen on all network interfaces and
   * treat these extra addresses (e.g. your computer's Wi-Fi IP) as the school. Refused in production.
   */
  DEV_LISTEN_ALL: z.enum(['true', 'false']).default('false'),
  DEV_SCHOOL_HOST_ALIASES: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)),
  /** The super admin's address, e.g. admin.myschool.edu.gh. Must differ from SCHOOL_HOST. */
  PLATFORM_ADMIN_HOST: z.string().min(1).transform((h) => h.trim().toLowerCase()),
  TRUST_PROXY: z.string().default('loopback'),
  /** How links in emails are built: {scheme}://{hostname}[:{port}] */
  PORTAL_URL_SCHEME: z.enum(['http', 'https']).default('https'),
  PORTAL_URL_PORT: z.coerce.number().int().positive().optional(),
  /** local: files on this server's disk (development, or a single VPS with backups). s3: S3-compatible storage such as Supabase Storage. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true'),
  /** dev: print emails to the console (development) or discard them (tests). resend or smtp: send for real. */
  MAIL_DRIVER: z.enum(['dev', 'resend', 'smtp']).default('dev'),
  /** Resend API key (starts with re_). Use a "sending access" key restricted to your domain. */
  RESEND_API_KEY: z.string().optional(),
  /** Requests per second per worker process. Resend's default limit is 2 per second per team. */
  RESEND_MAX_PER_SECOND: z.coerce.number().positive().max(100).default(2),
  MAIL_FROM: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** 32 random bytes, base64. Encrypts two-step sign-in secrets. Generate: openssl rand -base64 32 */
  MFA_ENCRYPTION_KEY: z.string().optional(),
  /** How long audit records are kept (default 7 years, to cover financial record-keeping). */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(365).default(2555),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validates once at startup. Fails fast without printing secret values. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid or missing environment variables: ${missing}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.PORTAL_URL_SCHEME !== 'https') {
    throw new Error('PORTAL_URL_SCHEME must be https in production');
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.MAIL_DRIVER === 'dev') {
    throw new Error('MAIL_DRIVER must be resend or smtp in production, otherwise invitations and notifications are never delivered');
  }
  if (parsed.data.MAIL_DRIVER === 'resend') {
    const missing = (['RESEND_API_KEY', 'MAIL_FROM'] as const).filter((k) => !parsed.data[k]);
    if (missing.length) throw new Error(`MAIL_DRIVER=resend needs: ${missing.join(', ')}`);
    if (!parsed.data.RESEND_API_KEY!.startsWith('re_')) throw new Error('RESEND_API_KEY should start with re_');
  }
  if (parsed.data.NODE_ENV === 'production' && (parsed.data.DEV_LISTEN_ALL === 'true' || parsed.data.DEV_SCHOOL_HOST_ALIASES.length)) {
    throw new Error('DEV_LISTEN_ALL and DEV_SCHOOL_HOST_ALIASES are for development only');
  }
  if (parsed.data.SCHOOL_HOST === parsed.data.PLATFORM_ADMIN_HOST) {
    throw new Error('SCHOOL_HOST and PLATFORM_ADMIN_HOST must be different addresses');
  }
  if (parsed.data.NODE_ENV === 'production' && (!parsed.data.MFA_ENCRYPTION_KEY || Buffer.from(parsed.data.MFA_ENCRYPTION_KEY, 'base64').length !== 32)) {
    throw new Error('MFA_ENCRYPTION_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)');
  }
  if (parsed.data.MAIL_DRIVER === 'smtp') {
    const missing = (['SMTP_HOST', 'MAIL_FROM'] as const).filter((k) => !parsed.data[k]);
    if (missing.length) throw new Error(`MAIL_DRIVER=smtp needs: ${missing.join(', ')}`);
  }
  if (parsed.data.STORAGE_DRIVER === 's3') {
    const missing = (['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const).filter((k) => !parsed.data[k]);
    if (missing.length) throw new Error(`STORAGE_DRIVER=s3 needs: ${missing.join(', ')}`);
  }
  cached = parsed.data;
  return cached;
}
