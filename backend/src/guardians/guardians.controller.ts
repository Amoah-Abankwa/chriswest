import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ScopeService } from '../access/scope.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentActor, CurrentAuth, RequirePermissions, type Actor } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import {
  GuardianSchema,
  LinkGuardianSchema,
  ListGuardiansQuery,
  UpdateGuardianSchema,
  UpdateLinkSchema,
  type GuardianInput,
  type LinkGuardianInput,
  type ListGuardiansInput,
  type UpdateGuardianInput,
  type UpdateLinkInput,
} from './guardians.schemas';
import { GuardiansService } from './guardians.service';

const id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });

@Controller('guardians')
export class GuardiansController {
  constructor(
    private readonly guardians: GuardiansService,
    private readonly scope: ScopeService,
  ) {}

  @Get()
  @RequirePermissions('parents.read')
  list(@CurrentSchool() s: SchoolContext, @Query(new ZodPipe(ListGuardiansQuery)) q: ListGuardiansInput, @CurrentAuth() auth: AuthContext) {
    return this.guardians.list(s.schoolId, q, this.scope.guardianFilter(auth, 'parents.read'));
  }

  @Get(':id')
  @RequirePermissions('parents.read')
  get(@CurrentSchool() s: SchoolContext, @Param('id', id) guardianId: string, @CurrentAuth() auth: AuthContext) {
    return this.guardians.get(s.schoolId, guardianId, this.scope.guardianFilter(auth, 'parents.read'));
  }

  @Post()
  @RequirePermissions('parents.manage')
  create(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(GuardianSchema)) body: GuardianInput, @CurrentActor() a: Actor) {
    return this.guardians.create(s.schoolId, body, a);
  }

  @Patch(':id')
  @RequirePermissions('parents.manage')
  update(@CurrentSchool() s: SchoolContext, @Param('id', id) guardianId: string, @Body(new ZodPipe(UpdateGuardianSchema)) body: UpdateGuardianInput, @CurrentActor() a: Actor) {
    return this.guardians.update(s.schoolId, guardianId, body, a);
  }

  @Post(':id/invite')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('parents.manage')
  invite(@CurrentSchool() s: SchoolContext, @Param('id', id) guardianId: string, @CurrentActor() a: Actor) {
    return this.guardians.invite(s.schoolId, guardianId, a);
  }

  @Post(':id/revoke-access')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('parents.manage')
  revoke(@CurrentSchool() s: SchoolContext, @Param('id', id) guardianId: string, @CurrentActor() a: Actor) {
    return this.guardians.revokeAccess(s.schoolId, guardianId, a);
  }
}

@Controller('students/:studentId/guardians')
export class StudentGuardiansController {
  constructor(
    private readonly guardians: GuardiansService,
    private readonly scope: ScopeService,
  ) {}

  @Get()
  @RequirePermissions('parents.read')
  list(@CurrentSchool() s: SchoolContext, @Param('studentId', id) studentId: string, @CurrentAuth() auth: AuthContext) {
    return this.guardians.forStudent(s.schoolId, studentId, this.scope.studentFilter(auth, 'parents.read'));
  }

  @Post()
  @RequirePermissions('parents.manage')
  link(@CurrentSchool() s: SchoolContext, @Param('studentId', id) studentId: string, @Body(new ZodPipe(LinkGuardianSchema)) body: LinkGuardianInput, @CurrentActor() a: Actor) {
    return this.guardians.link(s.schoolId, studentId, body, a);
  }

  @Patch(':guardianId')
  @RequirePermissions('parents.manage')
  updateLink(
    @CurrentSchool() s: SchoolContext,
    @Param('studentId', id) studentId: string,
    @Param('guardianId', id) guardianId: string,
    @Body(new ZodPipe(UpdateLinkSchema)) body: UpdateLinkInput,
    @CurrentActor() a: Actor,
  ) {
    return this.guardians.updateLink(s.schoolId, studentId, guardianId, body, a);
  }

  @Delete(':guardianId')
  @RequirePermissions('parents.manage')
  unlink(@CurrentSchool() s: SchoolContext, @Param('studentId', id) studentId: string, @Param('guardianId', id) guardianId: string, @CurrentActor() a: Actor) {
    return this.guardians.unlink(s.schoolId, studentId, guardianId, a);
  }
}
