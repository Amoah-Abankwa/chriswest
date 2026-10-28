import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken, newToken } from './crypto';

export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000; // 12 hours
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours without activity
/** The app keeps its token in the phone's secure storage (Keychain / Keystore), behind the device lock. */
export const MOBILE_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MOBILE_IDLE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days without opening the app

export type SessionClient = 'WEB' | 'MOBILE';
const TOUCH_INTERVAL_MS = 5 * 60 * 1000; // avoid a DB write on every request

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, schoolId: string | null, userAgent?: string, client: SessionClient = 'WEB') {
    const token = newToken();
    const expiresAt = new Date(Date.now() + (client === 'MOBILE' ? MOBILE_ABSOLUTE_MS : SESSION_ABSOLUTE_MS));
    const session = await this.prisma.session.create({
      data: { userId, schoolId, tokenHash: hashToken(token), expiresAt, userAgent, client },
      select: { id: true },
    });
    return { token, expiresAt, sessionId: session.id };
  }

  /** Returns the session only if it exists, isn't revoked, and hasn't hit its absolute or idle limit. */
  async findValid(token: string) {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        schoolId: true,
        expiresAt: true,
        revokedAt: true,
        lastSeenAt: true,
        client: true,
        user: { select: { id: true, email: true, fullName: true, status: true, platformRole: true } },
      },
    });
    if (!session || session.revokedAt) return null;
    const now = Date.now();
    if (session.expiresAt.getTime() <= now) return null;
    if (session.lastSeenAt.getTime() + (session.client === 'MOBILE' ? MOBILE_IDLE_MS : SESSION_IDLE_MS) <= now) return null;
    return session;
  }

  async touch(sessionId: string, lastSeenAt: Date) {
    if (Date.now() - lastSeenAt.getTime() < TOUCH_INTERVAL_MS) return;
    await this.prisma.session.update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } });
  }

  async revokeByToken(token: string) {
    const result = await this.prisma.session.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count > 0;
  }
}
