import { z } from 'zod';

const email = z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'Enter a valid email address' }));
const token = z.string().min(20).max(200);
const newPassword = z
  .string()
  .min(12, { message: 'Use at least 12 characters' })
  .max(128, { message: 'Use at most 128 characters' });

// Login deliberately doesn't enforce the password policy, so errors don't hint at it.
export const LoginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
  /** Authenticator code or recovery code, for accounts with two-step sign-in. */
  code: z.string().trim().max(20).optional(),
});
export const MfaCodeSchema = z.object({ code: z.string().trim().min(6).max(20) });
export const MfaDisableSchema = z.object({ password: z.string().min(1).max(128), code: z.string().trim().min(6).max(20) });
export const ForgotPasswordSchema = z.object({ email });
export const SetPasswordSchema = z.object({ token, password: newPassword });

export const ActivateSchema = SetPasswordSchema.extend({
  fullName: z.string().trim().min(2, { message: 'Enter your full name' }).max(120).optional(),
});

export type ActivateInput = z.infer<typeof ActivateSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type SetPasswordInput = z.infer<typeof SetPasswordSchema>;
