import { z } from 'zod';
import { IsoDate } from '../common/dates';

const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const name = z.string().trim().min(1, { message: 'Required' }).max(80);
const reason = z.string().trim().min(3, { message: 'Give a short reason' }).max(500);

export const ListStudentsQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'WITHDRAWN', 'GRADUATED', 'INACTIVE']).optional(),
  classId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const AdmitStudentSchema = z.object({
  firstName: name,
  lastName: name,
  otherNames: optionalText(80),
  dateOfBirth: IsoDate.nullable().optional(),
  sex: z.enum(['FEMALE', 'MALE']).nullable().optional(),
  admissionDate: IsoDate.optional(),
  /** Leave out to generate one. */
  admissionNumber: z.string().trim().min(1).max(30).optional(),
  previousSchool: optionalText(120),
  homeAddress: optionalText(200),
  /** Enroll straight into a class of the current year. */
  classId: z.uuid().optional(),
  /** Set after the user has seen and dismissed a possible-duplicate warning. */
  confirmDuplicate: z.boolean().default(false),
});

export const UpdateStudentSchema = z.object({
  firstName: name.optional(),
  lastName: name.optional(),
  otherNames: optionalText(80),
  dateOfBirth: IsoDate.nullable().optional(),
  sex: z.enum(['FEMALE', 'MALE']).nullable().optional(),
  admissionNumber: z.string().trim().min(1).max(30).optional(),
  previousSchool: optionalText(120),
  homeAddress: optionalText(200),
  /** Required when correcting names, date of birth or admission number. */
  reason: reason.optional(),
});

export const EnrollSchema = z.object({ classId: z.uuid(), startDate: IsoDate.optional() });
export const TransferSchema = z.object({ classId: z.uuid(), reason, date: IsoDate.optional() });
export const WithdrawSchema = z.object({ status: z.enum(['WITHDRAWN', 'GRADUATED']), reason, date: IsoDate.optional() });
export const UploadDocumentSchema = z.object({
  kind: z.enum(['BIRTH_CERTIFICATE', 'PHOTO', 'PREVIOUS_REPORT', 'MEDICAL', 'OTHER']),
  note: optionalText(200),
});

export type ListStudentsInput = z.infer<typeof ListStudentsQuery>;
export type AdmitStudentInput = z.infer<typeof AdmitStudentSchema>;
export type UpdateStudentInput = z.infer<typeof UpdateStudentSchema>;
export type EnrollInput = z.infer<typeof EnrollSchema>;
export type TransferInput = z.infer<typeof TransferSchema>;
export type WithdrawInput = z.infer<typeof WithdrawSchema>;
export type UploadDocumentInput = z.infer<typeof UploadDocumentSchema>;
