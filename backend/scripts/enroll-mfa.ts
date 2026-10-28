// Turns on two-step sign-in for a platform account from the server, e.g. the first super admin in
// production (who can't sign in to set it up in the app until it's on).
// Usage: npm run platform:enroll-mfa -w backend -- admin@yourcompany.com
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { getEnv } from '../src/config/env';
import { PrismaClient } from '../src/generated/prisma/client';
import { encryptSecret, hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUrl } from '../src/auth/totp';

async function main() {
  const env = getEnv();
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) throw new Error('Usage: enroll-mfa <email>');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DIRECT_URL }) });
  try {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, platformRole: true } });
    if (!user?.platformRole) throw new Error('No platform account with that email');
    const secret = newTotpSecret();
    const recovery = newRecoveryCodes();
    await prisma.user.update({
      where: { id: user.id },
      data: { mfaEnabled: true, mfaSecret: encryptSecret(secret), mfaPendingSecret: null, mfaLastStep: null, mfaRecoveryCodes: recovery.map(hashRecoveryCode) },
    });
    await prisma.auditLog.create({ data: { action: 'auth.mfa_enable', outcome: 'SUCCESS', resourceType: 'user', resourceId: user.id, summary: { via: 'cli' } } });
    console.log('Add this to the authenticator app (or type the key in by hand):');
    console.log(otpauthUrl(secret, email, 'School portal'));
    console.log(`Key: ${secret}`);
    console.log('\nRecovery codes (each works once; store them somewhere safe and offline):');
    recovery.forEach((c) => console.log(`  ${c}`));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
