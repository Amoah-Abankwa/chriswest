import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor, RequirePermissions, type Actor } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import { BookSchema, BooksQuery, CopyStatusSchema, IssueSchema, LibraryService, LoansQuery } from './library.service';

const id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });
@Controller('library')
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  @Get('books')
  @RequirePermissions('library.read')
  books(@CurrentSchool() s: SchoolContext, @Query(new ZodPipe(BooksQuery)) q: z.infer<typeof BooksQuery>) {
    return this.library.books(s.schoolId, q.search, q.page, q.pageSize);
  }

  @Get('books/:id')
  @RequirePermissions('library.read')
  book(@CurrentSchool() s: SchoolContext, @Param('id', id) bookId: string) {
    return this.library.book(s.schoolId, bookId);
  }

  @Post('books')
  @RequirePermissions('library.manage')
  addBook(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(BookSchema)) body: z.infer<typeof BookSchema>, @CurrentActor() a: Actor) {
    return this.library.addBook(s.schoolId, body, a);
  }

  @Post('books/:id/copies')
  @RequirePermissions('library.manage')
  addCopies(@CurrentSchool() s: SchoolContext, @Param('id', id) bookId: string, @Body(new ZodPipe(z.object({ count: z.number().int().min(1).max(200) }))) body: { count: number }, @CurrentActor() a: Actor) {
    return this.library.addCopies(s.schoolId, bookId, body.count, a);
  }

  @Patch('copies/:id')
  @RequirePermissions('library.manage')
  copyStatus(@CurrentSchool() s: SchoolContext, @Param('id', id) copyId: string, @Body(new ZodPipe(CopyStatusSchema)) body: { status: 'AVAILABLE' | 'LOST' | 'WITHDRAWN' }, @CurrentActor() a: Actor) {
    return this.library.setCopyStatus(s.schoolId, copyId, body.status, a);
  }

  @Get('loans')
  @RequirePermissions('library.read')
  loans(@CurrentSchool() s: SchoolContext, @Query(new ZodPipe(LoansQuery)) q: z.infer<typeof LoansQuery>) {
    return this.library.loans(s.schoolId, q.status, q.studentId);
  }

  @Post('loans')
  @RequirePermissions('library.manage')
  issue(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(IssueSchema)) body: z.infer<typeof IssueSchema>, @CurrentActor() a: Actor) {
    return this.library.issue(s, body, a);
  }

  @Post('loans/:id/return')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('library.manage')
  returnLoan(@CurrentSchool() s: SchoolContext, @Param('id', id) loanId: string, @CurrentActor() a: Actor) {
    return this.library.returnLoan(s.schoolId, loanId, a);
  }
}
