import { z } from 'zod';
import { IsoDate } from '../common/dates';

const name = (max = 80) => z.string().trim().min(1, { message: 'Enter a name' }).max(max);
const uuid = z.uuid();

export const STAGES = ['CRECHE', 'NURSERY', 'KINDERGARTEN', 'PRIMARY', 'JHS'] as const;

export const CreateYearSchema = z.object({ name: name(40), startDate: IsoDate, endDate: IsoDate });
export const UpdateYearSchema = CreateYearSchema.partial();
export const ActivateYearSchema = z.object({ closeCurrent: z.boolean().default(false) });

export const CreateTermSchema = z.object({ name: name(40), startDate: IsoDate, endDate: IsoDate });
export const UpdateTermSchema = CreateTermSchema.partial();

export const CreateLevelSchema = z.object({
  name: name(60),
  stage: z.enum(STAGES),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});
export const UpdateLevelSchema = z.object({
  name: name(60).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  isActive: z.boolean().optional(),
});
export const AddStandardLevelsSchema = z.object({ stages: z.array(z.enum(STAGES)).min(1) });

const subjectCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{1,12}$/, { message: 'Use up to 12 letters, numbers or hyphens' });

export const CreateSubjectSchema = z.object({ name: name(80), code: subjectCode });
export const UpdateSubjectSchema = z.object({
  name: name(80).optional(),
  code: subjectCode.optional(),
  isActive: z.boolean().optional(),
});

export const ListClassesQuery = z.object({ academicYearId: uuid.optional() });
export const CreateClassSchema = z.object({
  academicYearId: uuid,
  levelId: uuid,
  name: name(60),
  capacity: z.number().int().min(1).max(500).nullable().optional(),
});
export const UpdateClassSchema = z.object({
  levelId: uuid.optional(),
  name: name(60).optional(),
  capacity: z.number().int().min(1).max(500).nullable().optional(),
});
export const SetClassTeacherSchema = z.object({ membershipId: uuid.nullable() });
export const SetClassSubjectsSchema = z.object({
  subjects: z
    .array(z.object({ subjectId: uuid, teacherMembershipId: uuid.nullable().default(null) }))
    .max(40)
    .refine((items) => new Set(items.map((i) => i.subjectId)).size === items.length, {
      message: 'Each subject can only be listed once',
    }),
});

export type CreateYearInput = z.infer<typeof CreateYearSchema>;
export type UpdateYearInput = z.infer<typeof UpdateYearSchema>;
export type CreateTermInput = z.infer<typeof CreateTermSchema>;
export type UpdateTermInput = z.infer<typeof UpdateTermSchema>;
export type CreateLevelInput = z.infer<typeof CreateLevelSchema>;
export type UpdateLevelInput = z.infer<typeof UpdateLevelSchema>;
export type CreateSubjectInput = z.infer<typeof CreateSubjectSchema>;
export type UpdateSubjectInput = z.infer<typeof UpdateSubjectSchema>;
export type CreateClassInput = z.infer<typeof CreateClassSchema>;
export type UpdateClassInput = z.infer<typeof UpdateClassSchema>;
export type SetClassSubjectsInput = z.infer<typeof SetClassSubjectsSchema>;
export type Stage = (typeof STAGES)[number];
