import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { Clock } from '../common/clock';
import { badRequest, conflict } from '../common/errors';
import { getEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthContext } from './auth-context';
import { verifyPassword } from './crypto';
import { decryptSecret, encryptSecret, hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUrl, verifyTotp } from './totp';

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async status(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaEnabled: true, mfaRecoveryCodes: true, platformRole: true } });
    return { data: { enabled: u.mfaEnabled, recoveryCodesLeft: u.mfaRecoveryCodes.length, required: Boolean(u.platformRole) } };
  }

  /** Starts set-up: a new secret the person adds to their authenticator app. Not active until confirmed. */
  async setup(auth: AuthContext) {
    const secret = newTotpSecret();
    await this.prisma.user.update({ where: { id: auth.userId }, data: { mfaPendingSecret: encryptSecret(secret) } });
    return { data: { secret, otpauthUrl: otpauthUrl(secret, auth.email, 'School portal') } };
  }

  /** Confirms set-up with a code from the app; returns one-time recovery codes, shown only now. */
  async enable(auth: AuthContext, code: string, correlationId?: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { mfaPendingSecret: true } });
    if (!u.mfaPendingSecret) throw conflict('NO_SETUP', 'Start setting up two-step sign-in first.');
    const secret = decryptSecret(u.mfaPendingSecret);
    const step = verifyTotp(secret, code, this.clock.now(), null);
    if (step === null) throw badRequest('INVALID_CODE', 'That code didn’t match. Check the time on your phone and try the newest code.');
    const recovery = newRecoveryCodes();
    await this.prisma.user.update({
      where: { id: auth.userId },
      data: { mfaEnabled: true, mfaSecret: u.mfaPendingSecret, mfaPendingSecret: null, mfaLastStep: step, mfaRecoveryCodes: recovery.map(hashRecoveryCode) },
    });
    await this.audit.record({ action: 'auth.mfa_enable', outcome: 'SUCCESS', resourceType: 'user', resourceId: auth.userId, actorUserId: auth.userId, correlationId });
    return { data: { enabled: true, recoveryCodes: recovery } };
  }

  async disable(auth: AuthContext, password: string, code: string, correlationId?: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { passwordHash: true, platformRole: true, mfaEnabled: true } });
    if (!u.mfaEnabled) throw conflict('NOT_ENABLED', 'Two-step sign-in isn’t on.');
    if (u.platformRole && getEnv().NODE_ENV === 'production') throw conflict('MFA_REQUIRED', 'Platform accounts must keep two-step sign-in on.');
    if (!u.passwordHash || !(await verifyPassword(u.passwordHash, password))) throw badRequest('INVALID_PASSWORD', 'Your password is incorrect.');
    if (!(await this.check(auth.userId, code))) throw badRequest('INVALID_CODE', 'That code didn’t match.');
    await this.prisma.user.update({ where: { id: auth.userId }, data: { mfaEnabled: false, mfaSecret: null, mfaLastStep: null, mfaRecoveryCodes: [] } });
    await this.audit.record({ action: 'auth.mfa_disable', outcome: 'SUCCESS', resourceType: 'user', resourceId: auth.userId, actorUserId: auth.userId, correlationId });
    return { data: { enabled: false } };
  }

  /** Checks a sign-in code: an authenticator code (each usable once) or an unused recovery code. */
  async check(userId: string, code: string): Promise<boolean> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaSecret: true, mfaLastStep: true, mfaRecoveryCodes: true } });
    if (!u.mfaSecret) return false;
    const trimmed = code.trim();
    const step = verifyTotp(decryptSecret(u.mfaSecret), trimmed, this.clock.now(), u.mfaLastStep);
    if (step !== null) {
      // Conditional update: two sign-ins racing with the same code can't both succeed.
      const used = await this.prisma.user.updateMany({ where: { id: userId, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] }, data: { mfaLastStep: step } });
      return used.count === 1;
    }
    const hash = hashRecoveryCode(trimmed);
    if (!u.mfaRecoveryCodes.includes(hash)) return false;
    await this.prisma.user.update({ where: { id: userId }, data: { mfaRecoveryCodes: u.mfaRecoveryCodes.filter((h) => h !== hash) } });
    await this.audit.record({ action: 'auth.mfa_recovery_used', outcome: 'SUCCESS', resourceType: 'user', resourceId: userId, actorUserId: userId });
    return true;
  }
}
