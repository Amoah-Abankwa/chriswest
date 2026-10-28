import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { getEnv } from '../config/env';
import { PlatformSchoolService } from './platform-school.service';
import { PlatformGuard, PlatformRoles } from './platform.guard';
import { AddOwnerSchema, ChangeStatusSchema, CreateSchoolSchema, type AddOwnerInput, type ChangeStatusInput, type CreateSchoolInput } from './platform.schemas';

const uuid = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });

/** Super admin only (Support can look). Reachable only on PLATFORM_ADMIN_HOST. */
@Controller('platform')
@UseGuards(PlatformGuard)
export class PlatformController {
  constructor(private readonly school: PlatformSchoolService) {}

  @Get('settings')
  @PlatformRoles('SUPER_ADMIN', 'SUPPORT')
  settings() {
    return { data: { schoolHost: getEnv().SCHOOL_HOST } };
  }

  @Get('school')
  @PlatformRoles('SUPER_ADMIN', 'SUPPORT')
  current() {
    return this.school.current();
  }

  @Post('school')
  create(@Body(new ZodPipe(CreateSchoolSchema)) body: CreateSchoolInput, @CurrentAuth() auth: AuthContext, @Req() req: Request) {
    return this.school.create(body, { auth, correlationId: req.correlationId });
  }

  @Post('school/owners')
  addOwner(@Body(new ZodPipe(AddOwnerSchema)) body: AddOwnerInput, @CurrentAuth() auth: AuthContext, @Req() req: Request) {
    return this.school.addOwner(body, { auth, correlationId: req.correlationId });
  }

  @Post('school/owners/:userId/resend-invitation')
  @HttpCode(HttpStatus.OK)
  resend(@Param('userId', uuid) userId: string, @CurrentAuth() auth: AuthContext, @Req() req: Request) {
    return this.school.resendInvitation(userId, { auth, correlationId: req.correlationId });
  }

  @Patch('school/status')
  changeStatus(@Body(new ZodPipe(ChangeStatusSchema)) body: ChangeStatusInput, @CurrentAuth() auth: AuthContext, @Req() req: Request) {
    return this.school.changeStatus(body, { auth, correlationId: req.correlationId });
  }
}
