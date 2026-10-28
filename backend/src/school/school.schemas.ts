import { z } from 'zod';

const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();

export const UpdateSchoolSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  motto: optionalText(200),
  addressLine: optionalText(200),
  city: optionalText(100),
  region: optionalText(100),
  phone: z
    .string()
    .trim()
    .max(30)
    .regex(/^[+0-9 ()-]*$/, { message: 'Use digits, spaces, +, - and brackets only' })
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  contactEmail: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .transform((v) => (v === '' ? null : v))
    .pipe(z.email({ message: 'Enter a valid email address' }).nullable())
    .nullable()
    .optional(),
  admissionNumberPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{0,8}$/, { message: 'Use up to 8 letters or numbers' })
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  attendanceCorrectionDays: z.number().int().min(0).max(60).optional(),
  notifyAbsence: z.boolean().optional(),
  studentPortalFees: z.boolean().optional(),
  libraryMaxLoans: z.number().int().min(1).max(20).optional(),
  libraryLoanDays: z.number().int().min(1).max(120).optional(),
  timezone: z
    .string()
    .refine(
      (tz) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Choose a valid time zone' },
    )
    .optional(),
});

export type UpdateSchoolInput = z.infer<typeof UpdateSchoolSchema>;
