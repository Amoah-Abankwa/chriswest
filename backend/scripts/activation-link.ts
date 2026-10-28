// Development helper until the Phase 2 invitation flow exists.
// Usage: npm run dev:activation-link -w backend -- you@example.com http://oakwood.localhost:3000
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { ACTIVATION_TTL_MS } from '../src/auth/auth-tokens.service';
import { hashToken, newToken } from '../src/auth/crypto';
import { PrismaClient } from '../src/generated/prisma/client';

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Not available in production');
  const [email, origin] = process.argv.slice(2);
  if (!email || !origin) throw new Error('Usage: activation-link <email> <portal origin>');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL! }) });
  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || user.status !== 'INVITED') throw new Error('No invited user with that email');
    const token = newToken();
    await prisma.authToken.create({
      data: { userId: user.id, purpose: 'ACTIVATION', tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ACTIVATION_TTL_MS) },
    });
    console.log(`${origin}/activate?token=${token}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
