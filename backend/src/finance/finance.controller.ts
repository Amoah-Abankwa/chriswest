import { Body, Controller, Delete, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { pdfDisposition, receiptPdf } from '../pdf/pdf';
import type { Response } from 'express';
import { CurrentActor, RequirePermissions, type Actor } from '../auth/decorators';
import { badRequest } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import { FeeSetupService } from './fee-setup.service';
import { FinanceReportsService } from './finance-reports.service';
import {
  AdjustmentSchema,
  ArrearsQuery,
  CategorySchema,
  IdempotencyKey,
  InvoiceSchema,
  InvoicesQuery,
  PaymentSchema,
  PaymentsQuery,
  ReportQuery,
  ReversalSchema,
  StructureSchema,
  StructuresQuery,
  UpdateCategorySchema,
  UpdateStructureSchema,
  VoidSchema,
  type AdjustmentInput,
  type ArrearsInput,
  type InvoiceInput,
  type InvoicesInput,
  type PaymentInput,
  type PaymentsInput,
  type StructureInput,
  type UpdateStructureInput,
} from './finance.schemas';
import { InvoicesService } from './invoices.service';
import { PaymentsService } from './payments.service';

const id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });

@Controller('fee-categories')
export class FeeCategoriesController {
  constructor(private readonly setup: FeeSetupService) {}

  @Get()
  @RequirePermissions('fees.read')
  list(@CurrentSchool() s: SchoolContext) {
    return this.setup.categories(s.schoolId);
  }

  @Post()
  @RequirePermissions('fees.manage')
  create(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(CategorySchema)) body: { name: string }, @CurrentActor() a: Actor) {
    return this.setup.createCategory(s.schoolId, body.name, a);
  }

  @Patch(':id')
  @RequirePermissions('fees.manage')
  update(@CurrentSchool() s: SchoolContext, @Param('id', id) categoryId: string, @Body(new ZodPipe(UpdateCategorySchema)) body: { name?: string; isActive?: boolean }, @CurrentActor() a: Actor) {
    return this.setup.updateCategory(s.schoolId, categoryId, body, a);
  }
}

@Controller('fee-structures')
export class FeeStructuresController {
  constructor(private readonly setup: FeeSetupService) {}

  @Get()
  @RequirePermissions('fees.read')
  list(@CurrentSchool() s: SchoolContext, @Query(new ZodPipe(StructuresQuery)) q: { termId?: string }) {
    return this.setup.structures(s.schoolId, q.termId);
  }

  @Get(':id')
  @RequirePermissions('fees.read')
  get(@CurrentSchool() s: SchoolContext, @Param('id', id) structureId: string) {
    return this.setup.structure(s.schoolId, structureId);
  }

  @Post()
  @RequirePermissions('fees.manage')
  create(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(StructureSchema)) body: StructureInput, @CurrentActor() a: Actor) {
    return this.setup.createStructure(s.schoolId, body, a);
  }

  @Patch(':id')
  @RequirePermissions('fees.manage')
  update(@CurrentSchool() s: SchoolContext, @Param('id', id) structureId: string, @Body(new ZodPipe(UpdateStructureSchema)) body: UpdateStructureInput, @CurrentActor() a: Actor) {
    return this.setup.updateStructure(s.schoolId, structureId, body, a);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('fees.manage')
  remove(@CurrentSchool() s: SchoolContext, @Param('id', id) structureId: string, @CurrentActor() a: Actor) {
    return this.setup.deleteStructure(s.schoolId, structureId, a);
  }

  @Post(':id/bill')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('invoices.create')
  bill(@CurrentSchool() s: SchoolContext, @Param('id', id) structureId: string, @CurrentActor() a: Actor) {
    return this.setup.bill(s.schoolId, structureId, a);
  }
}

@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @RequirePermissions('fees.read')
  list(@CurrentSchool() s: SchoolContext, @Query(new ZodPipe(InvoicesQuery)) q: InvoicesInput) {
    return this.invoices.list(s.schoolId, q);
  }

  @Get(':id')
  @RequirePermissions('fees.read')
  get(@CurrentSchool() s: SchoolContext, @Param('id', id) invoiceId: string) {
    return this.invoices.get(s.schoolId, invoiceId);
  }

  @Post()
  @RequirePermissions('invoices.create')
  create(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(InvoiceSchema)) body: InvoiceInput, @CurrentActor() a: Actor) {
    return this.invoices.create(s.schoolId, body, a);
  }

  @Post(':id/adjustments')
  @RequirePermissions('invoices.adjust')
  adjust(@CurrentSchool() s: SchoolContext, @Param('id', id) invoiceId: string, @Body(new ZodPipe(AdjustmentSchema)) body: AdjustmentInput, @CurrentActor() a: Actor) {
    return this.invoices.adjust(s.schoolId, invoiceId, body, a);
  }

  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('invoices.adjust')
  void(@CurrentSchool() s: SchoolContext, @Param('id', id) invoiceId: string, @Body(new ZodPipe(VoidSchema)) body: { reason: string }, @CurrentActor() a: Actor) {
    return this.invoices.void(s.schoolId, invoiceId, body.reason, a);
  }
}

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @RequirePermissions('fees.read')
  list(@CurrentSchool() s: SchoolContext, @Query(new ZodPipe(PaymentsQuery)) q: PaymentsInput) {
    return this.payments.list(s.schoolId, q);
  }

  @Get(':id')
  @RequirePermissions('fees.read')
  get(@CurrentSchool() s: SchoolContext, @Param('id', id) paymentId: string) {
    return this.payments.get(s.schoolId, paymentId);
  }

  /** Requires an Idempotency-Key header; a retry with the same key returns the original payment (200). */
  @Post()
  @RequirePermissions('payments.record')
  async record(
    @CurrentSchool() s: SchoolContext,
    @Body(new ZodPipe(PaymentSchema)) body: PaymentInput,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentActor() a: Actor,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = IdempotencyKey.safeParse(key);
    if (!parsed.success) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8 to 100 characters) with each new payment.');
    const result = await this.payments.record(s, body, parsed.data, a);
    res.status(result.status);
    return result.body;
  }

  @Post(':id/reversals')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payments.reverse')
  reverse(@CurrentSchool() s: SchoolContext, @Param('id', id) paymentId: string, @Body(new ZodPipe(ReversalSchema)) body: { reason: string }, @CurrentActor() a: Actor) {
    return this.payments.reverse(s.schoolId, paymentId, body.reason, a);
  }
}

@Controller()
export class FinanceReadsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly reports: FinanceReportsService,
  ) {}

  @Get('receipts/:id')
  @RequirePermissions('receipts.read')
  receipt(@CurrentSchool() s: SchoolContext, @Param('id', id) receiptId: string) {
    return this.payments.receipt(s.schoolId, receiptId);
  }

  @Get('receipts/:id/pdf')
  @RequirePermissions('receipts.read')
  @Header('Cache-Control', 'private, no-store')
  async receiptPdf(@CurrentSchool() s: SchoolContext, @Param('id', id) receiptId: string) {
    const r = await this.payments.receipt(s.schoolId, receiptId);
    const pdf = await receiptPdf(r.data);
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: pdfDisposition(`receipt-${r.data.number}.pdf`), length: pdf.length });
  }

  @Get('students/:studentId/account')
  @RequirePermissions('fees.read')
  account(@CurrentSchool() s: SchoolContext, @Param('studentId', id) studentId: string) {
    return this.reports.studentAccount(s.schoolId, studentId);
  }

  @Get('finance/summary')
  @RequirePermissions('fees.read')
  summary(@CurrentSchool() s: SchoolContext, @Query(new ZodPipe(ReportQuery)) q: { termId: string }) {
    return this.reports.summary(s.schoolId, q.termId);
  }

  @Get('finance/arrears')
  @RequirePermissions('fees.read')
  arrears(@CurrentSchool() s: SchoolContext, @Query(new ZodPipe(ArrearsQuery)) q: ArrearsInput) {
    return this.reports.arrears(s.schoolId, q.termId, q.classId, q.page, q.pageSize);
  }
}
