import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type AuditEntry = {
  action: string;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  resourceType: string;
  resourceId?: string | null;
  schoolId?: string | null;
  actorUserId?: string | null;
  /** Safe summary only: no passwords, tokens, cookies or unnecessary personal data. */
  summary?: Prisma.InputJsonValue;
  correlationId?: string;
};

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data: entry });
    } catch (err) {
      // An audit failure must be visible, but must not leak the entry's contents into logs.
      this.logger.error({ msg: 'Failed to write audit entry', action: entry.action, err });
    }
  }
}
