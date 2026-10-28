import { z } from 'zod';
import { IsoDate } from '../common/dates';

export const STATUSES = ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'] as const;

export const ClassesQuery = z.object({ date: IsoDate.optional() });
export const RegisterQuery = z.object({ classId: z.uuid(), date: IsoDate.optional() });

export const SaveRegisterSchema = z.object({
  classId: z.uuid(),
  date: IsoDate,
  records: z
    .array(
      z.object({
        studentId: z.uuid(),
        status: z.enum(STATUSES),
        note: z.string().trim().max(200).transform((v) => (v === '' ? null : v)).nullable().optional(),
      }),
    )
    .min(1, { message: 'Mark at least one student' })
    .max(200)
    .refine((rs) => new Set(rs.map((r) => r.studentId)).size === rs.length, { message: 'Each student can only appear once' }),
  /** Required when changing a register after its day. */
  reason: z.string().trim().min(3, { message: 'Give a short reason' }).max(500).optional(),
});

export const RangeQuery = z.object({ from: IsoDate.optional(), to: IsoDate.optional() });
export const SummaryQuery = RangeQuery.extend({ classId: z.uuid() });

export type SaveRegisterInput = z.infer<typeof SaveRegisterSchema>;
export type RangeInput = z.infer<typeof RangeQuery>;
export type SummaryInput = z.infer<typeof SummaryQuery>;
