import { Module } from '@nestjs/common';
import { AcademicYearsService } from './academic-years.service';
import {
  AcademicYearsController,
  ClassesController,
  LevelsController,
  MembersController,
  SubjectsController,
  TermsController,
} from './academics.controller';
import { ClassesService, MembersService } from './classes.service';
import { LevelsService, SubjectsService } from './levels-subjects.service';

@Module({
  controllers: [
    AcademicYearsController,
    TermsController,
    LevelsController,
    SubjectsController,
    ClassesController,
    MembersController,
  ],
  providers: [AcademicYearsService, LevelsService, SubjectsService, ClassesService, MembersService],
})
export class AcademicsModule {}
