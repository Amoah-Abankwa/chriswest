import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { Clock } from '../common/clock';
import { nextCounter } from '../common/counters';
import { fromDbDate, IsoDate, toDbDate } from '../common/dates';
import { badRequest, conflict, isUniqueViolation, notFound } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { SchoolContext } from '../tenancy/host-context';

export const BookSchema = z.object({
  title: z.string().trim().min(1).max(200),
  author: z.string().trim().max(120).nullable().optional(),
  isbn: z.string().trim().max(20).regex(/^[0-9Xx-]*$/).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  copies: z.number().int().min(0).max(200).default(1),
});
export const IssueSchema = z.object({ accessionNumber: z.string().trim().min(1).max(30), studentId: z.uuid(), dueOn: IsoDate.optional() });
export const CopyStatusSchema = z.object({ status: z.enum(['AVAILABLE', 'LOST', 'WITHDRAWN']) });
export const LoansQuery = z.object({ status: z.enum(['open', 'overdue', 'all']).default('open'), studentId: z.uuid().optional() });
export const BooksQuery = z.object({ search: z.string().trim().max(100).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });

const LOAN = {
  id: true,
  issuedAt: true,
  dueOn: true,
  returnedAt: true,
  copy: { select: { accessionNumber: true, book: { select: { id: true, title: true, author: true } } } },
  student: { select: { id: true, firstName: true, lastName: true, admissionNumber: true } },
} satisfies Prisma.LibraryLoanSelect;
type LoanRow = Prisma.LibraryLoanGetPayload<{ select: typeof LOAN }>;

@Injectable()
export class LibraryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private loanDto(l: LoanRow, today: string) {
    const due = fromDbDate(l.dueOn);
    return { ...l, dueOn: due, overdue: !l.returnedAt && due < today };
  }

  async books(schoolId: string, search: string | undefined, page: number, pageSize: number) {
    const where: Prisma.LibraryBookWhereInput = {
      schoolId,
      ...(search
        ? { OR: [{ title: { contains: search, mode: 'insensitive' } }, { author: { contains: search, mode: 'insensitive' } }, { isbn: { contains: search } }, { copies: { some: { accessionNumber: { equals: search, mode: 'insensitive' } } } }] }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.libraryBook.findMany({
        where,
        orderBy: { title: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, title: true, author: true, isbn: true, category: true, copies: { select: { status: true } } },
      }),
      this.prisma.libraryBook.count({ where }),
    ]);
    return {
      data: rows.map(({ copies, ...b }) => ({ ...b, copies: copies.length, available: copies.filter((c) => c.status === 'AVAILABLE').length })),
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async book(schoolId: string, id: string) {
    const b = await this.prisma.libraryBook.findFirst({
      where: { schoolId, id },
      select: {
        id: true,
        title: true,
        author: true,
        isbn: true,
        category: true,
        copies: {
          orderBy: { accessionNumber: 'asc' },
          select: { id: true, accessionNumber: true, status: true, loans: { where: { returnedAt: null }, select: LOAN } },
        },
      },
    });
    if (!b) throw notFound('Book not found');
    const today = this.clock.today('Africa/Accra');
    return { data: { ...b, copies: b.copies.map(({ loans, ...c }) => ({ ...c, loan: loans[0] ? this.loanDto(loans[0], today) : null })) } };
  }

  /** Adds a book with its copies; each copy gets the next accession number (LIB-000001…). */
  async addBook(schoolId: string, input: z.infer<typeof BookSchema>, actor: Actor) {
    const id = await this.prisma.$transaction(async (tx) => {
      const book = await tx.libraryBook.create({
        data: { schoolId, title: input.title, author: input.author ?? null, isbn: input.isbn ?? null, category: input.category ?? null },
        select: { id: true },
      });
      await this.createCopies(tx, schoolId, book.id, input.copies);
      return book.id;
    });
    await this.log('library.book_add', schoolId, id, actor, { title: input.title, copies: input.copies });
    return this.book(schoolId, id);
  }

  async addCopies(schoolId: string, bookId: string, count: number, actor: Actor) {
    await this.book(schoolId, bookId);
    await this.prisma.$transaction((tx) => this.createCopies(tx, schoolId, bookId, count));
    await this.log('library.copies_add', schoolId, bookId, actor, { count });
    return this.book(schoolId, bookId);
  }

  async setCopyStatus(schoolId: string, copyId: string, status: 'AVAILABLE' | 'LOST' | 'WITHDRAWN', actor: Actor) {
    const copy = await this.prisma.libraryCopy.findFirst({ where: { schoolId, id: copyId }, select: { bookId: true, status: true } });
    if (!copy) throw notFound('Copy not found');
    if (copy.status === 'ON_LOAN') throw conflict('ON_LOAN', 'Return the book before changing its status.');
    await this.prisma.libraryCopy.update({ where: { id: copyId }, data: { status } });
    await this.log('library.copy_status', schoolId, copyId, actor, { status });
    return this.book(schoolId, copy.bookId);
  }

  /** Lends a copy to a current student, within the school's loan limit. */
  async issue(school: SchoolContext, input: z.infer<typeof IssueSchema>, actor: Actor) {
    const { schoolId } = school;
    const [copy, student, settings] = await Promise.all([
      this.prisma.libraryCopy.findUnique({ where: { schoolId_accessionNumber: { schoolId, accessionNumber: input.accessionNumber.toUpperCase() } }, select: { id: true, status: true } }),
      this.prisma.student.findUnique({ where: { schoolId_id: { schoolId, id: input.studentId } }, select: { status: true } }),
      this.prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { libraryMaxLoans: true, libraryLoanDays: true } }),
    ]);
    if (!copy) throw notFound('No book with that accession number');
    if (!student) throw notFound('Student not found');
    if (student.status !== 'ACTIVE') throw conflict('STUDENT_NOT_ACTIVE', 'Only current students can borrow books.');
    if (copy.status !== 'AVAILABLE') throw conflict('NOT_AVAILABLE', copy.status === 'ON_LOAN' ? 'This copy is already on loan. Return it first.' : 'This copy is marked lost or withdrawn.');
    const open = await this.prisma.libraryLoan.count({ where: { schoolId, studentId: input.studentId, returnedAt: null } });
    if (open >= settings.libraryMaxLoans) throw conflict('LOAN_LIMIT', `Students can borrow up to ${settings.libraryMaxLoans} books at a time.`);

    const today = this.clock.today(school.timezone);
    const due = input.dueOn ?? fromDbDate(new Date(toDbDate(today).getTime() + settings.libraryLoanDays * 86_400_000));
    if (due < today) throw badRequest('INVALID_DATES', 'The due date is in the past.');
    try {
      const loan = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.libraryCopy.updateMany({ where: { id: copy.id, status: 'AVAILABLE' }, data: { status: 'ON_LOAN' } });
        if (claimed.count !== 1) throw conflict('NOT_AVAILABLE', 'This copy was just lent to someone else.');
        return tx.libraryLoan.create({ data: { schoolId, copyId: copy.id, studentId: input.studentId, dueOn: toDbDate(due), issuedByUserId: actor.userId }, select: LOAN });
      });
      await this.log('library.issue', schoolId, loan.id, actor, { studentId: input.studentId, accessionNumber: input.accessionNumber });
      return { data: this.loanDto(loan, today) };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NOT_AVAILABLE', 'This copy is already on loan.');
      throw err;
    }
  }

  async returnLoan(schoolId: string, loanId: string, actor: Actor) {
    const loan = await this.prisma.libraryLoan.findFirst({ where: { schoolId, id: loanId }, select: { copyId: true, returnedAt: true } });
    if (!loan) throw notFound('Loan not found');
    if (loan.returnedAt) throw conflict('ALREADY_RETURNED', 'This book has already been returned.');
    await this.prisma.$transaction([
      this.prisma.libraryLoan.update({ where: { id: loanId }, data: { returnedAt: this.clock.now(), returnedByUserId: actor.userId } }),
      this.prisma.libraryCopy.update({ where: { id: loan.copyId }, data: { status: 'AVAILABLE' } }),
    ]);
    await this.log('library.return', schoolId, loanId, actor, {});
    return { data: { id: loanId, returned: true } };
  }

  async loans(schoolId: string, status: 'open' | 'overdue' | 'all', studentId?: string) {
    const today = this.clock.today('Africa/Accra');
    const rows = await this.prisma.libraryLoan.findMany({
      where: {
        schoolId,
        ...(studentId ? { studentId } : {}),
        ...(status === 'open' ? { returnedAt: null } : status === 'overdue' ? { returnedAt: null, dueOn: { lt: toDbDate(today) } } : {}),
      },
      orderBy: [{ returnedAt: { sort: 'desc', nulls: 'first' } }, { dueOn: 'asc' }],
      take: 500,
      select: LOAN,
    });
    return { data: rows.map((l) => this.loanDto(l, today)) };
  }

  /** Current loans of one student; used by the parent portal. */
  async studentLoans(schoolId: string, studentId: string) {
    return this.loans(schoolId, 'open', studentId);
  }

  private async createCopies(tx: Prisma.TransactionClient, schoolId: string, bookId: string, count: number) {
    for (let i = 0; i < count; i++) {
      const n = await nextCounter(tx, schoolId, 'library:accession');
      await tx.libraryCopy.create({ data: { schoolId, bookId, accessionNumber: `LIB-${String(n).padStart(6, '0')}` } });
    }
  }

  private log(action: string, schoolId: string, resourceId: string, actor: Actor, summary: Prisma.InputJsonObject) {
    return this.audit.record({ action, outcome: 'SUCCESS', resourceType: 'library', resourceId, schoolId, actorUserId: actor.userId, summary, correlationId: actor.correlationId });
  }
}
