// Creates (or re-invites) a platform super admin and prints a one-time activation link.
// Run on the server: npm run platform:create-admin -w backend -- admin@yourcompany.com
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { ACTIVATION_TTL_MS } from '../src/auth/auth-tokens.service';
import { hashToken, newToken } from '../src/auth/crypto';
import { portalUrl } from '../src/common/urls';
import { getEnv } from '../src/config/env';
import { PrismaClient } from '../src/generated/prisma/client';

async function main() {
  const env = getEnv();
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('Usage: create-super-admin <email>');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DIRECT_URL }) });
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && existing.status !== 'INVITED') {
      throw new Error('That account is already active. Use password reset on the admin host instead.');
    }
    const user =
      existing ??
      (await prisma.user.create({ data: { email, status: 'INVITED', platformRole: 'SUPER_ADMIN' } }));
    if (user.platformRole !== 'SUPER_ADMIN') {
      await prisma.user.update({ where: { id: user.id }, data: { platformRole: 'SUPER_ADMIN' } });
    }

    const token = newToken();
    await prisma.$transaction([
      prisma.authToken.updateMany({ where: { userId: user.id, purpose: 'ACTIVATION', usedAt: null }, data: { usedAt: new Date() } }),
      prisma.authToken.create({
        data: { userId: user.id, purpose: 'ACTIVATION', tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ACTIVATION_TTL_MS) },
      }),
    ]);
    await prisma.auditLog.create({
      data: { action: 'platform.super_admin_invited', outcome: 'SUCCESS', resourceType: 'user', resourceId: user.id, summary: { via: 'cli' } },
    });

    console.log('Open this link once to set the password (valid 3 days):');
    console.log(portalUrl(env.PLATFORM_ADMIN_HOST, `/activate?token=${token}`));
    if (env.NODE_ENV === 'production') {
      console.log('Note: platform sign-in stays blocked in production until MFA is implemented.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
