import { Module } from '@nestjs/common';
import { PlatformMetricsController, ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({ controllers: [ReportsController, PlatformMetricsController], providers: [ReportsService] })
export class ReportsModule {}
