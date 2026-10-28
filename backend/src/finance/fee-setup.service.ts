import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { formatNumber, nextCounter } from '../common/counters';
import { fromDbDate, toDbDate } from '../common/dates';
import { conflict, isUniqueViolation, notFound } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { financeAudit } from './finance-common';
import type { StructureInput, UpdateStructureInput } from './finance.schemas';

const STRUCTURE = {
  id: true,
  name: true,
  dueDate: true,
  term: { select: { id: true, name: true, academicYearId: true, academicYear: { select: { name: true, status: true } } } },
  level: { select: { id: true, name: true } },
  items: { select: { id: true, description: true, amountMinor: true, category: { select: { id: true, name: true } } }, orderBy: { category: { name: 'asc' } } },
} satisfies Prisma.FeeStructureSelect;

@Injectable()
export class FeeSetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ----- categories -----

  async categories(schoolId: string) {
    return { data: await this.prisma.feeCategory.findMany({ where: { schoolId }, select: { id: true, name: true, isActive: true }, orderBy: { name: 'asc' } }) };
  }

  async createCategory(schoolId: string, name: string, actor: Actor) {
    try {
      const c = await this.prisma.feeCategory.create({ data: { schoolId, name }, select: { id: true } });
      await financeAudit(this.audit, 'fee_category.create', schoolId, 'fee_category', c.id, actor, { name });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'A fee category with this name already exists.');
      throw err;
    }
    return this.categories(schoolId);
  }

  async updateCategory(schoolId: string, id: string, input: { name?: string; isActive?: boolean }, actor: Actor) {
    const exists = await this.prisma.feeCategory.findUnique({ where: { schoolId_id: { schoolId, id } }, select: { id: true } });
    if (!exists) throw notFound('Fee category not found');
    try {
      await this.prisma.feeCategory.update({ where: { id }, data: input });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'A fee category with this name already exists.');
      throw err;
    }
    await financeAudit(this.audit, 'fee_category.update', schoolId, 'fee_category', id, actor, { fields: Object.keys(input) });
    return this.categories(schoolId);
  }

  // ----- structures -----

  async structures(schoolId: string, termId?: string) {
    const rows = await this.prisma.feeStructure.findMany({
      where: { schoolId, ...(termId ? { termId } : {}) },
      select: STRUCTURE,
      orderBy: [{ term: { startDate: 'desc' } }, { level: { sortOrder: 'asc' } }, { name: 'asc' }],
    });
    const billed = await this.billedCounts(rows.map((r) => r.id));
    return { data: rows.map((r) => this.structureDto(r, billed.get(r.id) ?? 0)) };
  }

  async structure(schoolId: string, id: string) {
    const s = await this.prisma.feeStructure.findUnique({ where: { schoolId_id: { schoolId, id } }, select: STRUCTURE });
    if (!s) throw notFound('Fee structure not found');
    const billed = await this.billedCounts([id]);
    return { data: this.structureDto(s, billed.get(id) ?? 0) };
  }

  async createStructure(schoolId: string, input: StructureInput, actor: Actor) {
    await this.assertTermAndLevel(schoolId, input.termId, input.levelId);
    await this.assertCategories(schoolId, input.items.map((i) => i.categoryId));
    try {
      const s = await this.prisma.$transaction(async (tx) => {
        const created = await tx.feeStructure.create({
          data: {
            schoolId,
            termId: input.termId,
            levelId: input.levelId,
            name: input.name,
            dueDate: input.dueDate ? toDbDate(input.dueDate) : null,
          },
          select: { id: true },
        });
        await tx.feeStructureItem.createMany({
          data: input.items.map((i) => ({ schoolId, structureId: created.id, categoryId: i.categoryId, description: i.description ?? null, amountMinor: i.amountMinor })),
        });
        return created;
      });
      await financeAudit(this.audit, 'fee_structure.create', schoolId, 'fee_structure', s.id, actor, {
        name: input.name,
        totalMinor: input.items.reduce((n, i) => n + i.amountMinor, 0),
      });
      return this.structure(schoolId, s.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'This level already has a fee structure with that name for this term.');
      throw err;
    }
  }

  /** Once invoices exist, the amounts are locked so every billed student was charged the same. */
  async updateStructure(schoolId: string, id: string, input: UpdateStructureInput, actor: Actor) {
    await this.structure(schoolId, id);
    if (input.items) {
      if (((await this.billedCounts([id])).get(id) ?? 0) > 0) {
        throw conflict('STRUCTURE_BILLED', 'Students have already been billed from this structure, so its fees can’t change. Create a new structure or adjust individual invoices.');
      }
      await this.assertCategories(schoolId, input.items.map((i) => i.categoryId));
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.feeStructure.update({
          where: { id },
          data: { name: input.name, ...(input.dueDate !== undefined ? { dueDate: input.dueDate ? toDbDate(input.dueDate) : null } : {}) },
        });
        if (input.items) {
          await tx.feeStructureItem.deleteMany({ where: { structureId: id } });
          await tx.feeStructureItem.createMany({
            data: input.items.map((i) => ({ schoolId, structureId: id, categoryId: i.categoryId, description: i.description ?? null, amountMinor: i.amountMinor })),
          });
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'This level already has a fee structure with that name for this term.');
      throw err;
    }
    await financeAudit(this.audit, 'fee_structure.update', schoolId, 'fee_structure', id, actor, { fields: Object.keys(input) });
    return this.structure(schoolId, id);
  }

  async deleteStructure(schoolId: string, id: string, actor: Actor) {
    await this.structure(schoolId, id);
    const everBilled = await this.prisma.invoice.count({ where: { schoolId, sourceStructureId: id } });
    if (everBilled > 0) throw conflict('STRUCTURE_BILLED', 'Invoices were created from this structure, so it can’t be deleted.');
    await this.prisma.feeStructure.delete({ where: { id } });
    await financeAudit(this.audit, 'fee_structure.delete', schoolId, 'fee_structure', id, actor, {});
  }

  /**
   * Invoices every active student enrolled in a class of the structure's level and year,
   * skipping anyone who already has a live invoice from it. Safe to run again after new admissions.
   */
  async bill(schoolId: string, id: string, actor: Actor) {
    const s = await this.prisma.feeStructure.findUnique({ where: { schoolId_id: { schoolId, id } }, select: STRUCTURE });
    if (!s) throw notFound('Fee structure not found');
    if (s.term.academicYear.status === 'CLOSED') throw conflict('YEAR_CLOSED', 'This term belongs to a closed academic year.');

    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { currency: true } });
    const students = await this.prisma.student.findMany({
      where: {
        schoolId,
        status: 'ACTIVE',
        enrollments: { some: { status: 'ACTIVE', academicYearId: s.term.academicYearId, class: { levelId: s.level.id } } },
      },
      select: { id: true },
    });
    const already = new Set(
      (
        await this.prisma.invoice.findMany({
          where: { schoolId, sourceStructureId: id, status: { not: 'VOID' } },
          select: { studentId: true },
        })
      ).map((i) => i.studentId),
    );
    const toBill = students.filter((st) => !already.has(st.id));
    const total = s.items.reduce((n, i) => n + i.amountMinor, 0);
    const year = this.clockYear();

    await this.prisma.$transaction(
      async (tx) => {
        for (const st of toBill) {
          const number = formatNumber('INV', year, await nextCounter(tx, schoolId, `invoice:${year}`));
          const invoice = await tx.invoice.create({
            data: {
              schoolId,
              studentId: st.id,
              termId: s.term.id,
              number,
              currency: school.currency,
              totalMinor: total,
              dueDate: s.dueDate,
              sourceStructureId: id,
              createdByUserId: actor.userId,
            },
            select: { id: true },
          });
          await tx.invoiceItem.createMany({
            data: s.items.map((i) => ({
              schoolId,
              invoiceId: invoice.id,
              categoryId: i.category.id,
              description: i.description ?? i.category.name,
              amountMinor: i.amountMinor,
            })),
          });
        }
      },
      { timeout: 120_000, maxWait: 10_000 },
    );

    await financeAudit(this.audit, 'fee_structure.bill', schoolId, 'fee_structure', id, actor, {
      created: toBill.length,
      skipped: already.size,
      totalMinor: total,
    });
    return { data: { created: toBill.length, alreadyBilled: already.size } };
  }

  private clockYear() {
    return new Date().getUTCFullYear();
  }

  private structureDto(s: Prisma.FeeStructureGetPayload<{ select: typeof STRUCTURE }>, billed: number) {
    return {
      id: s.id,
      name: s.name,
      dueDate: s.dueDate ? fromDbDate(s.dueDate) : null,
      term: { id: s.term.id, name: s.term.name, yearName: s.term.academicYear.name },
      level: s.level,
      items: s.items.map((i) => ({ id: i.id, description: i.description, amountMinor: i.amountMinor, category: i.category })),
      totalMinor: s.items.reduce((n, i) => n + i.amountMinor, 0),
      billed,
    };
  }

  private async billedCounts(ids: string[]) {
    if (ids.length === 0) return new Map<string, number>();
    const rows = await this.prisma.invoice.groupBy({
      by: ['sourceStructureId'],
      where: { sourceStructureId: { in: ids }, status: { not: 'VOID' } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.sourceStructureId!, r._count._all]));
  }

  private async assertTermAndLevel(schoolId: string, termId: string, levelId: string) {
    const [term, level] = await Promise.all([
      this.prisma.term.findUnique({ where: { schoolId_id: { schoolId, id: termId } }, select: { academicYear: { select: { status: true } } } }),
      this.prisma.educationLevel.findUnique({ where: { schoolId_id: { schoolId, id: levelId } }, select: { id: true } }),
    ]);
    if (!term) throw notFound('Term not found');
    if (!level) throw notFound('Level not found');
    if (term.academicYear.status === 'CLOSED') throw conflict('YEAR_CLOSED', 'This term belongs to a closed academic year.');
  }

  async assertCategories(schoolId: string, ids: string[]) {
    const found = await this.prisma.feeCategory.count({ where: { schoolId, id: { in: ids }, isActive: true } });
    if (found !== new Set(ids).size) throw notFound('Fee category not found or hidden');
  }
}
