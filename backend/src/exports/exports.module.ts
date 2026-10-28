import { Module } from '@nestjs/common';
import { PortalService } from '../portal/portal.service';
import { ResultsModule } from '../results/results.module';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

@Module({ imports: [ResultsModule], controllers: [ExportsController], providers: [ExportsService, PortalService] })
export class ExportsModule {}
