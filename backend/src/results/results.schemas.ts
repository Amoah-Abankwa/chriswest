import { z } from 'zod';

const key = { termId: z.uuid(), classId: z.uuid(), subjectId: z.uuid() };
export const SheetKey = z.object(key);
const reason = z.string().trim().min(3, { message: 'Give a short reason' }).max(500);

/** Up to one decimal place, e.g. 17.5 */
const score = z
  .number()
  .min(0)
  .max(1000)
  .refine((n) => Math.round(n * 10) === n * 10, { message: 'Use at most one decimal place' });

const markValue = z
  .object({ studentId: z.uuid(), assessmentId: z.uuid(), score: score.nullable().default(null), absent: z.boolean().default(false) })
  .refine((m) => !(m.absent && m.score !== null), { message: 'A student marked absent can’t also have a score' });

export const SaveMarksSchema = z.object({
  ...key,
  marks: z
    .array(markValue)
    .min(1)
    .max(2000)
    .refine((ms) => new Set(ms.map((m) => `${m.studentId}:${m.assessmentId}`)).size === ms.length, { message: 'Each mark can only appear once' }),
});

export const ReturnSchema = z.object({ ...key, reason });
export const CorrectSchema = z
  .object({ ...key, studentId: z.uuid(), assessmentId: z.uuid(), score: score.nullable().default(null), absent: z.boolean().default(false), reason })
  .refine((m) => m.absent !== (m.score !== null), { message: 'Give a score, or mark the student absent' });

export const PublishSchema = z.object({ termId: z.uuid(), classId: z.uuid() });
export const SheetsQuery = z.object({ termId: z.uuid(), classId: z.uuid().optional() });
export const TermQuery = z.object({ termId: z.uuid() });
export const ClassReportQuery = z.object({ termId: z.uuid(), classId: z.uuid() });

export const AssessmentsSchema = z.object({
  termId: z.uuid(),
  components: z
    .array(
      z.object({
        id: z.uuid().optional(),
        name: z.string().trim().min(1).max(60),
        maxMarks: z.number().int().min(1).max(1000),
        weight: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .max(10)
    .refine((cs) => cs.reduce((n, c) => n + c.weight, 0) === 100, { message: 'The weights must add up to 100%' })
    .refine((cs) => new Set(cs.map((c) => c.name.toLowerCase())).size === cs.length, { message: 'Each assessment needs a different name' }),
});

export const BandsSchema = z.object({
  bands: z
    .array(z.object({ minPercent: z.number().int().min(0).max(100), grade: z.string().trim().min(1).max(10), remark: z.string().trim().max(60) }))
    .min(2)
    .max(15),
});

export type SheetKeyInput = z.infer<typeof SheetKey>;
export type SaveMarksInput = z.infer<typeof SaveMarksSchema>;
export type CorrectInput = z.infer<typeof CorrectSchema>;
export type AssessmentsInput = z.infer<typeof AssessmentsSchema>;
