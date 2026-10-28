import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentActor, CurrentAuth, RequirePermissions, type Actor } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import { DecisionSchema, LeaveRequestSchema, LeaveService, LeaveTypeSchema, RequestsQuery } from './leave.service';

const id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });
@Controller('leave')
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  /** Any staff member: their own allowances and requests. */
  @Get('mine')
  mine(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Query(new ZodPipe(z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }))) q: { year?: number }) {
    return this.leave.mine(s.schoolId, auth, q.year);
  }

  @Get('types')
  types(@CurrentSchool() s: SchoolContext) {
    return this.leave.types(s.schoolId);
  }

  @Post('types')
  @RequirePermissions('leave.manage')
  createType(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(LeaveTypeSchema)) body: z.infer<typeof LeaveTypeSchema>, @CurrentActor() a: Actor) {
    return this.leave.createType(s.schoolId, body, a);
  }

  @Patch('types/:id')
  @RequirePermissions('leave.manage')
  updateType(@CurrentSchool() s: SchoolContext, @Param('id', id) typeId: string, @Body(new ZodPipe(LeaveTypeSchema.partial())) body: Partial<z.infer<typeof LeaveTypeSchema>>, @CurrentActor() a: Actor) {
    return this.leave.updateType(s.schoolId, typeId, body, a);
  }

  @Post('requests')
  request(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Body(new ZodPipe(LeaveRequestSchema)) body: z.infer<typeof LeaveRequestSchema>, @CurrentActor() a: Actor) {
    return this.leave.request(s.schoolId, auth, body, a);
  }

  @Post('requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', id) requestId: string, @CurrentActor() a: Actor) {
    return this.leave.cancel(s.schoolId, auth, requestId, a);
  }

  @Get('requests')
  @RequirePermissions('leave.approve')
  requests(@CurrentSchool() s: SchoolContext, @Query(new ZodPipe(RequestsQuery)) q: z.infer<typeof RequestsQuery>) {
    return this.leave.requests(s.schoolId, q.status);
  }

  @Post('requests/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('leave.approve')
  approve(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', id) requestId: string, @Body(new ZodPipe(DecisionSchema)) body: { note?: string }, @CurrentActor() a: Actor) {
    return this.leave.decide(s.schoolId, requestId, 'APPROVED', body.note, auth, a);
  }

  @Post('requests/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('leave.approve')
  reject(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', id) requestId: string, @Body(new ZodPipe(DecisionSchema)) body: { note?: string }, @CurrentActor() a: Actor) {
    return this.leave.decide(s.schoolId, requestId, 'REJECTED', body.note, auth, a);
  }
}
