import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { Clock } from '../common/clock';
import { formatNumber, nextCounter } from '../common/counters';
import { fromDbDate, toDbDate } from '../common/dates';
import { badRequest, conflict, isUniqueViolation, notFound } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import { enqueue } from '../outbox/outbox';
import { PrismaService } from '../prisma/prisma.service';
import type { SchoolContext } from '../tenancy/host-context';
import { financeAudit, lockInvoices, statusFor } from './finance-common';
import type { PaymentInput, PaymentsInput } from './finance.schemas';

export const PAYMENT_SELECT = {
  id: true,
  amountMinor: true,
  currency: true,
  method: true,
  reference: true,
  receivedOn: true,
  payerName: true,
  note: true,
  status: true,
  createdAt: true,
  reversedAt: true,
  reversalReason: true,
  recordedByUserId: true,
  student: { select: { id: true, firstName: true, lastName: true, admissionNumber: true } },
  receipt: { select: { id: true, number: true, issuedAt: true, voidedAt: true } },
  allocations: { select: { amountMinor: true, invoice: { select: { id: true, number: true, term: { select: { name: true } } } } } },
} satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

export const paymentDto = (p: PaymentRow) => ({
  id: p.id,
  amountMinor: p.amountMinor,
  currency: p.currency,
  method: p.method,
  reference: p.reference,
  receivedOn: fromDbDate(p.receivedOn),
  payerName: p.payerName,
  note: p.note,
  status: p.status,
  createdAt: p.createdAt,
  reversedAt: p.reversedAt,
  reversalReason: p.reversalReason,
  student: p.student,
  receipt: p.receipt,
  allocations: p.allocations.map((a) => ({ invoiceId: a.invoice.id, invoiceNumber: a.invoice.number, termName: a.invoice.term.name, amountMinor: a.amountMinor })),
});

export type RecordResult = { status: HttpStatus; body: { data: ReturnType<typeof paymentDto> } };

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(schoolId: string, q: PaymentsInput) {
    const where: Prisma.PaymentWhereInput = {
      schoolId,
      ...(q.studentId ? { studentId: q.studentId } : {}),
      ...(q.method ? { method: q.method } : {}),
      ...(q.from || q.to ? { receivedOn: { ...(q.from ? { gte: toDbDate(q.from) } : {}), ...(q.to ? { lte: toDbDate(q.to) } : {}) } } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({ where, select: PAYMENT_SELECT, orderBy: [{ receivedOn: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.payment.count({ where }),
    ]);
    return { data: rows.map(paymentDto), meta: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) } };
  }

  async get(schoolId: string, id: string) {
    const p = await this.prisma.payment.findFirst({ where: { schoolId, id }, select: PAYMENT_SELECT });
    if (!p) throw notFound('Payment not found');
    return { data: paymentDto(p) };
  }

  /**
   * Records a payment, allocates it to invoices and issues a receipt, all in one transaction.
   * - The idempotency key makes retries safe: the same key and body return the original payment.
   * - The student's open invoices are locked, so two payments at once can't overpay an invoice.
   * - Allocations must add up exactly to the amount; overpayments are refused (no credit balances yet).
   */
  async record(school: SchoolContext, input: PaymentInput, idempotencyKey: string, actor: Actor): Promise<RecordResult> {
    const { schoolId } = school;
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');

    const replay = await this.replay(schoolId, idempotencyKey, requestHash);
    if (replay) return replay;

    const today = this.clock.today(school.timezone);
    if (input.receivedOn > today) throw badRequest('FUTURE_DATE', 'The payment date can’t be in the future.');

    const [student, school_] = await Promise.all([
      this.prisma.student.findUnique({ where: { schoolId_id: { schoolId, id: input.studentId } }, select: { id: true } }),
      this.prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { currency: true } }),
    ]);
    if (!student) throw notFound('Student not found');

    if (input.reference) {
      const dup = await this.prisma.payment.findFirst({
        where: { schoolId, method: input.method, status: 'RECORDED', reference: { equals: input.reference, mode: 'insensitive' } },
        select: { receipt: { select: { number: true } } },
      });
      if (dup) {
        throw conflict('DUPLICATE_REFERENCE', `A payment with this reference is already recorded (receipt ${dup.receipt?.number ?? ''}).`.replace(' ()', ''));
      }
    }

    let paymentId: string;
    let allocated: { invoiceId: string; amountMinor: number }[];
    try {
      ({ paymentId, allocated } = await this.prisma.$transaction(async (tx) => {
        const openIds = (
          await tx.invoice.findMany({
            where: { schoolId, studentId: input.studentId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
            select: { id: true },
          })
        ).map((i) => i.id);
        const requested = input.allocations?.map((a) => a.invoiceId) ?? [];
        const locked = await lockInvoices(tx, schoolId, [...new Set([...openIds, ...requested])]);
        const byId = new Map(locked.map((i) => [i.id, i]));

        const plan = input.allocations ?? this.oldestFirst(locked.filter((i) => i.studentId === input.studentId && i.status !== 'PAID' && i.status !== 'VOID'), input.amountMinor);
        const sum = plan.reduce((n, a) => n + a.amountMinor, 0);
        if (sum !== input.amountMinor) {
          if (!input.allocations) {
            const owed = locked.filter((i) => i.studentId === input.studentId && i.status !== 'VOID').reduce((n, i) => n + i.totalMinor - i.paidMinor, 0);
            throw conflict('OVERPAYMENT', 'This is more than the student owes.', { owedMinor: owed });
          }
          throw badRequest('ALLOCATION_MISMATCH', 'The amounts allocated to invoices must add up to the payment amount.');
        }
        for (const a of plan) {
          const inv = byId.get(a.invoiceId);
          if (!inv || inv.studentId !== input.studentId) throw notFound('Invoice not found for this student');
          if (inv.status === 'VOID' || inv.status === 'PAID') throw conflict('INVOICE_NOT_OPEN', 'One of the chosen invoices is already paid or void.');
          if (a.amountMinor > inv.totalMinor - inv.paidMinor) throw conflict('OVERPAYMENT', 'This is more than is owed on one of the chosen invoices.');
          if (inv.currency !== school_.currency) throw conflict('CURRENCY_MISMATCH', 'Invoice and payment currencies differ.');
        }

        const payment = await tx.payment.create({
          data: {
            schoolId,
            studentId: input.studentId,
            amountMinor: input.amountMinor,
            currency: school_.currency,
            method: input.method,
            reference: input.reference ?? null,
            receivedOn: toDbDate(input.receivedOn),
            payerName: input.payerName ?? null,
            note: input.note ?? null,
            idempotencyKey,
            requestHash,
            recordedByUserId: actor.userId,
          },
          select: { id: true },
        });
        await tx.paymentAllocation.createMany({
          data: plan.map((a) => ({ schoolId, paymentId: payment.id, invoiceId: a.invoiceId, studentId: input.studentId, amountMinor: a.amountMinor })),
        });
        for (const a of plan) {
          const inv = byId.get(a.invoiceId)!;
          const paid = inv.paidMinor + a.amountMinor;
          await tx.invoice.update({ where: { id: inv.id }, data: { paidMinor: paid, status: statusFor(inv.totalMinor, paid) } });
        }
        const year = Number(input.receivedOn.slice(0, 4));
        await tx.receipt.create({
          data: { schoolId, paymentId: payment.id, number: formatNumber('RCT', year, await nextCounter(tx, schoolId, `receipt:${year}`)) },
        });
        // A short delay means a payment reversed straight away (a typo) never sends a confirmation.
        await enqueue(tx, [
          { schoolId, type: 'payment.recorded', payload: { paymentId: payment.id }, dedupeKey: `payment.recorded:${payment.id}`, delayMs: 5 * 60_000 },
        ]);
        return { paymentId: payment.id, allocated: plan };
      }));
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Lost a race with an identical retry, or the reference was just used.
        const raced = await this.replay(schoolId, idempotencyKey, requestHash);
        if (raced) return raced;
        throw conflict('DUPLICATE_REFERENCE', 'A payment with this reference is already recorded.');
      }
      throw err;
    }

    await financeAudit(this.audit, 'payment.record', schoolId, 'payment', paymentId, actor, {
      studentId: input.studentId,
      amountMinor: input.amountMinor,
      method: input.method,
      invoices: allocated.map((a) => a.invoiceId),
    });
    return { status: HttpStatus.CREATED, body: await this.get(schoolId, paymentId) };
  }

  /** Undoes a payment: invoices go back to owing, the receipt is marked void. Nothing is deleted. */
  async reverse(schoolId: string, id: string, reason: string, actor: Actor) {
    await this.prisma.$transaction(async (tx) => {
      const [p] = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status FROM payments WHERE "schoolId" = ${schoolId}::uuid AND id = ${id}::uuid FOR UPDATE`;
      if (!p) throw notFound('Payment not found');
      if (p.status !== 'RECORDED') throw conflict('ALREADY_REVERSED', 'This payment has already been reversed.');
      const allocations = await tx.paymentAllocation.findMany({ where: { paymentId: id }, select: { invoiceId: true, amountMinor: true } });
      const locked = new Map((await lockInvoices(tx, schoolId, allocations.map((a) => a.invoiceId))).map((i) => [i.id, i]));
      for (const a of allocations) {
        const inv = locked.get(a.invoiceId)!;
        const paid = inv.paidMinor - a.amountMinor;
        await tx.invoice.update({ where: { id: inv.id }, data: { paidMinor: paid, status: statusFor(inv.totalMinor, paid) } });
      }
      await tx.payment.update({ where: { id }, data: { status: 'REVERSED', reversedAt: new Date(), reversalReason: reason, reversedByUserId: actor.userId } });
      await tx.receipt.updateMany({ where: { paymentId: id }, data: { voidedAt: new Date() } });
    });
    await financeAudit(this.audit, 'payment.reverse', schoolId, 'payment', id, actor, { reason });
    return this.get(schoolId, id);
  }

  /** Everything needed to print a receipt. */
  async receipt(schoolId: string, receiptId: string, onlyStudentIds?: string[]) {
    const data = await loadReceipt(this.prisma, schoolId, receiptId, onlyStudentIds);
    if (!data) throw notFound('Receipt not found');
    return { data };
  }

  private oldestFirst(open: { id: string; totalMinor: number; paidMinor: number }[], amount: number) {
    const plan: { invoiceId: string; amountMinor: number }[] = [];
    let left = amount;
    for (const inv of open) {
      if (left === 0) break;
      const take = Math.min(left, inv.totalMinor - inv.paidMinor);
      if (take > 0) {
        plan.push({ invoiceId: inv.id, amountMinor: take });
        left -= take;
      }
    }
    return plan;
  }

  private async replay(schoolId: string, idempotencyKey: string, requestHash: string): Promise<RecordResult | null> {
    const existing = await this.prisma.payment.findUnique({
      where: { schoolId_idempotencyKey: { schoolId, idempotencyKey } },
      select: { id: true, requestHash: true },
    });
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw conflict('IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different payment.');
    }
    return { status: HttpStatus.OK, body: await this.get(schoolId, existing.id) };
  }
}

/** Shared by the API and the worker (which attaches receipts to payment confirmations). */
export async function loadReceipt(prisma: PrismaService, schoolId: string, receiptId: string, onlyStudentIds?: string[]) {
  const r = await prisma.receipt.findFirst({
    where: { schoolId, id: receiptId, ...(onlyStudentIds ? { payment: { studentId: { in: onlyStudentIds } } } : {}) },
    select: { id: true, number: true, issuedAt: true, voidedAt: true, payment: { select: PAYMENT_SELECT } },
  });
  if (!r) return null;
  const [school, recordedBy, owing] = await Promise.all([
    prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { name: true, motto: true, addressLine: true, city: true, phone: true, contactEmail: true } }),
    prisma.user.findUnique({ where: { id: r.payment.recordedByUserId }, select: { fullName: true, email: true } }),
    prisma.invoice.findMany({ where: { schoolId, studentId: r.payment.student.id, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, select: { totalMinor: true, paidMinor: true } }),
  ]);
  return {
    id: r.id,
    number: r.number,
    issuedAt: r.issuedAt,
    voidedAt: r.voidedAt,
    school,
    payment: paymentDto(r.payment),
    recordedBy: recordedBy ? (recordedBy.fullName ?? recordedBy.email) : null,
    balanceAfterMinor: owing.reduce((n, i) => n + i.totalMinor - i.paidMinor, 0),
  };
}
