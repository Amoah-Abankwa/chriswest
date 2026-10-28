import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentActor, Public, RequirePermissions, type Actor } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import {
  ContactSchema,
  MessagesQuery,
  PageSchema,
  PostSchema,
  PostsQuery,
  SettingsSchema,
  StatusSchema,
  UpdatePageSchema,
  UpdatePostSchema,
  type ContactInput,
  type PageInput,
  type PostInput,
  type UpdatePageInput,
  type UpdatePostInput,
} from './website.schemas';
import { WebsiteService } from './website.service';

const id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });
const SlugParam = z.string().max(80);

/** The public website. No sign-in; the school comes from the address, and only published content is returned. */
@Public()
@Controller('public')
export class PublicSiteController {
  constructor(private readonly site: WebsiteService) {}

  @Get('site')
  home(@CurrentSchool() s: SchoolContext) {
    return this.site.publicSite(s.schoolId);
  }

  @Get('pages/:slug')
  page(@CurrentSchool() s: SchoolContext, @Param('slug', new ZodPipe(SlugParam)) slug: string) {
    return this.site.publicPage(s.schoolId, slug);
  }

  @Get('posts')
  posts(@CurrentSchool() s: SchoolContext, @Query(new ZodPipe(PostsQuery)) q: z.infer<typeof PostsQuery>) {
    return this.site.publicPosts(s.schoolId, q.kind, q.page, q.pageSize);
  }

  @Get('posts/:slug')
  post(@CurrentSchool() s: SchoolContext, @Param('slug', new ZodPipe(SlugParam)) slug: string) {
    return this.site.publicPost(s.schoolId, slug);
  }

  @Get('media/:id')
  @Header('Cache-Control', 'public, max-age=86400')
  async media(@CurrentSchool() s: SchoolContext, @Param('id', id) mediaId: string) {
    const m = await this.site.publicMedia(s.schoolId, mediaId);
    return new StreamableFile(m.body, { type: m.contentType, length: m.body.length });
  }

  /** Same-origin only (the CSRF guard checks Origin), a few per hour per address, with spam checks. */
  @Post('contact')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  contact(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(ContactSchema)) body: ContactInput) {
    return this.site.contact(s.schoolId, body);
  }
}
@Controller('website')
export class WebsiteAdminController {
  constructor(private readonly site: WebsiteService) {}

  @Get('settings')
  @RequirePermissions('website.manage')
  settings(@CurrentSchool() s: SchoolContext) {
    return this.site.settings(s.schoolId);
  }

  @Put('settings')
  @RequirePermissions('website.manage')
  updateSettings(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(SettingsSchema)) body: z.infer<typeof SettingsSchema>, @CurrentActor() a: Actor) {
    return this.site.updateSettings(s.schoolId, body, a);
  }

  @Get('pages')
  @RequirePermissions('website.manage')
  pages(@CurrentSchool() s: SchoolContext) {
    return this.site.pages(s.schoolId);
  }

  @Post('pages')
  @RequirePermissions('website.manage')
  createPage(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(PageSchema)) body: PageInput, @CurrentActor() a: Actor) {
    return this.site.createPage(s.schoolId, body, a);
  }

  @Patch('pages/:id')
  @RequirePermissions('website.manage')
  updatePage(@CurrentSchool() s: SchoolContext, @Param('id', id) pageId: string, @Body(new ZodPipe(UpdatePageSchema)) body: UpdatePageInput, @CurrentActor() a: Actor) {
    return this.site.updatePage(s.schoolId, pageId, body, a);
  }

  @Put('pages/:id/status')
  @RequirePermissions('website.manage')
  pageStatus(@CurrentSchool() s: SchoolContext, @Param('id', id) pageId: string, @Body(new ZodPipe(StatusSchema)) body: { status: 'DRAFT' | 'PUBLISHED' }, @CurrentActor() a: Actor) {
    return this.site.setPageStatus(s.schoolId, pageId, body.status, a);
  }

  @Delete('pages/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('website.manage')
  deletePage(@CurrentSchool() s: SchoolContext, @Param('id', id) pageId: string, @CurrentActor() a: Actor) {
    return this.site.deletePage(s.schoolId, pageId, a);
  }

  @Get('posts')
  @RequirePermissions('website.manage')
  posts(@CurrentSchool() s: SchoolContext) {
    return this.site.posts(s.schoolId);
  }

  @Post('posts')
  @RequirePermissions('website.manage')
  createPost(@CurrentSchool() s: SchoolContext, @Body(new ZodPipe(PostSchema)) body: PostInput, @CurrentActor() a: Actor) {
    return this.site.createPost(s.schoolId, body, a);
  }

  @Patch('posts/:id')
  @RequirePermissions('website.manage')
  updatePost(@CurrentSchool() s: SchoolContext, @Param('id', id) postId: string, @Body(new ZodPipe(UpdatePostSchema)) body: UpdatePostInput, @CurrentActor() a: Actor) {
    return this.site.updatePost(s.schoolId, postId, body, a);
  }

  @Put('posts/:id/status')
  @RequirePermissions('website.manage')
  postStatus(@CurrentSchool() s: SchoolContext, @Param('id', id) postId: string, @Body(new ZodPipe(StatusSchema)) body: { status: 'DRAFT' | 'PUBLISHED' }, @CurrentActor() a: Actor) {
    return this.site.setPostStatus(s.schoolId, postId, body.status, a);
  }

  @Delete('posts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('website.manage')
  deletePost(@CurrentSchool() s: SchoolContext, @Param('id', id) postId: string, @CurrentActor() a: Actor) {
    return this.site.deletePost(s.schoolId, postId, a);
  }

  @Get('media')
  @RequirePermissions('website.manage')
  media(@CurrentSchool() s: SchoolContext) {
    return this.site.media(s.schoolId);
  }

  @Post('media')
  @RequirePermissions('website.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 3 } }))
  upload(@CurrentSchool() s: SchoolContext, @UploadedFile() file: Express.Multer.File | undefined, @Body(new ZodPipe(z.object({ altText: z.string().trim().min(1, { message: 'Describe the image for people who can’t see it' }).max(200) }))) body: { altText: string }, @CurrentActor() a: Actor) {
    return this.site.uploadMedia(s.schoolId, file, body.altText, a);
  }

  @Delete('media/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('website.manage')
  deleteMedia(@CurrentSchool() s: SchoolContext, @Param('id', id) mediaId: string, @CurrentActor() a: Actor) {
    return this.site.deleteMedia(s.schoolId, mediaId, a);
  }

  @Get('messages')
  @RequirePermissions('website.manage')
  messages(@CurrentSchool() s: SchoolContext, @Query(new ZodPipe(MessagesQuery)) q: z.infer<typeof MessagesQuery>) {
    return this.site.messages(s.schoolId, q.handled === undefined ? undefined : q.handled === 'true', q.page, q.pageSize);
  }

  @Post('messages/:id/handled')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('website.manage')
  handled(@CurrentSchool() s: SchoolContext, @Param('id', id) messageId: string, @CurrentActor() a: Actor) {
    return this.site.markHandled(s.schoolId, messageId, a);
  }
}
