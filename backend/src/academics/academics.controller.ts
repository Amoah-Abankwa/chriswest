import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ScopeService } from '../access/scope.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentActor, CurrentAuth, RequirePermissions, type Actor } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import { AcademicYearsService } from './academic-years.service';
import {
  ActivateYearSchema,
  AddStandardLevelsSchema,
  CreateClassSchema,
  CreateLevelSchema,
  CreateSubjectSchema,
  CreateTermSchema,
  CreateYearSchema,
  ListClassesQuery,
  SetClassSubjectsSchema,
  SetClassTeacherSchema,
  UpdateClassSchema,
  UpdateLevelSchema,
  UpdateSubjectSchema,
  UpdateTermSchema,
  UpdateYearSchema,
  type CreateClassInput,
  type CreateLevelInput,
  type CreateSubjectInput,
  type CreateTermInput,
  type CreateYearInput,
  type SetClassSubjectsInput,
  type UpdateClassInput,
  type UpdateLevelInput,
  type UpdateSubjectInput,
  type UpdateTermInput,
  type UpdateYearInput,
} from './academics.schemas';
import { ClassesService, MembersService } from './classes.service';
import { LevelsService, SubjectsService } from './levels-subjects.service';

// A malformed ID is just a record that doesn't exist.
const id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });
const READ = 'academics.read' as const;
const MANAGE = 'academics.manage' as const;

@Controller('academic-years')
export class AcademicYearsController {
  constructor(private readonly years: AcademicYearsService) {}

  @Get()
  @RequirePermissions(READ)
  list(@CurrentSchool() s: SchoolContext) {
    return this.years.list(s.schoolId);
  }

  @Get(':id')
  @RequirePermissions(READ)
  get(@CurrentSchool() s: SchoolContext, @Param('id', id) yearId: string) {
    return this.years.get(s.schoolId, yearId);
  }

  @Post()
  @RequirePermissions(MANAGE)
  create(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(CreateYearSchema)) body: CreateYearInput, @CurrentActor() a: Actor) {
    return this.years.create(s.schoolId, body, a);
  }

  @Patch(':id')
  @RequirePermissions(MANAGE)
  update(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) yearId: string,
    @Body(new ZodPipe(UpdateYearSchema)) body: UpdateYearInput,
    @CurrentActor() a: Actor,
  ) {
    return this.years.update(s.schoolId, yearId, body, a);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(MANAGE)
  remove(@CurrentSchool() s: SchoolContext, @Param('id', id) yearId: string, @CurrentActor() a: Actor) {
    return this.years.remove(s.schoolId, yearId, a);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(MANAGE)
  activate(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) yearId: string,
    @Body(new ZodPipe(ActivateYearSchema)) body: { closeCurrent: boolean },
    @CurrentActor() a: Actor,
  ) {
    return this.years.activate(s.schoolId, yearId, body.closeCurrent, a);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(MANAGE)
  close(@CurrentSchool() s: SchoolContext, @Param('id', id) yearId: string, @CurrentActor() a: Actor) {
    return this.years.close(s.schoolId, yearId, a);
  }

  @Post(':id/terms')
  @RequirePermissions(MANAGE)
  addTerm(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) yearId: string,
    @Body(new ZodPipe(CreateTermSchema)) body: CreateTermInput,
    @CurrentActor() a: Actor,
  ) {
    return this.years.addTerm(s.schoolId, yearId, body, a);
  }
}

@Controller('terms')
export class TermsController {
  constructor(private readonly years: AcademicYearsService) {}

  @Patch(':id')
  @RequirePermissions(MANAGE)
  update(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) termId: string,
    @Body(new ZodPipe(UpdateTermSchema)) body: UpdateTermInput,
    @CurrentActor() a: Actor,
  ) {
    return this.years.updateTerm(s.schoolId, termId, body, a);
  }

  @Delete(':id')
  @RequirePermissions(MANAGE)
  remove(@CurrentSchool() s: SchoolContext, @Param('id', id) termId: string, @CurrentActor() a: Actor) {
    return this.years.removeTerm(s.schoolId, termId, a);
  }
}

@Controller('education-levels')
export class LevelsController {
  constructor(private readonly levels: LevelsService) {}

  @Get()
  @RequirePermissions(READ)
  list(@CurrentSchool() s: SchoolContext) {
    return this.levels.list(s.schoolId);
  }

  @Post()
  @RequirePermissions(MANAGE)
  create(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(CreateLevelSchema)) body: CreateLevelInput, @CurrentActor() a: Actor) {
    return this.levels.create(s.schoolId, body, a);
  }

  @Post('standard')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(MANAGE)
  addStandard(
    @CurrentSchool() s: SchoolContext,
    @Body(new ZodPipe(AddStandardLevelsSchema)) body: { stages: CreateLevelInput['stage'][] },
    @CurrentActor() a: Actor,
  ) {
    return this.levels.addStandard(s.schoolId, body.stages, a);
  }

  @Patch(':id')
  @RequirePermissions(MANAGE)
  update(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) levelId: string,
    @Body(new ZodPipe(UpdateLevelSchema)) body: UpdateLevelInput,
    @CurrentActor() a: Actor,
  ) {
    return this.levels.update(s.schoolId, levelId, body, a);
  }
}

@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjects: SubjectsService) {}

  @Get()
  @RequirePermissions(READ)
  list(@CurrentSchool() s: SchoolContext) {
    return this.subjects.list(s.schoolId);
  }

  @Post()
  @RequirePermissions(MANAGE)
  create(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(CreateSubjectSchema)) body: CreateSubjectInput, @CurrentActor() a: Actor) {
    return this.subjects.create(s.schoolId, body, a);
  }

  @Post('common')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(MANAGE)
  addCommon(@CurrentSchool() s: SchoolContext, @CurrentActor() a: Actor) {
    return this.subjects.addCommon(s.schoolId, a);
  }

  @Patch(':id')
  @RequirePermissions(MANAGE)
  update(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) subjectId: string,
    @Body(new ZodPipe(UpdateSubjectSchema)) body: UpdateSubjectInput,
    @CurrentActor() a: Actor,
  ) {
    return this.subjects.update(s.schoolId, subjectId, body, a);
  }
}

@Controller('classes')
export class ClassesController {
  constructor(
    private readonly classes: ClassesService,
    private readonly scope: ScopeService,
  ) {}

  @Get()
  @RequirePermissions(READ)
  list(
    @CurrentSchool() s: SchoolContext,
    @Query(new ZodPipe(ListClassesQuery)) q: { academicYearId?: string },
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.classes.list(s.schoolId, q.academicYearId, this.scope.classFilter(auth, READ));
  }

  @Get(':id')
  @RequirePermissions(READ)
  get(@CurrentSchool() s: SchoolContext, @Param('id', id) classId: string, @CurrentAuth() auth: AuthContext) {
    return this.classes.get(s.schoolId, classId, this.scope.classFilter(auth, READ));
  }

  @Post()
  @RequirePermissions(MANAGE)
  create(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(CreateClassSchema)) body: CreateClassInput, @CurrentActor() a: Actor) {
    return this.classes.create(s.schoolId, body, a);
  }

  @Patch(':id')
  @RequirePermissions(MANAGE)
  update(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) classId: string,
    @Body(new ZodPipe(UpdateClassSchema)) body: UpdateClassInput,
    @CurrentActor() a: Actor,
  ) {
    return this.classes.update(s.schoolId, classId, body, a);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(MANAGE)
  remove(@CurrentSchool() s: SchoolContext, @Param('id', id) classId: string, @CurrentActor() a: Actor) {
    return this.classes.remove(s.schoolId, classId, a);
  }

  @Put(':id/class-teacher')
  @RequirePermissions(MANAGE)
  setClassTeacher(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) classId: string,
    @Body(new ZodPipe(SetClassTeacherSchema)) body: { membershipId: string | null },
    @CurrentActor() a: Actor,
  ) {
    return this.classes.setClassTeacher(s.schoolId, classId, body.membershipId, a);
  }

  @Put(':id/subjects')
  @RequirePermissions(MANAGE)
  setSubjects(
    @CurrentSchool() s: SchoolContext,
    @Param('id', id) classId: string,
    @Body(new ZodPipe(SetClassSubjectsSchema)) body: SetClassSubjectsInput,
    @CurrentActor() a: Actor,
  ) {
    return this.classes.setSubjects(s.schoolId, classId, body, a);
  }
}

@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequirePermissions(MANAGE)
  list(@CurrentSchool() s: SchoolContext) {
    return this.members.list(s.schoolId);
  }
}
