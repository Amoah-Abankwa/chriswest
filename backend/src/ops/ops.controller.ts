import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor, RequirePermissions, type Actor } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { PlatformGuard, PlatformRoles } from '../platform/platform.guard';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import { OpsService } from './ops.service';

const page = { page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) };
const EventsQuery = z.object({ status: z.enum(['failed', 'pending', 'processed']).default('failed'), type: z.string().max(60).optional(), ...page });
const EmailsQuery = z.object({ status: z.enum(['SENT', 'FAILED']).optional(), ...page });

@Controller('platform/ops')
@UseGuards(PlatformGuard)
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get('summary')
  @PlatformRoles('SUPER_ADMIN', 'SUPPORT')
  summary() {
    return this.ops.summary();
  }

  @Get('events')
  @PlatformRoles('SUPER_ADMIN', 'SUPPORT')
  events(@Query(new ZodPipe(EventsQuery)) q: z.infer<typeof EventsQuery>) {
    return this.ops.events(q.status, q.type, q.page, q.pageSize);
  }

  @Get('access-review')
  accessReview() {
    return this.ops.accessReview();
  }

  @Post('events/:id/retry')
  @HttpCode(HttpStatus.OK)
  retry(@Param('id', new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND })) id: string, @CurrentActor() a: Actor) {
    return this.ops.retry(id, a);
  }
}

@Controller('school/emails')
export class SchoolEmailsController {
  constructor(private readonly ops: OpsService) {}

  @Get()
  @RequirePermissions('school.update')
  list(@CurrentSchool() s: SchoolContext, @Query(new ZodPipe(EmailsQuery)) q: z.infer<typeof EmailsQuery>) {
    return this.ops.schoolEmails(s.schoolId, q.page, q.pageSize, q.status);
  }
}
