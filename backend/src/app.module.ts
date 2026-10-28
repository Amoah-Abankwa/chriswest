import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AcademicsModule } from './academics/academics.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { AccessModule } from './access/scope.service';
import { AuditModule } from './audit/audit.module';
import { AttendanceModule } from './attendance/attendance.module';
import { AuthModule } from './auth/auth.module';
import { ClockModule } from './common/clock';
import { getEnv } from './config/env';
import { ExportsModule } from './exports/exports.module';
import { FinanceModule } from './finance/finance.module';
import { GuardiansModule } from './guardians/guardians.module';
import { HealthController } from './health/health.controller';
import { PlatformModule } from './platform/platform.module';
import { MailModule } from './mail/mail.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OpsModule } from './ops/ops.module';
import { OutboxModule } from './outbox/outbox.module';
import { PortalModule } from './portal/portal.module';
import { PrismaModule } from './prisma/prisma.module';
import { ResultsModule } from './results/results.module';
import { SchoolModule } from './school/school.module';
import { StaffModule } from './staff/staff.module';
import { StorageModule } from './storage/file-storage';
import { StudentsModule } from './students/students.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { TimetableModule } from './timetable/timetable.module';
import { WebsiteModule } from './website/website.module';
import { LeaveModule } from './leave/leave.module';
import { ReportsModule } from './reports/reports.module';
import { LibraryModule } from './library/library.module';
import { TransportModule } from './transport/transport.module';

@Module({
  imports: [
    // Per-IP limits; in-memory, so per process. Auth routes set stricter limits.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
      skipIf: () => getEnv().NODE_ENV === 'test',
    }),
    PrismaModule,
    AccessModule,
    ClockModule,
    MailModule,
    NotificationsModule,
    OutboxModule,
    StorageModule,
    AuditModule,
    TenancyModule,
    AuthModule,
    StudentsModule,
    PlatformModule,
    SchoolModule,
    AcademicsModule,
    StaffModule,
    GuardiansModule,
    PortalModule,
    AttendanceModule,
    FinanceModule,
    ResultsModule,
    TimetableModule,
    AnnouncementsModule,
    ExportsModule,
    OpsModule,
    WebsiteModule,
    LibraryModule,
    TransportModule,
    LeaveModule,
    ReportsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
