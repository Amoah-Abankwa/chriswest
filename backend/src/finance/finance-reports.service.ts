import { Injectable } from '@nestjs/common';
import { fromDbDate } from '../common/dates';
import { notFound } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { INVOICE_SELECT, invoiceDto } from './finance-common';

@Injectable()
export class FinanceReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Billed, adjusted, collected and outstanding for one term. */
  async summary(schoolId: string, termId: string) {
    const term = await this.prisma.term.findUnique({ where: { schoolId_id: { schoolId, id: termId } }, select: { id: true, name: true, academicYear: { select: { name: true } } } });
    if (!term) throw notFound('Term not found');
    const live = { schoolId, termId, status: { not: 'VOID' as const } };

    const [totals, byStatus, byCategory, adjustments, collections, school] = await Promise.all([
      this.prisma.invoice.aggregate({ where: live, _sum: { totalMinor: true, paidMinor: true }, _count: { _all: true } }),
      this.prisma.invoice.groupBy({ by: ['status'], where: { schoolId, termId }, _count: { _all: true } }),
      this.prisma.invoiceItem.groupBy({ by: ['categoryId'], where: { schoolId, invoice: live }, _sum: { amountMinor: true } }),
      this.prisma.invoiceAdjustment.groupBy({ by: ['kind'], where: { schoolId, invoice: live }, _sum: { amountMinor: true } }),
      this.prisma.paymentAllocation.findMany({
        where: { schoolId, invoice: { termId }, payment: { status: 'RECORDED' } },
        select: { amountMinor: true, payment: { select: { method: true } } },
      }),
      this.prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { currency: true } }),
    ]);
    const categories = new Map(
      (await this.prisma.feeCategory.findMany({ where: { schoolId, id: { in: byCategory.map((c) => c.categoryId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]),
    );
    const byMethod = new Map<string, number>();
    for (const c of collections) byMethod.set(c.payment.method, (byMethod.get(c.payment.method) ?? 0) + c.amountMinor);

    const billed = totals._sum.totalMinor ?? 0;
    const collected = totals._sum.paidMinor ?? 0;
    return {
      data: {
        term: { id: term.id, name: term.name, yearName: term.academicYear.name },
        currency: school.currency,
        invoices: totals._count._all,
        billedMinor: billed,
        collectedMinor: collected,
        outstandingMinor: billed - collected,
        collectionRate: billed ? Math.round((collected / billed) * 1000) / 10 : null,
        byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
        byCategory: byCategory
          .map((c) => ({ category: categories.get(c.categoryId) ?? 'Unknown', amountMinor: c._sum.amountMinor ?? 0 }))
          .sort((a, b) => b.amountMinor - a.amountMinor),
        adjustments: Object.fromEntries(adjustments.map((a) => [a.kind, a._sum.amountMinor ?? 0])),
        byMethod: Object.fromEntries(byMethod),
      },
    };
  }

  /** Students who still owe money for a term, largest balances first, with a contact to follow up. */
  async arrears(schoolId: string, termId: string, classId: string | undefined, page: number, pageSize: number) {
    const term = await this.prisma.term.findUnique({ where: { schoolId_id: { schoolId, id: termId } }, select: { id: true } });
    if (!term) throw notFound('Term not found');
    const invoices = await this.prisma.invoice.findMany({
      where: {
        schoolId,
        termId,
        status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
        ...(classId ? { student: { enrollments: { some: { classId, status: 'ACTIVE' } } } } : {}),
      },
      select: { studentId: true, totalMinor: true, paidMinor: true },
    });
    const owed = new Map<string, number>();
    for (const i of invoices) owed.set(i.studentId, (owed.get(i.studentId) ?? 0) + i.totalMinor - i.paidMinor);
    const ranked = [...owed].sort((a, b) => b[1] - a[1]);
    const slice = ranked.slice((page - 1) * pageSize, page * pageSize);

    const students = await this.prisma.student.findMany({
      where: { schoolId, id: { in: slice.map(([id]) => id) } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        admissionNumber: true,
        enrollments: { where: { status: 'ACTIVE' }, take: 1, select: { class: { select: { name: true } } } },
        guardians: {
          orderBy: { isPrimaryContact: 'desc' },
          take: 1,
          select: { guardian: { select: { fullName: true, phone: true } } },
        },
      },
    });
    const byId = new Map(students.map((s) => [s.id, s]));
    return {
      data: slice.map(([id, amount]) => {
        const s = byId.get(id)!;
        return {
          studentId: id,
          name: `${s.firstName} ${s.lastName}`,
          admissionNumber: s.admissionNumber,
          className: s.enrollments[0]?.class.name ?? null,
          contact: s.guardians[0]?.guardian ?? null,
          owedMinor: amount,
        };
      }),
      meta: {
        page,
        pageSize,
        total: ranked.length,
        totalPages: Math.ceil(ranked.length / pageSize),
        totalOwedMinor: ranked.reduce((n, [, v]) => n + v, 0),
      },
    };
  }

  /** A student's whole account: invoices, payments and what they owe now. */
  async studentAccount(schoolId: string, studentId: string) {
    const student = await this.prisma.student.findUnique({ where: { schoolId_id: { schoolId, id: studentId } }, select: { id: true } });
    if (!student) throw notFound('Student not found');
    const [invoices, payments, school] = await Promise.all([
      this.prisma.invoice.findMany({ where: { schoolId, studentId }, select: INVOICE_SELECT, orderBy: [{ createdAt: 'desc' }] }),
      this.prisma.payment.findMany({
        where: { schoolId, studentId },
        orderBy: [{ receivedOn: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          amountMinor: true,
          method: true,
          reference: true,
          receivedOn: true,
          status: true,
          reversalReason: true,
          receipt: { select: { id: true, number: true, voidedAt: true } },
        },
      }),
      this.prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { currency: true } }),
    ]);
    const dtos = invoices.map(invoiceDto);
    return {
      data: {
        currency: school.currency,
        balanceMinor: dtos.reduce((n, i) => n + i.balanceMinor, 0),
        invoices: dtos,
        payments: payments.map((p) => ({ ...p, receivedOn: fromDbDate(p.receivedOn) })),
      },
    };
  }
}
