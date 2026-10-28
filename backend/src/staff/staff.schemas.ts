import { z } from 'zod';
import { PERMISSION_KEYS } from '../access/permissions';

const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();

const email = z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'Enter a valid email address' }));
const roleIds = z
  .array(z.uuid())
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Each role can only be listed once' });

export const ListStaffQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  roleId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const InviteStaffSchema = z.object({
  email,
  fullName: z.string().trim().min(2).max(120).optional(),
  jobTitle: optionalText(80),
  staffNumber: optionalText(30),
  phone: optionalText(30),
  roleIds: roleIds.min(1, { message: 'Choose at least one role' }),
});

export const UpdateStaffSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  jobTitle: optionalText(80),
  staffNumber: optionalText(30),
  phone: optionalText(30),
});

export const SetRolesSchema = z.object({ roleIds });
export const ReasonSchema = z.object({ reason: z.string().trim().min(3, { message: 'Give a short reason' }).max(500) });

export const RoleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: optionalText(200),
  permissions: z
    .array(z.object({ key: z.enum(PERMISSION_KEYS), scope: z.enum(['SCHOOL', 'ASSIGNED']).default('SCHOOL') }))
    .min(1, { message: 'Choose at least one permission' })
    .refine((ps) => new Set(ps.map((p) => p.key)).size === ps.length, { message: 'Each permission can only be listed once' }),
});
export const UpdateRoleSchema = RoleSchema.partial();

export type ListStaffInput = z.infer<typeof ListStaffQuery>;
export type InviteStaffInput = z.infer<typeof InviteStaffSchema>;
export type UpdateStaffInput = z.infer<typeof UpdateStaffSchema>;
export type RoleInput = z.infer<typeof RoleSchema>;
export type UpdateRoleInput = z.infer<typeof UpdateRoleSchema>;
