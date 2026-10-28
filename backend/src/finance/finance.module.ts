import { Module } from '@nestjs/common';
import { FeeSetupService } from './fee-setup.service';
import {
  FeeCategoriesController,
  FeeStructuresController,
  FinanceReadsController,
  InvoicesController,
  PaymentsController,
} from './finance.controller';
import { FinanceReportsService } from './finance-reports.service';
import { InvoicesService } from './invoices.service';
import { PaymentsService } from './payments.service';

@Module({
  controllers: [FeeCategoriesController, FeeStructuresController, InvoicesController, PaymentsController, FinanceReadsController],
  providers: [FeeSetupService, InvoicesService, PaymentsService, FinanceReportsService],
  exports: [PaymentsService, FinanceReportsService],
})
export class FinanceModule {}
