import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ScopeService } from '../access/scope.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentActor, CurrentAuth, RequirePermissions, type Actor } from '../auth/decorators';
import { notFound } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import { AssessmentsService } from './assessments.service';
import type { Band } from './grading';
import { ReportCardsService } from './report-cards.service';
import {
  AssessmentsSchema,
  BandsSchema,
  CorrectSchema,
  PublishSchema,
  ReturnSchema,
  SaveMarksSchema,
  SheetKey,
  SheetsQuery,
  TermQuery,
  type AssessmentsInput,
  type CorrectInput,
  type SaveMarksInput,
  type SheetKeyInput,
} from './results.schemas';
import { SheetsService } from './sheets.service';

const id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });
const ctxOf = (school: SchoolContext, auth: AuthContext, req: Request) => ({ school, auth, correlationId: req.correlationId });

@Controller()
export class AssessmentsController {
  constructor(private readonly assessments: AssessmentsService) {}

  @Get('assessments')
  @RequirePermissions('results.read')
  get(@CurrentSchool() s: SchoolContext, @Query(new ZodPipe(TermQuery)) q: { termId: string }) {
    return this.assessments.get(s.schoolId, q.termId);
  }

  @Put('assessments')
  @RequirePermissions('assessments.manage')
  set(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(AssessmentsSchema)) body: AssessmentsInput, @CurrentActor() a: Actor) {
    return this.assessments.set(s.schoolId, body, a);
  }

  @Get('grading-scale')
  @RequirePermissions('results.read')
  async bands(@CurrentSchool() s: SchoolContext) {
    return { data: await this.assessments.bands(s.schoolId) };
  }

  @Put('grading-scale')
  @RequirePermissions('assessments.manage')
  setBands(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(BandsSchema)) body: { bands: Band[] }, @CurrentActor() a: Actor) {
    return this.assessments.setBands(s.schoolId, body.bands, a);
  }
}

/**
 * Sheets are addressed by (termId, classId, subjectId). Reading needs results.read or marks.enter;
 * the service applies class and subject scope and the workflow rules.
 */
@Controller('results')
export class ResultsController {
  constructor(private readonly sheets: SheetsService) {}

  @Get('sheets')
  @RequirePermissions('results.read')
  list(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Req() req: Request, @Query(new ZodPipe(SheetsQuery)) q: { termId: string; classId?: string }) {
    return this.sheets.list(ctxOf(s, auth, req), q.termId, q.classId);
  }

  @Get('sheet')
  @RequirePermissions('results.read')
  get(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Req() req: Request, @Query(new ZodPipe(SheetKey)) q: SheetKeyInput) {
    return this.sheets.get(ctxOf(s, auth, req), q);
  }

  @Put('sheet/marks')
  @RequirePermissions('marks.enter')
  save(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Req() req: Request, @Body(new ZodPipe(SaveMarksSchema)) body: SaveMarksInput) {
    return this.sheets.saveMarks(ctxOf(s, auth, req), body);
  }

  @Post('sheet/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('results.submit')
  submit(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Req() req: Request, @Body(new ZodPipe(SheetKey)) body: SheetKeyInput) {
    return this.sheets.submit(ctxOf(s, auth, req), body);
  }

  @Post('sheet/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('results.approve')
  approve(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Req() req: Request, @Body(new ZodPipe(SheetKey)) body: SheetKeyInput) {
    return this.sheets.approve(ctxOf(s, auth, req), body);
  }

  @Post('sheet/return')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('results.approve')
  returnSheet(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Req() req: Request, @Body(new ZodPipe(ReturnSchema)) body: SheetKeyInput & { reason: string }) {
    const { reason, ...key } = body;
    return this.sheets.returnForCorrection(ctxOf(s, auth, req), key, reason);
  }

  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('results.publish')
  publish(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Req() req: Request, @Body(new ZodPipe(PublishSchema)) body: { termId: string; classId: string }) {
    return this.sheets.publish(ctxOf(s, auth, req), body.termId, body.classId);
  }

  @Post('sheet/corrections')
  @RequirePermissions('results.publish')
  correct(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Req() req: Request, @Body(new ZodPipe(CorrectSchema)) body: CorrectInput) {
    return this.sheets.correct(ctxOf(s, auth, req), body);
  }
}

@Controller('students/:studentId')
export class StudentReportCardsController {
  constructor(
    private readonly cards: ReportCardsService,
    private readonly scope: ScopeService,
    private readonly prisma: PrismaService,
  ) {}

  private async assertVisible(schoolId: string, studentId: string, auth: AuthContext) {
    const visible = await this.prisma.student.findFirst({
      where: { AND: [{ schoolId, id: studentId }, this.scope.studentFilter(auth, 'results.read')] },
      select: { id: true },
    });
    if (!visible) throw notFound('Student not found');
  }

  @Get('report-cards')
  @RequirePermissions('results.read')
  async terms(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('studentId', id) studentId: string) {
    await this.assertVisible(s.schoolId, studentId, auth);
    return this.cards.terms(s.schoolId, studentId);
  }

  @Get('report-cards/:termId')
  @RequirePermissions('results.read')
  async card(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('studentId', id) studentId: string, @Param('termId', id) termId: string) {
    await this.assertVisible(s.schoolId, studentId, auth);
    return this.cards.card(s.schoolId, studentId, termId);
  }
}
