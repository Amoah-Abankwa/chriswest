import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformSchoolService } from './platform-school.service';
import { PlatformController } from './platform.controller';

@Module({
  imports: [AuthModule],
  controllers: [PlatformController],
  providers: [PlatformSchoolService],
})
export class PlatformModule {}
