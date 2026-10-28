import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { formatNumber, nextCounter } from '../common/counters';
import { toDbDate } from '../common/dates';
import { conflict, notFound } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FeeSetupService } from './fee-setup.service';
import { INVOICE_SELECT, financeAudit, invoiceDto, lockInvoices, statusFor } from './finance-common';
import type { AdjustmentInput, InvoiceInput, InvoicesInput } from './finance.schemas';

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly setup: FeeSetupService,
  ) {}

  async list(schoolId: string, q: InvoicesInput) {
    const where: Prisma.InvoiceWhereInput = {
      schoolId,
      ...(q.studentId ? { studentId: q.studentId } : {}),
      ...(q.termId ? { termId: q.termId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.search
        ? {
            OR: [
              { number: { contains: q.search, mode: 'insensitive' } },
              { student: { firstName: { contains: q.search, mode: 'insensitive' } } },
              { student: { lastName: { contains: q.search, mode: 'insensitive' } } },
              { student: { admissionNumber: { contains: q.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({ where, select: INVOICE_SELECT, orderBy: [{ createdAt: 'desc' }, { number: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.invoice.count({ where }),
    ]);
    return { data: rows.map(invoiceDto), meta: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) } };
  }

  async get(schoolId: string, id: string) {
    const i = await this.prisma.invoice.findFirst({ where: { schoolId, id }, select: INVOICE_SELECT });
    if (!i) throw notFound('Invoice not found');
    return { data: invoiceDto(i) };
  }

  /** A one-off invoice (e.g. uniform, an excursion) outside the fee structures. */
  async create(schoolId: string, input: InvoiceInput, actor: Actor) {
    const [student, term, school] = await Promise.all([
      this.prisma.student.findUnique({ where: { schoolId_id: { schoolId, id: input.studentId } }, select: { id: true } }),
      this.prisma.term.findUnique({ where: { schoolId_id: { schoolId, id: input.termId } }, select: { academicYear: { select: { status: true } } } }),
      this.prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { currency: true } }),
    ]);
    if (!student) throw notFound('Student not found');
    if (!term) throw notFound('Term not found');
    if (term.academicYear.status === 'CLOSED') throw conflict('YEAR_CLOSED', 'This term belongs to a closed academic year.');
    await this.setup.assertCategories(schoolId, input.items.map((i) => i.categoryId));
    const categories = new Map(
      (await this.prisma.feeCategory.findMany({ where: { schoolId, id: { in: input.items.map((i) => i.categoryId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]),
    );
    const year = new Date().getUTCFullYear();

    const id = await this.prisma.$transaction(async (tx) => {
      const number = formatNumber('INV', year, await nextCounter(tx, schoolId, `invoice:${year}`));
      const invoice = await tx.invoice.create({
        data: {
          schoolId,
          studentId: input.studentId,
          termId: input.termId,
          number,
          currency: school.currency,
          totalMinor: input.items.reduce((n, i) => n + i.amountMinor, 0),
          dueDate: input.dueDate ? toDbDate(input.dueDate) : null,
          createdByUserId: actor.userId,
        },
        select: { id: true },
      });
      await tx.invoiceItem.createMany({
        data: input.items.map((i) => ({
          schoolId,
          invoiceId: invoice.id,
          categoryId: i.categoryId,
          description: i.description || categories.get(i.categoryId)!,
          amountMinor: i.amountMinor,
        })),
      });
      return invoice.id;
    });
    await financeAudit(this.audit, 'invoice.create', schoolId, 'invoice', id, actor, { studentId: input.studentId });
    return this.get(schoolId, id);
  }

  /** Discounts and waivers lower the total; charges raise it. The total can't drop below what's been paid. */
  async adjust(schoolId: string, id: string, input: AdjustmentInput, actor: Actor) {
    await this.prisma.$transaction(async (tx) => {
      const [inv] = await lockInvoices(tx, schoolId, [id]);
      if (!inv) throw notFound('Invoice not found');
      if (inv.status === 'VOID') throw conflict('INVOICE_VOID', 'This invoice has been voided.');
      const total = input.kind === 'CHARGE' ? inv.totalMinor + input.amountMinor : inv.totalMinor - input.amountMinor;
      if (total < inv.paidMinor) {
        throw conflict('ADJUSTMENT_BELOW_PAID', 'This would make the invoice less than what has already been paid. Reverse a payment first.');
      }
      await tx.invoiceAdjustment.create({
        data: { schoolId, invoiceId: id, kind: input.kind, amountMinor: input.amountMinor, reason: input.reason, createdByUserId: actor.userId },
      });
      await tx.invoice.update({ where: { id }, data: { totalMinor: total, status: statusFor(total, inv.paidMinor) } });
    });
    await financeAudit(this.audit, 'invoice.adjust', schoolId, 'invoice', id, actor, { kind: input.kind, amountMinor: input.amountMinor, reason: input.reason });
    return this.get(schoolId, id);
  }

  /** Cancels an invoice raised in error. Only possible while nothing has been paid against it. */
  async void(schoolId: string, id: string, reason: string, actor: Actor) {
    await this.prisma.$transaction(async (tx) => {
      const [inv] = await lockInvoices(tx, schoolId, [id]);
      if (!inv) throw notFound('Invoice not found');
      if (inv.status === 'VOID') throw conflict('INVOICE_VOID', 'This invoice is already void.');
      if (inv.paidMinor > 0) throw conflict('HAS_PAYMENTS', 'Payments have been made against this invoice. Reverse them first.');
      await tx.invoice.update({ where: { id }, data: { status: 'VOID', voidedAt: new Date(), voidReason: reason } });
    });
    await financeAudit(this.audit, 'invoice.void', schoolId, 'invoice', id, actor, { reason });
    return this.get(schoolId, id);
  }
}
