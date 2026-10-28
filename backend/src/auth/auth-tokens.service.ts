import { Injectable } from '@nestjs/common';
import type { AuthTokenPurpose, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken, newToken } from './crypto';

export const ACTIVATION_TTL_MS = 72 * 60 * 60 * 1000; // 3 days
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes

@Injectable()
export class AuthTokensService {
  constructor(private readonly prisma: PrismaService) {}

  /** Issues a single-use link token and invalidates any earlier unused one for the same purpose. */
  async issue(userId: string, purpose: AuthTokenPurpose, ttlMs: number): Promise<string> {
    const token = newToken();
    await this.prisma.$transaction([
      this.prisma.authToken.updateMany({
        where: { userId, purpose, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.authToken.create({
        data: { userId, purpose, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) },
      }),
    ]);
    return token;
  }

  /** Marks the token used inside the caller's transaction. Returns the userId, or null if invalid. */
  async consume(tx: Prisma.TransactionClient, token: string, purpose: AuthTokenPurpose): Promise<string | null> {
    const record = await tx.authToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, userId: true, purpose: true, usedAt: true, expiresAt: true },
    });
    if (!record || record.purpose !== purpose || record.usedAt || record.expiresAt <= new Date()) return null;
    // Conditional update makes concurrent double-use impossible.
    const claimed = await tx.authToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    return claimed.count === 1 ? record.userId : null;
  }
}
