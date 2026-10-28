import { z } from 'zod';
import { IsoDate } from '../common/dates';

/** Whole minor units (pesewas). Up to 10 million cedis per amount. */
export const Money = z.number().int({ message: 'Use whole pesewas' }).positive({ message: 'Enter an amount above zero' }).max(1_000_000_000);
const reason = z.string().trim().min(3, { message: 'Give a short reason' }).max(500);
const page = { page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) };

export const CategorySchema = z.object({ name: z.string().trim().min(2).max(60) });
export const UpdateCategorySchema = z.object({ name: z.string().trim().min(2).max(60).optional(), isActive: z.boolean().optional() });

const items = z
  .array(z.object({ categoryId: z.uuid(), description: z.string().trim().max(120).optional(), amountMinor: Money }))
  .min(1, { message: 'Add at least one fee' })
  .max(30);

export const StructureSchema = z.object({
  termId: z.uuid(),
  levelId: z.uuid(),
  name: z.string().trim().min(2).max(80),
  dueDate: IsoDate.nullable().optional(),
  items: items.refine((xs) => new Set(xs.map((i) => i.categoryId)).size === xs.length, { message: 'Each category can only appear once' }),
});
export const UpdateStructureSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  dueDate: IsoDate.nullable().optional(),
  items: StructureSchema.shape.items.optional(),
});
export const StructuresQuery = z.object({ termId: z.uuid().optional() });

export const InvoiceSchema = z.object({ studentId: z.uuid(), termId: z.uuid(), dueDate: IsoDate.nullable().optional(), items });
export const InvoicesQuery = z.object({
  studentId: z.uuid().optional(),
  termId: z.uuid().optional(),
  status: z.enum(['ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID']).optional(),
  search: z.string().trim().max(100).optional(),
  ...page,
});
export const AdjustmentSchema = z.object({ kind: z.enum(['DISCOUNT', 'WAIVER', 'CHARGE']), amountMinor: Money, reason });
export const VoidSchema = z.object({ reason });

export const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CARD', 'CHEQUE', 'OTHER'] as const;
export const PaymentSchema = z.object({
  studentId: z.uuid(),
  amountMinor: Money,
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(80).transform((v) => (v === '' ? null : v)).nullable().optional(),
  receivedOn: IsoDate,
  payerName: z.string().trim().max(120).transform((v) => (v === '' ? null : v)).nullable().optional(),
  note: z.string().trim().max(200).transform((v) => (v === '' ? null : v)).nullable().optional(),
  /** Leave out to pay the oldest invoices first. */
  allocations: z
    .array(z.object({ invoiceId: z.uuid(), amountMinor: Money }))
    .min(1)
    .max(20)
    .refine((xs) => new Set(xs.map((x) => x.invoiceId)).size === xs.length, { message: 'Each invoice can only appear once' })
    .optional(),
});
export const PaymentsQuery = z.object({
  studentId: z.uuid().optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  ...page,
});
export const ReversalSchema = z.object({ reason });
export const ReportQuery = z.object({ termId: z.uuid() });
export const ArrearsQuery = z.object({ termId: z.uuid(), classId: z.uuid().optional(), ...page });
export const IdempotencyKey = z.string().trim().min(8).max(100);

export type StructureInput = z.infer<typeof StructureSchema>;
export type UpdateStructureInput = z.infer<typeof UpdateStructureSchema>;
export type InvoiceInput = z.infer<typeof InvoiceSchema>;
export type InvoicesInput = z.infer<typeof InvoicesQuery>;
export type AdjustmentInput = z.infer<typeof AdjustmentSchema>;
export type PaymentInput = z.infer<typeof PaymentSchema>;
export type PaymentsInput = z.infer<typeof PaymentsQuery>;
export type ArrearsInput = z.infer<typeof ArrearsQuery>;
