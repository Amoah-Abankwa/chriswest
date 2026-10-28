import { Module } from '@nestjs/common';
import { AssessmentsService } from './assessments.service';
import { ReportCardsService } from './report-cards.service';
import { AssessmentsController, ResultsController, StudentReportCardsController } from './results.controller';
import { SheetsService } from './sheets.service';

@Module({
  controllers: [AssessmentsController, ResultsController, StudentReportCardsController],
  providers: [AssessmentsService, SheetsService, ReportCardsService],
  exports: [ReportCardsService],
})
export class ResultsModule {}
