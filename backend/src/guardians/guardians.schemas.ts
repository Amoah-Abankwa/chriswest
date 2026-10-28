import { z } from 'zod';

const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const phone = z
  .string()
  .trim()
  .max(30)
  .regex(/^[+0-9 ()-]*$/, { message: 'Use digits, spaces, +, - and brackets only' })
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .transform((v) => (v === '' ? null : v))
  .pipe(z.email({ message: 'Enter a valid email address' }).nullable())
  .nullable()
  .optional();

export const GuardianSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone,
  email,
  occupation: optionalText(80),
  address: optionalText(200),
});
export const UpdateGuardianSchema = GuardianSchema.partial();

const RELATIONSHIPS = ['MOTHER', 'FATHER', 'GUARDIAN', 'GRANDPARENT', 'SIBLING', 'OTHER'] as const;

export const LinkGuardianSchema = z
  .object({
    guardianId: z.uuid().optional(),
    guardian: GuardianSchema.optional(),
    relationship: z.enum(RELATIONSHIPS),
    isPrimaryContact: z.boolean().default(false),
    portalAccess: z.boolean().default(true),
  })
  .refine((v) => Boolean(v.guardianId) !== Boolean(v.guardian), {
    message: 'Choose an existing parent or enter a new one',
  });

export const UpdateLinkSchema = z.object({
  relationship: z.enum(RELATIONSHIPS).optional(),
  isPrimaryContact: z.boolean().optional(),
  portalAccess: z.boolean().optional(),
});

export const ListGuardiansQuery = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type GuardianInput = z.infer<typeof GuardianSchema>;
export type UpdateGuardianInput = z.infer<typeof UpdateGuardianSchema>;
export type LinkGuardianInput = z.infer<typeof LinkGuardianSchema>;
export type UpdateLinkInput = z.infer<typeof UpdateLinkSchema>;
export type ListGuardiansInput = z.infer<typeof ListGuardiansQuery>;
