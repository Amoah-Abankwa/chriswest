import { Injectable } from '@nestjs/common';
import { notFound } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

export type NewNotification = { schoolId: string; userId: string; kind: string; title: string; body: string; link?: string | null };

/** In-app notifications. Always read and changed for (school, user) together. */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(items: NewNotification[]) {
    if (items.length === 0) return;
    await this.prisma.notification.createMany({
      data: items.map((n) => ({ ...n, title: n.title.slice(0, 200), body: n.body.slice(0, 500), link: n.link ?? null })),
    });
  }

  async list(schoolId: string, userId: string, page: number, pageSize: number, unreadOnly: boolean) {
    const where = { schoolId, userId, ...(unreadOnly ? { readAt: null } : {}) };
    const [data, total, unread] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, kind: true, title: true, body: true, link: true, readAt: true, createdAt: true },
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { schoolId, userId, readAt: null } }),
    ]);
    return { data, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize), unread } };
  }

  async unreadCount(schoolId: string, userId: string) {
    return { data: { unread: await this.prisma.notification.count({ where: { schoolId, userId, readAt: null } }) } };
  }

  async markRead(schoolId: string, userId: string, id: string) {
    const updated = await this.prisma.notification.updateMany({ where: { id, schoolId, userId, readAt: null }, data: { readAt: new Date() } });
    if (updated.count === 0) {
      const exists = await this.prisma.notification.count({ where: { id, schoolId, userId } });
      if (!exists) throw notFound('Notification not found');
    }
    return this.unreadCount(schoolId, userId);
  }

  async markAllRead(schoolId: string, userId: string) {
    await this.prisma.notification.updateMany({ where: { schoolId, userId, readAt: null }, data: { readAt: new Date() } });
    return this.unreadCount(schoolId, userId);
  }
}
