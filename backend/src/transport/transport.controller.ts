import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor, RequirePermissions, type Actor } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import { AssignSchema, RouteSchema, StopsSchema, TransportService } from './transport.service';

const id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });
@Controller()
export class TransportController {
  constructor(private readonly transport: TransportService) {}

  @Get('transport/routes')
  @RequirePermissions('transport.read')
  routes(@CurrentSchool() s: SchoolContext) {
    return this.transport.routes(s.schoolId);
  }

  @Get('transport/routes/:id')
  @RequirePermissions('transport.read')
  route(@CurrentSchool() s: SchoolContext, @Param('id', id) routeId: string) {
    return this.transport.route(s.schoolId, routeId);
  }

  @Post('transport/routes')
  @RequirePermissions('transport.manage')
  create(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(RouteSchema)) body: z.infer<typeof RouteSchema>, @CurrentActor() a: Actor) {
    return this.transport.createRoute(s.schoolId, body, a);
  }

  @Patch('transport/routes/:id')
  @RequirePermissions('transport.manage')
  update(@CurrentSchool() s: SchoolContext, @Param('id', id) routeId: string, @Body(new ZodPipe(RouteSchema.partial())) body: Partial<z.infer<typeof RouteSchema>>, @CurrentActor() a: Actor) {
    return this.transport.updateRoute(s.schoolId, routeId, body, a);
  }

  @Put('transport/routes/:id/stops')
  @RequirePermissions('transport.manage')
  stops(@CurrentSchool() s: SchoolContext, @Param('id', id) routeId: string, @Body(new ZodPipe(StopsSchema)) body: z.infer<typeof StopsSchema>, @CurrentActor() a: Actor) {
    return this.transport.setStops(s.schoolId, routeId, body.stops, a);
  }

  @Get('students/:studentId/transport')
  @RequirePermissions('transport.read')
  forStudent(@CurrentSchool() s: SchoolContext, @Param('studentId', id) studentId: string) {
    return this.transport.forStudent(s.schoolId, studentId);
  }

  @Put('students/:studentId/transport')
  @RequirePermissions('transport.manage')
  assign(@CurrentSchool() s: SchoolContext, @Param('studentId', id) studentId: string, @Body(new ZodPipe(AssignSchema)) body: z.infer<typeof AssignSchema>, @CurrentActor() a: Actor) {
    return this.transport.assign(s.schoolId, studentId, body, a);
  }

  @Delete('students/:studentId/transport')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('transport.manage')
  unassign(@CurrentSchool() s: SchoolContext, @Param('studentId', id) studentId: string, @CurrentActor() a: Actor) {
    return this.transport.unassign(s.schoolId, studentId, a);
  }
}
