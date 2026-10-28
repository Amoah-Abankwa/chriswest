import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { CurrentActor, RequirePermissions, type Actor } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import { UpdateSchoolSchema, type UpdateSchoolInput } from './school.schemas';
import { SchoolService } from './school.service';

@Controller('school')
export class SchoolController {
  constructor(private readonly school: SchoolService) {}

  @Get()
  @RequirePermissions('school.read')
  get(@CurrentSchool() s: SchoolContext) {
    return this.school.getProfile(s.schoolId);
  }

  @Patch()
  @RequirePermissions('school.update')
  update(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(UpdateSchoolSchema)) body: UpdateSchoolInput, @CurrentActor() actor: Actor) {
    return this.school.updateProfile(s.schoolId, body, actor);
  }

  @Get('setup')
  @RequirePermissions('school.read')
  setup(@CurrentSchool() s: SchoolContext) {
    return this.school.setupStatus(s.schoolId);
  }

  @Post('setup/complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('school.update')
  complete(@CurrentSchool() s: SchoolContext, @CurrentActor() actor: Actor) {
    return this.school.completeSetup(s.schoolId, actor);
  }
}
