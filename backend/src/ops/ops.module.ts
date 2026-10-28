import { Module } from '@nestjs/common';
import { OpsController, SchoolEmailsController } from './ops.controller';
import { OpsService } from './ops.service';

@Module({ controllers: [OpsController, SchoolEmailsController], providers: [OpsService] })
export class OpsModule {}
