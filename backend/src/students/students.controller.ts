import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { ScopeService } from '../access/scope.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentActor, CurrentAuth, RequirePermissions, type Actor } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { contentDisposition, MAX_UPLOAD_BYTES } from '../storage/file-type';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import { DocumentsService } from './documents.service';
import { StudentAccountsService } from './student-accounts.service';
import {
  AdmitStudentSchema,
  EnrollSchema,
  ListStudentsQuery,
  TransferSchema,
  UpdateStudentSchema,
  UploadDocumentSchema,
  WithdrawSchema,
  type AdmitStudentInput,
  type EnrollInput,
  type ListStudentsInput,
  type TransferInput,
  type UpdateStudentInput,
  type UploadDocumentInput,
  type WithdrawInput,
} from './students.schemas';
import { StudentsService } from './students.service';

const id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });
const AccountSchema = z.object({ email: z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'Enter a valid email address' })) });

@Controller('students')
export class StudentsController {
  constructor(
    private readonly students: StudentsService,
    private readonly documents: DocumentsService,
    private readonly scope: ScopeService,
    private readonly accounts: StudentAccountsService,
  ) {}

  @Get()
  @RequirePermissions('students.read')
  list(@CurrentSchool() s: SchoolContext, @Query(new ZodPipe(ListStudentsQuery)) q: ListStudentsInput, @CurrentAuth() auth: AuthContext) {
    return this.students.list(s.schoolId, q, this.scope.studentFilter(auth, 'students.read'));
  }

  @Get(':id')
  @RequirePermissions('students.read')
  get(@CurrentSchool() s: SchoolContext, @Param('id', id) studentId: string, @CurrentAuth() auth: AuthContext) {
    return this.students.get(s.schoolId, studentId, this.scope.studentFilter(auth, 'students.read'));
  }

  @Post()
  @RequirePermissions('students.create')
  admit(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(AdmitStudentSchema)) body: AdmitStudentInput, @CurrentActor() a: Actor) {
    return this.students.admit(s, body, a);
  }

  @Patch(':id')
  @RequirePermissions('students.update')
  update(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) studentId: string,
    @Body(new ZodPipe(UpdateStudentSchema)) body: UpdateStudentInput,
    @CurrentActor() a: Actor,
  ) {
    return this.students.update(s.schoolId, studentId, body, a);
  }

  @Get(':id/history')
  @RequirePermissions('students.update')
  history(@CurrentSchool() s: SchoolContext, @Param('id', id) studentId: string) {
    return this.students.history(s.schoolId, studentId);
  }

  @Post(':id/enrollments')
  @RequirePermissions('students.update')
  enroll(@CurrentSchool() s: SchoolContext, @Param('id', id) studentId: string, @Body(new ZodPipe(EnrollSchema)) body: EnrollInput, @CurrentActor() a: Actor) {
    return this.students.enroll(s, studentId, body, a);
  }

  @Post(':id/transfer')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('students.transfer')
  transfer(@CurrentSchool() s: SchoolContext, @Param('id', id) studentId: string, @Body(new ZodPipe(TransferSchema)) body: TransferInput, @CurrentActor() a: Actor) {
    return this.students.transfer(s, studentId, body, a);
  }

  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('students.transfer')
  withdraw(@CurrentSchool() s: SchoolContext, @Param('id', id) studentId: string, @Body(new ZodPipe(WithdrawSchema)) body: WithdrawInput, @CurrentActor() a: Actor) {
    return this.students.withdraw(s, studentId, body, a);
  }

  // ----- Student's own portal account -----

  @Post(':id/account')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('students.update')
  inviteAccount(@CurrentSchool() s: SchoolContext, @Param('id', id) studentId: string, @Body(new ZodPipe(AccountSchema)) body: { email: string }, @CurrentActor() a: Actor) {
    return this.accounts.invite(s.schoolId, studentId, body.email, a);
  }

  @Post(':id/account/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('students.update')
  revokeAccount(@CurrentSchool() s: SchoolContext, @Param('id', id) studentId: string, @CurrentActor() a: Actor) {
    return this.accounts.revoke(s.schoolId, studentId, a);
  }

  // ----- Documents: private by default, every download authorized and audited -----

  @Get(':id/documents')
  @RequirePermissions('documents.read')
  listDocuments(@CurrentSchool() s: SchoolContext, @Param('id', id) studentId: string) {
    return this.documents.list(s.schoolId, studentId);
  }

  @Post(':id/documents')
  @RequirePermissions('documents.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } }))
  upload(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) studentId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodPipe(UploadDocumentSchema)) body: UploadDocumentInput,
    @CurrentActor() a: Actor,
  ) {
    return this.documents.upload(s.schoolId, studentId, file, body, a);
  }

  @Get(':id/documents/:documentId/download')
  @RequirePermissions('documents.read')
  @Header('Cache-Control', 'private, no-store')
  async download(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) studentId: string,
    @Param('documentId', id) documentId: string,
    @CurrentActor() a: Actor,
  ) {
    const file = await this.documents.download(s.schoolId, studentId, documentId, a);
    return new StreamableFile(file.body, {
      type: file.contentType,
      disposition: contentDisposition(file.originalName),
      length: file.body.length,
    });
  }

  @Delete(':id/documents/:documentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('documents.manage')
  removeDocument(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) studentId: string,
    @Param('documentId', id) documentId: string,
    @CurrentActor() a: Actor,
  ) {
    return this.documents.remove(s.schoolId, studentId, documentId, a);
  }
}
