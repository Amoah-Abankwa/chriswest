import { Injectable } from '@nestjs/common';
import { ACTIVATION_TTL_MS, AuthTokensService, PASSWORD_RESET_TTL_MS } from '../../auth/auth-tokens.service';
import { portalUrl } from '../../common/urls';
import { getEnv } from '../../config/env';
import { Mailer } from '../../mail/mailer';
import { PrismaService } from '../../prisma/prisma.service';
import type { AccountEmailPayload } from '../account-email';

const INVITE_INTRO: Record<string, (school: string) => string> = {
  MANAGER: (s) => `You've been made an owner of ${s} on its school portal. You can set up the school, invite your staff and choose what each of them can do.`,
  STAFF: (s) => `${s} has invited you to its school portal.`,
  PARENT: (s) => `${s} has set up a parent account for you, so you can follow your child's attendance, fees and results.`,
  STUDENT: (s) => `${s} has set up a student account for you.`,
  SUPER_ADMIN: () => 'You have been invited to administer the school platform.',
};

@Injectable()
export class AccountEmailHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AuthTokensService,
    private readonly mailer: Mailer,
  ) {}

  async handle(p: AccountEmailPayload): Promise<'sent' | 'skipped'> {
    const user = await this.prisma.user.findUnique({ where: { id: p.userId }, select: { id: true, email: true, status: true } });
    if (!user || user.status === 'DISABLED') return 'skipped';

    let name = 'Platform administration';
    let hostname = getEnv().PLATFORM_ADMIN_HOST;
    if (p.schoolId) {
      const school = await this.prisma.school.findUnique({
        where: { id: p.schoolId },
        select: { name: true, status: true, domains: { where: { isPrimary: true }, select: { hostname: true } } },
      });
      if (!school || school.status !== 'ACTIVE' || !school.domains[0]) return 'skipped';
      // Still a member? Access may have been removed while the email was waiting.
      const member = await this.prisma.schoolMembership.findUnique({ where: { schoolId_userId: { schoolId: p.schoolId, userId: user.id } }, select: { status: true } });
      if (member?.status !== 'ACTIVE') return 'skipped';
      name = school.name;
      hostname = school.domains[0].hostname;
    }
    const meta = { schoolId: p.schoolId, kind: `account.${p.template.toLowerCase()}` };

    if (p.template === 'RESET') {
      if (user.status !== 'ACTIVE') return 'skipped';
      const token = await this.tokens.issue(user.id, 'PASSWORD_RESET', PASSWORD_RESET_TTL_MS);
      await this.mailer.send(
        {
          to: user.email,
          subject: 'Reset your password',
          text:
            `Use this link to choose a new password:\n\n${portalUrl(hostname, `/reset-password?token=${token}`)}\n\n` +
            `The link expires in 30 minutes and works once. If you didn't ask for this, you can ignore this email.`,
        },
        meta,
      );
      return 'sent';
    }

    const intro = (INVITE_INTRO[p.audience ?? (p.schoolId ? 'STAFF' : 'SUPER_ADMIN')] ?? INVITE_INTRO.STAFF!)(name);
    if (user.status === 'INVITED') {
      const token = await this.tokens.issue(user.id, 'ACTIVATION', ACTIVATION_TTL_MS);
      await this.mailer.send(
        {
          to: user.email,
          subject: `Set up your ${name} account`,
          text: `${intro}\n\nActivate your account and choose a password:\n${portalUrl(hostname, `/activate?token=${token}`)}\n\nThe link expires in 3 days and works once.`,
        },
        meta,
      );
    } else {
      await this.mailer.send(
        { to: user.email, subject: `You now have access to ${name}`, text: `${intro}\n\nSign in with your existing password at:\n${portalUrl(hostname, '/login')}` },
        meta,
      );
    }
    return 'sent';
  }
}
