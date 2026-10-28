import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import { NotificationsService } from './notifications.service';

const Query_ = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  unread: z.enum(['true', 'false']).default('false'),
});

/** Everyone's own notifications only; no permission beyond being signed in to this school. */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Query(new ZodPipe(Query_)) q: z.infer<typeof Query_>) {
    return this.notifications.list(s.schoolId, auth.userId, q.page, q.pageSize, q.unread === 'true');
  }

  @Get('unread-count')
  unread(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext) {
    return this.notifications.unreadCount(s.schoolId, auth.userId);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  readAll(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext) {
    return this.notifications.markAllRead(s.schoolId, auth.userId);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  read(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND })) id: string) {
    return this.notifications.markRead(s.schoolId, auth.userId, id);
  }
}
