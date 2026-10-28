import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import { RolesService } from './roles.service';
import {
  InviteStaffSchema,
  ListStaffQuery,
  ReasonSchema,
  RoleSchema,
  SetRolesSchema,
  UpdateRoleSchema,
  UpdateStaffSchema,
  type InviteStaffInput,
  type ListStaffInput,
  type RoleInput,
  type UpdateRoleInput,
  type UpdateStaffInput,
} from './staff.schemas';
import { StaffService } from './staff.service';

const id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });
const actorOf = (auth: AuthContext, req: Request) => ({ auth, correlationId: req.correlationId });

@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @RequirePermissions('staff.read')
  list(@CurrentSchool() s: SchoolContext, @Query(new ZodPipe(ListStaffQuery)) q: ListStaffInput) {
    return this.staff.list(s.schoolId, q);
  }

  @Post('invitations')
  @RequirePermissions('staff.create')
  invite(
    @CurrentSchool() s: SchoolContext,
    @Body(new ZodPipe(InviteStaffSchema)) body: InviteStaffInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.staff.invite(s.schoolId, body, actorOf(auth, req));
  }

  @Get(':id')
  @RequirePermissions('staff.read')
  get(@CurrentSchool() s: SchoolContext, @Param('id', id) membershipId: string, @CurrentAuth() auth: AuthContext, @Req() req: Request) {
    return this.staff.get(s.schoolId, membershipId, actorOf(auth, req));
  }

  @Patch(':id')
  @RequirePermissions('staff.update')
  update(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) membershipId: string,
    @Body(new ZodPipe(UpdateStaffSchema)) body: UpdateStaffInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.staff.update(s.schoolId, membershipId, body, actorOf(auth, req));
  }

  @Put(':id/roles')
  @RequirePermissions('staff.update')
  setRoles(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) membershipId: string,
    @Body(new ZodPipe(SetRolesSchema)) body: { roleIds: string[] },
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.staff.setRoles(s.schoolId, membershipId, body.roleIds, actorOf(auth, req));
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('staff.deactivate')
  deactivate(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) membershipId: string,
    @Body(new ZodPipe(ReasonSchema)) body: { reason: string },
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.staff.deactivate(s.schoolId, membershipId, body.reason, actorOf(auth, req));
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('staff.deactivate')
  reactivate(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) membershipId: string,
    @Body(new ZodPipe(ReasonSchema)) body: { reason: string },
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.staff.reactivate(s.schoolId, membershipId, body.reason, actorOf(auth, req));
  }

  @Post(':id/resend-invitation')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('staff.create')
  resend(@CurrentSchool() s: SchoolContext, @Param('id', id) membershipId: string, @CurrentAuth() auth: AuthContext, @Req() req: Request) {
    return this.staff.resendInvitation(s.schoolId, membershipId, actorOf(auth, req));
  }

  @Get(':id/history')
  @RequirePermissions('staff.read')
  history(@CurrentSchool() s: SchoolContext, @Param('id', id) membershipId: string) {
    return this.staff.history(s.schoolId, membershipId);
  }
}

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermissions('roles.read')
  list(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext) {
    return this.roles.list(s.schoolId, auth);
  }

  @Get(':id')
  @RequirePermissions('roles.read')
  get(@CurrentSchool() s: SchoolContext, @Param('id', id) roleId: string, @CurrentAuth() auth: AuthContext) {
    return this.roles.get(s.schoolId, roleId, auth);
  }

  @Post()
  @RequirePermissions('roles.manage')
  create(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(RoleSchema)) body: RoleInput, @CurrentAuth() auth: AuthContext, @Req() req: Request) {
    return this.roles.create(s.schoolId, body, actorOf(auth, req));
  }

  @Patch(':id')
  @RequirePermissions('roles.manage')
  update(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) roleId: string,
    @Body(new ZodPipe(UpdateRoleSchema)) body: UpdateRoleInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.roles.update(s.schoolId, roleId, body, actorOf(auth, req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('roles.manage')
  remove(@CurrentSchool() s: SchoolContext, @Param('id', id) roleId: string, @CurrentAuth() auth: AuthContext, @Req() req: Request) {
    return this.roles.remove(s.schoolId, roleId, actorOf(auth, req));
  }

  @Get(':id/history')
  @RequirePermissions('roles.read')
  history(@CurrentSchool() s: SchoolContext, @Param('id', id) roleId: string) {
    return this.roles.history(s.schoolId, roleId);
  }
}

@Controller('permissions')
export class PermissionsController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermissions('roles.read')
  catalog(@CurrentAuth() auth: AuthContext) {
    return this.roles.catalog(auth);
  }
}

@Controller('me')
export class MeController {
  constructor(private readonly staff: StaffService) {}

  /** Own data only: no permission beyond being a member of this school. */
  @Get('assignments')
  assignments(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext) {
    return this.staff.myAssignments(s.schoolId, auth.membershipId!);
  }
}
