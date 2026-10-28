import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { fromDbDate, toDbDate } from '../common/dates';
import { badRequest, conflict, isUniqueViolation, notFound } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateTermInput, CreateYearInput, UpdateTermInput, UpdateYearInput } from './academics.schemas';

const YEAR = {
  id: true,
  name: true,
  startDate: true,
  endDate: true,
  status: true,
  terms: { select: { id: true, name: true, startDate: true, endDate: true }, orderBy: { startDate: 'asc' } },
  _count: { select: { classes: true } },
} satisfies Prisma.AcademicYearSelect;

type YearRow = Prisma.AcademicYearGetPayload<{ select: typeof YEAR }>;

const toDto = (y: YearRow) => ({
  id: y.id,
  name: y.name,
  startDate: fromDbDate(y.startDate),
  endDate: fromDbDate(y.endDate),
  status: y.status,
  terms: y.terms.map((t) => ({ id: t.id, name: t.name, startDate: fromDbDate(t.startDate), endDate: fromDbDate(t.endDate) })),
  classCount: y._count.classes,
});

const yearNotFound = () => notFound('Academic year not found');
const yearClosed = () => conflict('YEAR_CLOSED', 'This academic year is closed and can no longer be changed.');

/** Closing a year ends every active enrollment in it as COMPLETED on the year's last day. */
async function completeEnrollments(tx: Prisma.TransactionClient, yearId: string) {
  const year = await tx.academicYear.findUniqueOrThrow({ where: { id: yearId }, select: { endDate: true } });
  await tx.enrollment.updateMany({
    where: { academicYearId: yearId, status: 'ACTIVE' },
    data: { status: 'COMPLETED', endDate: year.endDate, endReason: 'Academic year closed' },
  });
}

function assertOrder(start: Date, end: Date) {
  if (end <= start) throw badRequest('INVALID_DATES', 'The end date must be after the start date.');
}

/** All queries are scoped by the server-resolved schoolId. */
@Injectable()
export class AcademicYearsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(schoolId: string) {
    const years = await this.prisma.academicYear.findMany({ where: { schoolId }, select: YEAR, orderBy: { startDate: 'desc' } });
    return { data: years.map(toDto) };
  }

  async get(schoolId: string, id: string) {
    const year = await this.prisma.academicYear.findUnique({ where: { schoolId_id: { schoolId, id } }, select: YEAR });
    if (!year) throw yearNotFound();
    return { data: toDto(year) };
  }

  async create(schoolId: string, input: CreateYearInput, actor: Actor) {
    const start = toDbDate(input.startDate);
    const end = toDbDate(input.endDate);
    assertOrder(start, end);
    await this.assertNoYearOverlap(schoolId, start, end);
    try {
      const year = await this.prisma.academicYear.create({
        data: { schoolId, name: input.name, startDate: start, endDate: end },
        select: YEAR,
      });
      await this.log('academic_year.create', schoolId, year.id, actor, { name: input.name });
      return { data: toDto(year) };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'An academic year with this name already exists.');
      throw err;
    }
  }

  async update(schoolId: string, id: string, input: UpdateYearInput, actor: Actor) {
    const year = await this.prisma.academicYear.findUnique({ where: { schoolId_id: { schoolId, id } }, select: YEAR });
    if (!year) throw yearNotFound();
    if (year.status === 'CLOSED') throw yearClosed();

    const start = input.startDate ? toDbDate(input.startDate) : year.startDate;
    const end = input.endDate ? toDbDate(input.endDate) : year.endDate;
    assertOrder(start, end);
    await this.assertNoYearOverlap(schoolId, start, end, id);
    if (year.terms.some((t) => t.startDate < start || t.endDate > end)) {
      throw conflict('TERMS_OUTSIDE_YEAR', 'Some terms fall outside these dates. Change the terms first.');
    }
    try {
      const updated = await this.prisma.academicYear.update({
        where: { id },
        data: { name: input.name, startDate: start, endDate: end },
        select: YEAR,
      });
      await this.log('academic_year.update', schoolId, id, actor, { fields: Object.keys(input) });
      return { data: toDto(updated) };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'An academic year with this name already exists.');
      throw err;
    }
  }

  async remove(schoolId: string, id: string, actor: Actor) {
    const year = await this.prisma.academicYear.findUnique({ where: { schoolId_id: { schoolId, id } }, select: YEAR });
    if (!year) throw yearNotFound();
    if (year.status !== 'DRAFT' || year._count.classes > 0) {
      throw conflict('YEAR_IN_USE', 'Only draft years without classes can be deleted.');
    }
    await this.prisma.academicYear.delete({ where: { id } });
    await this.log('academic_year.delete', schoolId, id, actor, { name: year.name });
  }

  /**
   * Makes a draft year current. If another year is current, it must be closed in the same step,
   * and the caller has to say so explicitly (closeCurrent) so it never happens by accident.
   */
  async activate(schoolId: string, id: string, closeCurrent: boolean, actor: Actor) {
    const closed = await this.prisma.$transaction(async (tx) => {
      const year = await tx.academicYear.findUnique({
        where: { schoolId_id: { schoolId, id } },
        select: { name: true, status: true, _count: { select: { terms: true } } },
      });
      if (!year) throw yearNotFound();
      if (year.status === 'ACTIVE') throw conflict('ALREADY_ACTIVE', 'This is already the current year.');
      if (year.status === 'CLOSED') throw conflict('YEAR_CLOSED', "Closed years can't be made current again.");
      if (year._count.terms === 0) throw conflict('NO_TERMS', 'Add at least one term before making this year current.');

      const current = await tx.academicYear.findFirst({ where: { schoolId, status: 'ACTIVE' }, select: { id: true, name: true } });
      if (current && !closeCurrent) {
        throw conflict(
          'ACTIVE_YEAR_EXISTS',
          `${current.name} is the current year. Close it to make ${year.name} current.`,
          { currentYear: current },
        );
      }
      if (current) {
        await tx.academicYear.update({ where: { id: current.id }, data: { status: 'CLOSED' } });
        await completeEnrollments(tx, current.id);
      }
      const updated = await tx.academicYear.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'ACTIVE' } });
      if (updated.count !== 1) throw conflict('CHANGED', 'Someone else just changed this year. Reload and try again.');
      return current;
    });

    if (closed) await this.log('academic_year.close', schoolId, closed.id, actor, { name: closed.name });
    await this.log('academic_year.activate', schoolId, id, actor);
    return this.get(schoolId, id);
  }

  async close(schoolId: string, id: string, actor: Actor) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.academicYear.updateMany({ where: { schoolId, id, status: 'ACTIVE' }, data: { status: 'CLOSED' } });
      if (result.count === 1) await completeEnrollments(tx, id);
      return result;
    });
    if (updated.count !== 1) {
      await this.get(schoolId, id); // 404 if it isn't this school's
      throw conflict('NOT_ACTIVE', 'Only the current year can be closed.');
    }
    await this.log('academic_year.close', schoolId, id, actor);
    return this.get(schoolId, id);
  }

  async addTerm(schoolId: string, yearId: string, input: CreateTermInput, actor: Actor) {
    const year = await this.prisma.academicYear.findUnique({
      where: { schoolId_id: { schoolId, id: yearId } },
      select: { status: true, startDate: true, endDate: true },
    });
    if (!year) throw yearNotFound();
    if (year.status === 'CLOSED') throw yearClosed();

    const start = toDbDate(input.startDate);
    const end = toDbDate(input.endDate);
    this.assertTermFits(start, end, year);
    await this.assertNoTermOverlap(yearId, start, end);
    try {
      const term = await this.prisma.term.create({
        data: { schoolId, academicYearId: yearId, name: input.name, startDate: start, endDate: end },
        select: { id: true },
      });
      await this.log('term.create', schoolId, term.id, actor, { academicYearId: yearId, name: input.name });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'This year already has a term with that name.');
      throw err;
    }
    return this.get(schoolId, yearId);
  }

  async updateTerm(schoolId: string, termId: string, input: UpdateTermInput, actor: Actor) {
    const term = await this.prisma.term.findUnique({
      where: { schoolId_id: { schoolId, id: termId } },
      select: {
        academicYearId: true,
        startDate: true,
        endDate: true,
        academicYear: { select: { status: true, startDate: true, endDate: true } },
      },
    });
    if (!term) throw notFound('Term not found');
    if (term.academicYear.status === 'CLOSED') throw yearClosed();

    const start = input.startDate ? toDbDate(input.startDate) : term.startDate;
    const end = input.endDate ? toDbDate(input.endDate) : term.endDate;
    this.assertTermFits(start, end, term.academicYear);
    await this.assertNoTermOverlap(term.academicYearId, start, end, termId);
    try {
      await this.prisma.term.update({ where: { id: termId }, data: { name: input.name, startDate: start, endDate: end } });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'This year already has a term with that name.');
      throw err;
    }
    await this.log('term.update', schoolId, termId, actor, { fields: Object.keys(input) });
    return this.get(schoolId, term.academicYearId);
  }

  async removeTerm(schoolId: string, termId: string, actor: Actor) {
    const term = await this.prisma.term.findUnique({
      where: { schoolId_id: { schoolId, id: termId } },
      select: { academicYearId: true, academicYear: { select: { status: true, _count: { select: { terms: true } } } } },
    });
    if (!term) throw notFound('Term not found');
    if (term.academicYear.status === 'CLOSED') throw yearClosed();
    if (term.academicYear.status === 'ACTIVE' && term.academicYear._count.terms <= 1) {
      throw conflict('LAST_TERM', 'The current year needs at least one term.');
    }
    await this.prisma.term.delete({ where: { id: termId } });
    await this.log('term.delete', schoolId, termId, actor);
    return this.get(schoolId, term.academicYearId);
  }

  private assertTermFits(start: Date, end: Date, year: { startDate: Date; endDate: Date }) {
    assertOrder(start, end);
    if (start < year.startDate || end > year.endDate) {
      throw badRequest(
        'TERM_OUTSIDE_YEAR',
        `Terms must fall between ${fromDbDate(year.startDate)} and ${fromDbDate(year.endDate)}.`,
      );
    }
  }

  private async assertNoYearOverlap(schoolId: string, start: Date, end: Date, excludeId?: string) {
    const clash = await this.prisma.academicYear.findFirst({
      where: { schoolId, id: excludeId ? { not: excludeId } : undefined, startDate: { lte: end }, endDate: { gte: start } },
      select: { name: true },
    });
    if (clash) throw conflict('DATES_OVERLAP', `These dates overlap with ${clash.name}.`);
  }

  private async assertNoTermOverlap(yearId: string, start: Date, end: Date, excludeId?: string) {
    const clash = await this.prisma.term.findFirst({
      where: { academicYearId: yearId, id: excludeId ? { not: excludeId } : undefined, startDate: { lte: end }, endDate: { gte: start } },
      select: { name: true },
    });
    if (clash) throw conflict('DATES_OVERLAP', `These dates overlap with ${clash.name}.`);
  }

  private log(action: string, schoolId: string, resourceId: string, actor: Actor, summary?: Prisma.InputJsonValue) {
    return this.audit.record({
      action,
      outcome: 'SUCCESS',
      resourceType: action.split('.')[0]!,
      resourceId,
      schoolId,
      actorUserId: actor.userId,
      summary,
      correlationId: actor.correlationId,
    });
  }
}
