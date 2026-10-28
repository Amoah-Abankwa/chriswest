import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DocumentsService } from './documents.service';
import { StudentAccountsService } from './student-accounts.service';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';

@Module({
  imports: [AuthModule],
  controllers: [StudentsController],
  providers: [StudentsService, DocumentsService, StudentAccountsService],
})
export class StudentsModule {}
