import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, StreamableFile } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ScopeService } from '../access/scope.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../auth/decorators';
import { notFound } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { loadReceipt } from '../finance/payments.service';
import { pdfDisposition, receiptPdf, reportCardsPdf } from '../pdf/pdf';
import { PortalService } from '../portal/portal.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportCardsService } from '../results/report-cards.service';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import { ExportsService } from './exports.service';

const id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });
const ExportSchema = z.object({ termId: z.uuid(), classId: z.uuid() });

const pdfFile = (pdf: Buffer, name: string) => new StreamableFile(pdf, { type: 'application/pdf', disposition: pdfDisposition(name), length: pdf.length });

@Controller()
export class ExportsController {
  constructor(
    private readonly exports: ExportsService,
    private readonly cards: ReportCardsService,
    private readonly scope: ScopeService,
    private readonly prisma: PrismaService,
    private readonly portal: PortalService,
  ) {}

  /** A whole class's report cards as one PDF, built in the background. */
  @Post('exports/report-cards')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions('results.read')
  request(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Body(new ZodPipe(ExportSchema)) body: z.infer<typeof ExportSchema>, @Req() req: Request) {
    return this.exports.requestReportCards(s.schoolId, auth, body.termId, body.classId, req.correlationId);
  }

  @Post('exports/school-data')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions('school.update')
  schoolData(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Req() req: Request) {
    return this.exports.requestSchoolData(s.schoolId, auth, req.correlationId);
  }

  @Get('exports')
  mine(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext) {
    return this.exports.mine(s.schoolId, auth.userId);
  }

  @Get('exports/:id')
  get(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', id) exportId: string) {
    return this.exports.get(s.schoolId, auth.userId, exportId);
  }

  @Get('exports/:id/download')
  @Header('Cache-Control', 'private, no-store')
  async download(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', id) exportId: string) {
    const file = await this.exports.download(s.schoolId, auth.userId, exportId);
    return new StreamableFile(file.body, { type: file.contentType, disposition: pdfDisposition(file.fileName), length: file.body.length });
  }

  /** One report card as a PDF, straight away (they're small). */
  @Get('students/:studentId/report-cards/:termId/pdf')
  @RequirePermissions('results.read')
  @Header('Cache-Control', 'private, no-store')
  async studentCard(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('studentId', id) studentId: string, @Param('termId', id) termId: string) {
    const visible = await this.prisma.student.findFirst({ where: { AND: [{ schoolId: s.schoolId, id: studentId }, this.scope.studentFilter(auth, 'results.read')] }, select: { id: true } });
    if (!visible) throw notFound('Student not found');
    const card = (await this.cards.card(s.schoolId, studentId, termId)).data;
    return pdfFile(await reportCardsPdf([card]), `report-card-${card.student.lastName}-${card.term.name}.pdf`);
  }

  @Get('portal/children/:studentId/report-cards/:termId/pdf')
  @Header('Cache-Control', 'private, no-store')
  async portalCard(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('studentId', id) studentId: string, @Param('termId', id) termId: string) {
    await this.portal.assertCanView(s.schoolId, auth.userId, studentId, 'results');
    const card = (await this.cards.card(s.schoolId, studentId, termId)).data;
    return pdfFile(await reportCardsPdf([card]), `report-card-${card.student.lastName}-${card.term.name}.pdf`);
  }

  @Get('portal/children/:studentId/receipts/:receiptId/pdf')
  @Header('Cache-Control', 'private, no-store')
  async portalReceipt(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('studentId', id) studentId: string, @Param('receiptId', id) receiptId: string) {
    await this.portal.assertCanView(s.schoolId, auth.userId, studentId, 'fees');
    const r = await loadReceipt(this.prisma, s.schoolId, receiptId, [studentId]);
    if (!r) throw notFound('Receipt not found');
    return pdfFile(await receiptPdf(r), `receipt-${r.number}.pdf`);
  }
}
