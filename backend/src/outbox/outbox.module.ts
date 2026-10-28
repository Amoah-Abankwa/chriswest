import { Module } from '@nestjs/common';
import { AuthTokensService } from '../auth/auth-tokens.service';
import { ReportCardsService } from '../results/report-cards.service';
import { AccountEmailHandler } from './handlers/account-email';
import { AnnouncementPublishedHandler } from './handlers/announcement-published';
import { AttendanceAbsentHandler } from './handlers/attendance-absent';
import { ExportReportCardsHandler } from './handlers/export-report-cards';
import { ExportSchoolDataHandler } from './handlers/export-school-data';
import { PaymentRecordedHandler } from './handlers/payment-recorded';
import { ResultsPublishedHandler } from './handlers/results-published';
import { SendEmailHandler } from './handlers/send-email';
import { OutboxProcessor } from './outbox.processor';

/**
 * Everything the worker runs. Handlers depend only on the database, mail, storage and
 * notifications, so this module loads in the worker without the web app's guards and controllers.
 */
@Module({
  providers: [
    OutboxProcessor,
    AttendanceAbsentHandler,
    ResultsPublishedHandler,
    PaymentRecordedHandler,
    AnnouncementPublishedHandler,
    AccountEmailHandler,
    ExportReportCardsHandler,
    ExportSchoolDataHandler,
    SendEmailHandler,
    AuthTokensService,
    ReportCardsService,
  ],
  exports: [OutboxProcessor],
})
export class OutboxModule {}
