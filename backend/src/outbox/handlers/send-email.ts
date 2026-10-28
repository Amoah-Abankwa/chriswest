import { Injectable } from '@nestjs/common';
import { Mailer } from '../../mail/mailer';
import { PrismaService } from '../../prisma/prisma.service';

/** A single email whose content is safe to keep in the queue (no links that grant access). */
export type SendEmailPayload = {
  to: string;
  subject: string;
  text: string;
  replyTo: string | null;
  kind: string;
  idempotencyKey: string;
};

@Injectable()
export class SendEmailHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
  ) {}

  async handle(schoolId: string | null, p: SendEmailPayload): Promise<'sent' | 'skipped'> {
    if (schoolId) {
      const school = await this.prisma.school.findUnique({ where: { id: schoolId }, select: { status: true } });
      if (school?.status !== 'ACTIVE') return 'skipped';
    }
    await this.mailer.send({ to: p.to, subject: p.subject, text: p.text, replyTo: p.replyTo, idempotencyKey: p.idempotencyKey }, { schoolId, kind: p.kind });
    return 'sent';
  }
}
