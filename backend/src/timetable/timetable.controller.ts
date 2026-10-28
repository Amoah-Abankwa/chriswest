import { Body, Controller, Get, HttpStatus, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ScopeService } from '../access/scope.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentActor, CurrentAuth, RequirePermissions, type Actor } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import { ClassTimetableSchema, PeriodsSchema, TimetableService, type ClassTimetableInput, type PeriodsInput } from './timetable.service';

const id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });

@Controller('timetable')
export class TimetableController {
  constructor(
    private readonly timetable: TimetableService,
    private readonly scope: ScopeService,
  ) {}

  @Get('periods')
  @RequirePermissions('academics.read')
  async periods(@CurrentSchool() s: SchoolContext) {
    return { data: await this.timetable.periods(s.schoolId) };
  }

  @Put('periods')
  @RequirePermissions('timetable.manage')
  setPeriods(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(PeriodsSchema)) body: PeriodsInput, @CurrentActor() a: Actor) {
    return this.timetable.setPeriods(s.schoolId, body, a);
  }

  @Get('classes/:classId')
  @RequirePermissions('academics.read')
  forClass(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('classId', id) classId: string) {
    return this.timetable.forClass(s.schoolId, classId, this.scope.classFilter(auth, 'academics.read'));
  }

  @Put('classes/:classId')
  @RequirePermissions('timetable.manage')
  setForClass(@CurrentSchool() s: SchoolContext, @Param('classId', id) classId: string, @Body(new ZodPipe(ClassTimetableSchema)) body: ClassTimetableInput, @CurrentActor() a: Actor) {
    return this.timetable.setForClass(s.schoolId, classId, body, a);
  }

  /** The signed-in teacher's own week. */
  @Get('mine')
  mine(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext) {
    return this.timetable.forTeacher(s.schoolId, auth.membershipId!);
  }
}
