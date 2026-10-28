import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context';
import { CurrentActor, CurrentAuth, RequirePermissions, type Actor } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import {
  AnnouncementSchema,
  AnnouncementsService,
  PublishSchema,
  UpdateAnnouncementSchema,
  type AnnouncementInput,
  type UpdateAnnouncementInput,
} from './announcements.service';

const id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });

@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  /** What the signed-in person should see. Any member of the school. */
  @Get('feed')
  feed(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext) {
    return this.announcements.feed(s.schoolId, auth);
  }

  @Get()
  @RequirePermissions('announcements.manage')
  all(@CurrentSchool() s: SchoolContext) {
    return this.announcements.all(s.schoolId);
  }

  @Post()
  @RequirePermissions('announcements.manage')
  create(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(AnnouncementSchema)) body: AnnouncementInput, @CurrentActor() a: Actor) {
    return this.announcements.create(s.schoolId, body, a);
  }

  @Patch(':id')
  @RequirePermissions('announcements.manage')
  update(@CurrentSchool() s: SchoolContext, @Param('id', id) announcementId: string, @Body(new ZodPipe(UpdateAnnouncementSchema)) body: UpdateAnnouncementInput, @CurrentActor() a: Actor) {
    return this.announcements.update(s.schoolId, announcementId, body, a);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('announcements.manage')
  publish(@CurrentSchool() s: SchoolContext, @Param('id', id) announcementId: string, @Body(new ZodPipe(PublishSchema)) body: { publishAt?: string }, @CurrentActor() a: Actor) {
    return this.announcements.publish(s.schoolId, announcementId, body.publishAt, a);
  }

  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('announcements.manage')
  withdraw(@CurrentSchool() s: SchoolContext, @Param('id', id) announcementId: string, @CurrentActor() a: Actor) {
    return this.announcements.withdraw(s.schoolId, announcementId, a);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('announcements.manage')
  remove(@CurrentSchool() s: SchoolContext, @Param('id', id) announcementId: string, @CurrentActor() a: Actor) {
    return this.announcements.remove(s.schoolId, announcementId, a);
  }
}
