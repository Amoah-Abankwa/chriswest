import { z } from 'zod';

const reason = z.string().trim().min(3, { message: 'Give a short reason' }).max(500);
const email = z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'Enter a valid email address' }));
const fullName = z.string().trim().min(2).max(120).optional();

export const CreateSchoolSchema = z.object({
  name: z.string().trim().min(2).max(120),
  timezone: z
    .string()
    .default('Africa/Accra')
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
    ),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, { message: 'Use a 3-letter currency code, e.g. GHS' }).default('GHS'),
  ownerName: fullName,
  ownerEmail: email,
});

export const AddOwnerSchema = z.object({ email, fullName });

/** Suspending takes the whole system offline for everyone at the school (e.g. during an incident). */
export const ChangeStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason });

export type CreateSchoolInput = z.infer<typeof CreateSchoolSchema>;
export type AddOwnerInput = z.infer<typeof AddOwnerSchema>;
export type ChangeStatusInput = z.infer<typeof ChangeStatusSchema>;
