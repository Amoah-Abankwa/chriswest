import type { Actor } from '../auth/decorators';
import type { AuditService } from '../audit/audit.service';
import { fromDbDate } from '../common/dates';
import type { InvoiceStatus, Prisma } from '../generated/prisma/client';

/** Status follows from the amounts; VOID is set explicitly and never changes back. */
export function statusFor(totalMinor: number, paidMinor: number): InvoiceStatus {
  if (paidMinor >= totalMinor) return 'PAID';
  return paidMinor === 0 ? 'ISSUED' : 'PARTIALLY_PAID';
}

export const INVOICE_SELECT = {
  id: true,
  number: true,
  status: true,
  currency: true,
  totalMinor: true,
  paidMinor: true,
  dueDate: true,
  createdAt: true,
  voidedAt: true,
  voidReason: true,
  sourceStructureId: true,
  student: { select: { id: true, firstName: true, lastName: true, admissionNumber: true } },
  term: { select: { id: true, name: true, academicYear: { select: { name: true } } } },
  items: { select: { id: true, description: true, amountMinor: true, category: { select: { id: true, name: true } } } },
  adjustments: { select: { id: true, kind: true, amountMinor: true, reason: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
  allocations: {
    select: {
      amountMinor: true,
      payment: { select: { id: true, receivedOn: true, method: true, status: true, reference: true, receipt: { select: { id: true, number: true } } } },
    },
  },
} satisfies Prisma.InvoiceSelect;

export type InvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_SELECT }>;

export const invoiceDto = (i: InvoiceRow) => ({
  id: i.id,
  number: i.number,
  status: i.status,
  currency: i.currency,
  totalMinor: i.totalMinor,
  paidMinor: i.paidMinor,
  balanceMinor: i.status === 'VOID' ? 0 : i.totalMinor - i.paidMinor,
  dueDate: i.dueDate ? fromDbDate(i.dueDate) : null,
  createdAt: i.createdAt,
  voidedAt: i.voidedAt,
  voidReason: i.voidReason,
  fromStructure: i.sourceStructureId !== null,
  student: i.student,
  term: { id: i.term.id, name: i.term.name, yearName: i.term.academicYear.name },
  items: i.items.map((x) => ({ id: x.id, description: x.description, amountMinor: x.amountMinor, category: x.category })),
  adjustments: i.adjustments,
  payments: i.allocations.map((a) => ({
    paymentId: a.payment.id,
    amountMinor: a.amountMinor,
    receivedOn: fromDbDate(a.payment.receivedOn),
    method: a.payment.method,
    status: a.payment.status,
    reference: a.payment.reference,
    receipt: a.payment.receipt,
  })),
});

export function financeAudit(
  audit: AuditService,
  action: string,
  schoolId: string,
  resourceType: string,
  resourceId: string,
  actor: Actor,
  summary: Prisma.InputJsonObject,
) {
  return audit.record({ action, outcome: 'SUCCESS', resourceType, resourceId, schoolId, actorUserId: actor.userId, summary, correlationId: actor.correlationId });
}

/** Locks rows so concurrent changes to the same invoices are applied one after another. */
export async function lockInvoices(tx: Prisma.TransactionClient, schoolId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return tx.$queryRaw<{ id: string; studentId: string; totalMinor: number; paidMinor: number; status: InvoiceStatus; currency: string; createdAt: Date }[]>`
    SELECT id, "studentId", "totalMinor", "paidMinor", status, currency, "createdAt"
    FROM invoices WHERE "schoolId" = ${schoolId}::uuid AND id = ANY(${ids}::uuid[])
    ORDER BY "createdAt", id
    FOR UPDATE`;
}
