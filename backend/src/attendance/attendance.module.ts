import { Module } from '@nestjs/common';
import { AttendanceController, StudentAttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';

@Module({
  controllers: [AttendanceController, StudentAttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
