import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { FinanceModule } from '../finance/finance.module';
import { ResultsModule } from '../results/results.module';
import { TimetableModule } from '../timetable/timetable.module';
import { LibraryModule } from '../library/library.module';
import { TransportModule } from '../transport/transport.module';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';

@Module({ imports: [AttendanceModule, FinanceModule, ResultsModule, TimetableModule, LibraryModule, TransportModule], controllers: [PortalController], providers: [PortalService] })
export class PortalModule {}
