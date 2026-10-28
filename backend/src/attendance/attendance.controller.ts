import { Body, Controller, Get, HttpStatus, Param, ParseUUIDPipe, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ScopeService } from '../access/scope.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../auth/decorators';
import { notFound } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import {
  ClassesQuery,
  RangeQuery,
  RegisterQuery,
  SaveRegisterSchema,
  SummaryQuery,
  type RangeInput,
  type SaveRegisterInput,
  type SummaryInput,
} from './attendance.schemas';
import { AttendanceService } from './attendance.service';

const id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });

@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('classes')
  @RequirePermissions('attendance.read')
  classes(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Query(new ZodPipe(ClassesQuery)) q: { date?: string }) {
    return this.attendance.classesForDate(s, auth, q.date);
  }

  @Get('register')
  @RequirePermissions('attendance.read')
  register(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Query(new ZodPipe(RegisterQuery)) q: { classId: string; date?: string }) {
    return this.attendance.register(s, auth, q.classId, q.date);
  }

  /** Corrections additionally need attendance.correct; the service checks that per class. */
  @Put('register')
  @RequirePermissions('attendance.record')
  save(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Body(new ZodPipe(SaveRegisterSchema)) body: SaveRegisterInput, @Req() req: Request) {
    return this.attendance.save(s, auth, body, req.correlationId);
  }

  @Get('summary')
  @RequirePermissions('attendance.read')
  summary(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Query(new ZodPipe(SummaryQuery)) q: SummaryInput) {
    return this.attendance.summary(s, auth, q.classId, q.from, q.to);
  }
}

@Controller('students/:studentId/attendance')
export class StudentAttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly scope: ScopeService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @RequirePermissions('attendance.read')
  async get(
    @CurrentSchool() s: SchoolContext,
    @CurrentAuth() auth: AuthContext,
    @Param('studentId', id) studentId: string,
    @Query(new ZodPipe(RangeQuery)) q: RangeInput,
  ) {
    const visible = await this.prisma.student.findFirst({
      where: { AND: [{ schoolId: s.schoolId, id: studentId }, this.scope.studentFilter(auth, 'attendance.read')] },
      select: { id: true },
    });
    if (!visible) throw notFound('Student not found');
    return this.attendance.forStudent(s, studentId, q.from, q.to);
  }
}
