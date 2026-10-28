import { z } from 'zod';

/** Slugs are the last part of a page's address, e.g. "admissions". */
export const RESERVED_SLUGS = new Set(['news', 'events', 'contact', 'login', 'activate', 'dashboard', 'p', 'api']);
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/, { message: 'Use lowercase letters, numbers and hyphens' });
const body = z.string().max(50_000);

export const SettingsSchema = z.object({
  siteEnabled: z.boolean().optional(),
  siteTagline: z.string().trim().max(160).transform((v) => (v === '' ? null : v)).nullable().optional(),
});

export const PageSchema = z.object({
  title: z.string().trim().min(1).max(120),
  slug: slug.optional(),
  body,
  showInNav: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  seoDescription: z.string().trim().max(300).nullable().optional(),
});
export const UpdatePageSchema = PageSchema.partial();

export const PostSchema = z.object({
  kind: z.enum(['NEWS', 'EVENT']),
  title: z.string().trim().min(1).max(160),
  slug: slug.optional(),
  summary: z.string().trim().max(300).nullable().optional(),
  body,
  coverMediaId: z.uuid().nullable().optional(),
  eventStartsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  eventLocation: z.string().trim().max(160).nullable().optional(),
});
export const UpdatePostSchema = PostSchema.partial().omit({ kind: true });
export const StatusSchema = z.object({ status: z.enum(['DRAFT', 'PUBLISHED']) });

export const ContactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()).optional().or(z.literal('').transform(() => undefined)),
  phone: z.string().trim().max(30).regex(/^[+0-9 ()-]*$/).optional(),
  subject: z.string().trim().max(160).optional(),
  message: z.string().trim().min(5).max(5000),
  /** Hidden field humans leave empty. */
  website: z.string().max(200).optional(),
  /** When the form was shown (ms since epoch). Bots submit instantly. */
  startedAt: z.number().int().positive(),
});

export const MessagesQuery = z.object({
  handled: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const PostsQuery = z.object({
  kind: z.enum(['NEWS', 'EVENT']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
});

export type PageInput = z.infer<typeof PageSchema>;
export type UpdatePageInput = z.infer<typeof UpdatePageSchema>;
export type PostInput = z.infer<typeof PostSchema>;
export type UpdatePostInput = z.infer<typeof UpdatePostSchema>;
export type ContactInput = z.infer<typeof ContactSchema>;
