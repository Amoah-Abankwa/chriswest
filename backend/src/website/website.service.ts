import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { Clock } from '../common/clock';
import { badRequest, conflict, isUniqueViolation, notFound } from '../common/errors';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorage } from '../storage/file-storage';
import { detectFileType } from '../storage/file-type';
import { RESERVED_SLUGS, type ContactInput, type PageInput, type PostInput, type UpdatePageInput, type UpdatePostInput } from './website.schemas';

const slugify = (title: string) =>
  title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';

const PAGE = { id: true, slug: true, title: true, body: true, status: true, showInNav: true, sortOrder: true, seoDescription: true, publishedAt: true, updatedAt: true } as const;
const POST = { id: true, kind: true, slug: true, title: true, summary: true, body: true, coverMediaId: true, eventStartsAt: true, eventLocation: true, status: true, publishedAt: true, updatedAt: true } as const;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIN_FORM_SECONDS = 3;

@Injectable()
export class WebsiteService {
  private readonly logger = new Logger(WebsiteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorage,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly clock: Clock,
  ) {}

  // ---------- public: only published content of a site that's switched on ----------

  /** 404 unless the school has turned its site on. */
  private async assertSiteLive(schoolId: string) {
    const school = await this.prisma.school.findUnique({ where: { id: schoolId }, select: { siteEnabled: true } });
    if (!school?.siteEnabled) throw notFound('This school doesn’t have a public website.');
  }

  async publicSite(schoolId: string) {
    await this.assertSiteLive(schoolId);
    const [school, nav, home] = await Promise.all([
      this.prisma.school.findUniqueOrThrow({
        where: { id: schoolId },
        select: { name: true, motto: true, siteTagline: true, addressLine: true, city: true, region: true, phone: true, contactEmail: true },
      }),
      this.prisma.sitePage.findMany({
        where: { schoolId, status: 'PUBLISHED', showInNav: true, slug: { not: 'home' } },
        orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
        select: { slug: true, title: true },
      }),
      this.prisma.sitePage.findFirst({ where: { schoolId, slug: 'home', status: 'PUBLISHED' }, select: { title: true, body: true, seoDescription: true } }),
    ]);
    const [news, events] = await Promise.all([
      this.publicPosts(schoolId, 'NEWS', 1, 3, false),
      this.publicPosts(schoolId, 'EVENT', 1, 3, false),
    ]);
    return { data: { school, nav, home, latestNews: news.data, upcomingEvents: events.data } };
  }

  async publicPage(schoolId: string, slug: string) {
    await this.assertSiteLive(schoolId);
    const page = await this.prisma.sitePage.findFirst({ where: { schoolId, slug, status: 'PUBLISHED' }, select: { slug: true, title: true, body: true, seoDescription: true, updatedAt: true } });
    if (!page) throw notFound('Page not found');
    return { data: page };
  }

  async publicPosts(schoolId: string, kind: 'NEWS' | 'EVENT' | undefined, page: number, pageSize: number, check = true) {
    if (check) await this.assertSiteLive(schoolId);
    const now = this.clock.now();
    // Events: upcoming first, soonest first. News: newest first.
    const where = { schoolId, status: 'PUBLISHED' as const, ...(kind ? { kind } : {}), ...(kind === 'EVENT' ? { eventStartsAt: { gte: now } } : {}) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.sitePost.findMany({
        where,
        orderBy: kind === 'EVENT' ? { eventStartsAt: 'asc' } : { publishedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { kind: true, slug: true, title: true, summary: true, coverMediaId: true, eventStartsAt: true, eventLocation: true, publishedAt: true },
      }),
      this.prisma.sitePost.count({ where }),
    ]);
    return { data: rows, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  }

  async publicPost(schoolId: string, slug: string) {
    await this.assertSiteLive(schoolId);
    const post = await this.prisma.sitePost.findFirst({
      where: { schoolId, slug, status: 'PUBLISHED' },
      select: { kind: true, slug: true, title: true, summary: true, body: true, coverMediaId: true, eventStartsAt: true, eventLocation: true, publishedAt: true },
    });
    if (!post) throw notFound('Post not found');
    return { data: post };
  }

  async publicMedia(schoolId: string, id: string) {
    await this.assertSiteLive(schoolId);
    const m = await this.prisma.siteMedia.findFirst({ where: { schoolId, id }, select: { storageKey: true, contentType: true } });
    if (!m) throw notFound('Image not found');
    return { body: await this.storage.get(m.storageKey), contentType: m.contentType };
  }

  /**
   * Stores a contact-form message. Likely bots (hidden field filled in, or submitted faster than a
   * person could type) get the same "thank you" but nothing is stored.
   */
  async contact(schoolId: string, input: ContactInput) {
    await this.assertSiteLive(schoolId);
    const tooFast = Date.now() - input.startedAt < MIN_FORM_SECONDS * 1000;
    if (input.website || tooFast) {
      this.logger.warn({ msg: 'Contact form dropped as likely spam', schoolId, reason: input.website ? 'honeypot' : 'too fast' });
      return { data: { received: true } };
    }
    await this.prisma.contactMessage.create({
      data: { schoolId, name: input.name, email: input.email ?? null, phone: input.phone ?? null, subject: input.subject ?? null, message: input.message },
    });
    const editors = await this.prisma.schoolMembership.findMany({
      where: { schoolId, kind: 'STAFF', status: 'ACTIVE', roles: { some: { role: { permissions: { some: { permissionKey: 'website.manage' } } } } } },
      select: { userId: true },
    });
    await this.notifications.create(editors.map((e) => ({ schoolId, userId: e.userId, kind: 'contact', title: 'New message from the website', body: `${input.name}: ${input.subject ?? input.message.slice(0, 80)}`, link: '/website?tab=messages' })));
    return { data: { received: true } };
  }

  // ---------- admin ----------

  async settings(schoolId: string) {
    const s = await this.prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { siteEnabled: true, siteTagline: true } });
    const unhandled = await this.prisma.contactMessage.count({ where: { schoolId, handledAt: null } });
    return { data: { ...s, unhandledMessages: unhandled } };
  }

  async updateSettings(schoolId: string, input: { siteEnabled?: boolean; siteTagline?: string | null }, actor: Actor) {
    await this.prisma.school.update({ where: { id: schoolId }, data: input });
    await this.log('website.settings', schoolId, schoolId, actor, { fields: Object.keys(input) });
    return this.settings(schoolId);
  }

  async pages(schoolId: string) {
    return { data: await this.prisma.sitePage.findMany({ where: { schoolId }, select: PAGE, orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }] }) };
  }

  async createPage(schoolId: string, input: PageInput, actor: Actor) {
    const slug = this.checkSlug(input.slug ?? slugify(input.title));
    try {
      const page = await this.prisma.sitePage.create({ data: { schoolId, ...input, slug, seoDescription: input.seoDescription ?? null }, select: PAGE });
      await this.log('website.page_create', schoolId, page.id, actor, { slug });
      return { data: page };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('SLUG_TAKEN', 'Another page already uses this address.');
      throw err;
    }
  }

  async updatePage(schoolId: string, id: string, input: UpdatePageInput, actor: Actor) {
    await this.findPage(schoolId, id);
    try {
      const page = await this.prisma.sitePage.update({ where: { id }, data: { ...input, ...(input.slug ? { slug: this.checkSlug(input.slug) } : {}) }, select: PAGE });
      await this.log('website.page_update', schoolId, id, actor, { fields: Object.keys(input) });
      return { data: page };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('SLUG_TAKEN', 'Another page already uses this address.');
      throw err;
    }
  }

  async setPageStatus(schoolId: string, id: string, status: 'DRAFT' | 'PUBLISHED', actor: Actor) {
    const page = await this.findPage(schoolId, id);
    const updated = await this.prisma.sitePage.update({
      where: { id },
      data: { status, publishedAt: status === 'PUBLISHED' ? (page.publishedAt ?? this.clock.now()) : page.publishedAt },
      select: PAGE,
    });
    await this.log(status === 'PUBLISHED' ? 'website.page_publish' : 'website.page_unpublish', schoolId, id, actor, {});
    return { data: updated };
  }

  async deletePage(schoolId: string, id: string, actor: Actor) {
    await this.findPage(schoolId, id);
    await this.prisma.sitePage.delete({ where: { id } });
    await this.log('website.page_delete', schoolId, id, actor, {});
  }

  async posts(schoolId: string) {
    return { data: await this.prisma.sitePost.findMany({ where: { schoolId }, select: POST, orderBy: { updatedAt: 'desc' } }) };
  }

  async createPost(schoolId: string, input: PostInput, actor: Actor) {
    if (input.kind === 'EVENT' && !input.eventStartsAt) throw badRequest('EVENT_DATE_REQUIRED', 'Give the event a date and time.');
    if (input.coverMediaId) await this.assertMedia(schoolId, input.coverMediaId);
    const slug = this.checkSlug(input.slug ?? slugify(input.title));
    try {
      const post = await this.prisma.sitePost.create({
        data: {
          schoolId,
          kind: input.kind,
          slug,
          title: input.title,
          summary: input.summary ?? null,
          body: input.body,
          coverMediaId: input.coverMediaId ?? null,
          eventStartsAt: input.eventStartsAt ? new Date(input.eventStartsAt) : null,
          eventLocation: input.eventLocation ?? null,
        },
        select: POST,
      });
      await this.log('website.post_create', schoolId, post.id, actor, { kind: input.kind, slug });
      return { data: post };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('SLUG_TAKEN', 'Another post already uses this address.');
      throw err;
    }
  }

  async updatePost(schoolId: string, id: string, input: UpdatePostInput, actor: Actor) {
    await this.findPost(schoolId, id);
    if (input.coverMediaId) await this.assertMedia(schoolId, input.coverMediaId);
    const post = await this.prisma.sitePost.update({
      where: { id },
      data: {
        ...input,
        ...(input.slug ? { slug: this.checkSlug(input.slug) } : {}),
        ...(input.eventStartsAt !== undefined ? { eventStartsAt: input.eventStartsAt ? new Date(input.eventStartsAt) : null } : {}),
      },
      select: POST,
    });
    await this.log('website.post_update', schoolId, id, actor, { fields: Object.keys(input) });
    return { data: post };
  }

  async setPostStatus(schoolId: string, id: string, status: 'DRAFT' | 'PUBLISHED', actor: Actor) {
    const post = await this.findPost(schoolId, id);
    const updated = await this.prisma.sitePost.update({
      where: { id },
      data: { status, publishedAt: status === 'PUBLISHED' ? (post.publishedAt ?? this.clock.now()) : post.publishedAt },
      select: POST,
    });
    await this.log(status === 'PUBLISHED' ? 'website.post_publish' : 'website.post_unpublish', schoolId, id, actor, {});
    return { data: updated };
  }

  async deletePost(schoolId: string, id: string, actor: Actor) {
    await this.findPost(schoolId, id);
    await this.prisma.sitePost.delete({ where: { id } });
    await this.log('website.post_delete', schoolId, id, actor, {});
  }

  async media(schoolId: string) {
    return {
      data: await this.prisma.siteMedia.findMany({ where: { schoolId }, orderBy: { createdAt: 'desc' }, select: { id: true, contentType: true, sizeBytes: true, altText: true, createdAt: true } }),
    };
  }

  /** Images only, checked by content. These become public once used on the site. */
  async uploadMedia(schoolId: string, file: { buffer: Buffer; size: number } | undefined, altText: string, actor: Actor) {
    if (!file || file.size === 0) throw badRequest('FILE_REQUIRED', 'Choose an image to upload.');
    if (file.size > MAX_IMAGE_BYTES) throw badRequest('FILE_TOO_LARGE', 'Images can be up to 5 MB.');
    const type = detectFileType(file.buffer);
    if (!type || !type.mime.startsWith('image/')) throw badRequest('UNSUPPORTED_FILE', 'Upload a JPEG, PNG or WebP image.');
    const id = randomUUID();
    const storageKey = `schools/${schoolId}/site/${id}`;
    await this.storage.put(storageKey, file.buffer, type.mime);
    const m = await this.prisma.siteMedia.create({
      data: { id, schoolId, storageKey, contentType: type.mime, sizeBytes: file.size, altText, createdByUserId: actor.userId },
      select: { id: true, contentType: true, sizeBytes: true, altText: true, createdAt: true },
    });
    await this.log('website.media_upload', schoolId, id, actor, {});
    return { data: m };
  }

  async deleteMedia(schoolId: string, id: string, actor: Actor) {
    const m = await this.prisma.siteMedia.findFirst({ where: { schoolId, id }, select: { storageKey: true } });
    if (!m) throw notFound('Image not found');
    await this.prisma.$transaction([
      this.prisma.sitePost.updateMany({ where: { schoolId, coverMediaId: id }, data: { coverMediaId: null } }),
      this.prisma.siteMedia.delete({ where: { id } }),
    ]);
    await this.storage.delete(m.storageKey).catch(() => undefined);
    await this.log('website.media_delete', schoolId, id, actor, {});
  }

  async messages(schoolId: string, handled: boolean | undefined, page: number, pageSize: number) {
    const where = { schoolId, ...(handled === undefined ? {} : handled ? { handledAt: { not: null } } : { handledAt: null }) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.contactMessage.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.contactMessage.count({ where }),
    ]);
    return { data: rows.map(({ schoolId: _s, ...m }) => m), meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  }

  async markHandled(schoolId: string, id: string, actor: Actor) {
    const updated = await this.prisma.contactMessage.updateMany({ where: { schoolId, id, handledAt: null }, data: { handledAt: new Date(), handledByUserId: actor.userId } });
    if (!updated.count && !(await this.prisma.contactMessage.count({ where: { schoolId, id } }))) throw notFound('Message not found');
    return { data: { id, handled: true } };
  }

  // ---------- helpers ----------

  private checkSlug(slug: string) {
    if (RESERVED_SLUGS.has(slug)) throw badRequest('SLUG_RESERVED', `“${slug}” is used by the site itself. Choose another address.`);
    return slug;
  }

  private async findPage(schoolId: string, id: string) {
    const p = await this.prisma.sitePage.findFirst({ where: { schoolId, id }, select: { publishedAt: true } });
    if (!p) throw notFound('Page not found');
    return p;
  }

  private async findPost(schoolId: string, id: string) {
    const p = await this.prisma.sitePost.findFirst({ where: { schoolId, id }, select: { publishedAt: true } });
    if (!p) throw notFound('Post not found');
    return p;
  }

  private async assertMedia(schoolId: string, id: string) {
    if (!(await this.prisma.siteMedia.count({ where: { schoolId, id } }))) throw notFound('Image not found');
  }

  private log(action: string, schoolId: string, resourceId: string, actor: Actor, summary: Record<string, unknown>) {
    return this.audit.record({ action, outcome: 'SUCCESS', resourceType: 'website', resourceId, schoolId, actorUserId: actor.userId, summary: summary as never, correlationId: actor.correlationId });
  }
}
