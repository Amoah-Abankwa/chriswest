import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { getEnv } from '../config/env';
import { queueAccountEmail } from '../outbox/account-email';
import { PrismaService } from '../prisma/prisma.service';
import type { HostContext } from '../tenancy/host-context';
import { AccessService } from './access.service';
import { AuthTokensService } from './auth-tokens.service';
import type { ActivateInput, LoginInput, SetPasswordInput } from './auth.schemas';
import { burnPasswordCheck, hashPassword, verifyPassword } from './crypto';
import { LoginAttemptLimiter } from './login-attempts';
import { MfaService } from './mfa.service';
import { SessionsService, type SessionClient } from './sessions.service';

export type RequestMeta = {
  host: HostContext;
  ip?: string;
  userAgent?: string;
  correlationId?: string;
  /** Origin of the verified host, used to build links in emails. */
  publicOrigin: string;
};

const invalidCredentials = () =>
  new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' });

const invalidLink = () =>
  new BadRequestException({ code: 'INVALID_TOKEN', message: 'This link is invalid or has expired. Ask for a new one.' });

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly access: AccessService,
    private readonly tokens: AuthTokensService,
    private readonly limiter: LoginAttemptLimiter,
    private readonly audit: AuditService,
    private readonly mfa: MfaService,
  ) {}

  async login(input: LoginInput, meta: RequestMeta, client: SessionClient = 'WEB') {
    const schoolId = meta.host.kind === 'school' ? meta.host.schoolId : null;
    const limiterKey = input.email;

    if (this.limiter.isBlocked(limiterKey)) {
      throw new HttpException(
        { code: 'TOO_MANY_ATTEMPTS', message: 'Too many sign-in attempts. Try again in 15 minutes.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, passwordHash: true, status: true, platformRole: true, mfaEnabled: true },
    });

    const passwordOk = user?.passwordHash
      ? await verifyPassword(user.passwordHash, input.password)
      : await burnPasswordCheck(input.password);

    let allowed = Boolean(user && passwordOk && user.status === 'ACTIVE');

    // Same error for "wrong password" and "not a member of this school", so membership isn't revealed.
    if (allowed && user && meta.host.kind === 'school') {
      allowed = (await this.access.loadSchoolAccess(user.id, meta.host.schoolId)) !== null;
    }
    if (allowed && user && meta.host.kind === 'platform') {
      // Super-admin MFA is a release blocker. Until it exists, platform sign-in only works outside production.
      allowed = user.platformRole !== null && (getEnv().NODE_ENV !== 'production' || user.mfaEnabled);
    }

    if (!allowed || !user) {
      this.limiter.recordFailure(limiterKey);
      await this.audit.record({
        action: 'auth.login',
        outcome: 'DENIED',
        resourceType: 'session',
        schoolId,
        actorUserId: user?.id ?? null,
        correlationId: meta.correlationId,
      });
      throw invalidCredentials();
    }

    // Two-step sign-in: only asked for after the password is right, so it isn't an oracle for passwords.
    if (user.mfaEnabled) {
      if (!input.code) {
        throw new UnauthorizedException({ code: 'MFA_REQUIRED', message: 'Enter the 6-digit code from your authenticator app.' });
      }
      if (!(await this.mfa.check(user.id, input.code))) {
        this.limiter.recordFailure(limiterKey);
        await this.audit.record({ action: 'auth.login_mfa', outcome: 'DENIED', resourceType: 'session', schoolId, actorUserId: user.id, correlationId: meta.correlationId });
        throw new UnauthorizedException({ code: 'INVALID_CODE', message: 'That code didn’t work. Use the newest code, or a recovery code.' });
      }
    }

    this.limiter.reset(limiterKey);
    const session = await this.sessions.create(user.id, schoolId, meta.userAgent, client);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({
      action: 'auth.login',
      outcome: 'SUCCESS',
      resourceType: 'session',
      resourceId: session.sessionId,
      schoolId,
      actorUserId: user.id,
      correlationId: meta.correlationId,
    });
    return session;
  }

  async logout(token: string | undefined, actorUserId: string | null, meta: RequestMeta) {
    if (!token) return;
    const revoked = await this.sessions.revokeByToken(token);
    if (revoked) {
      await this.audit.record({
        action: 'auth.logout',
        outcome: 'SUCCESS',
        resourceType: 'session',
        schoolId: meta.host.kind === 'school' ? meta.host.schoolId : null,
        actorUserId,
        correlationId: meta.correlationId,
      });
    }
  }

  async activate(input: ActivateInput, meta: RequestMeta) {
    const passwordHash = await hashPassword(input.password);
    const userId = await this.prisma.$transaction(async (tx) => {
      const uid = await this.tokens.consume(tx, input.token, 'ACTIVATION');
      if (!uid) throw invalidLink();
      const updated = await tx.user.updateMany({
        where: { id: uid, status: 'INVITED' },
        data: { passwordHash, status: 'ACTIVE', ...(input.fullName ? { fullName: input.fullName } : {}) },
      });
      if (updated.count !== 1) throw invalidLink(); // rolls back the token use
      return uid;
    });
    await this.audit.record({
      action: 'auth.activate',
      outcome: 'SUCCESS',
      resourceType: 'user',
      resourceId: userId,
      actorUserId: userId,
      schoolId: meta.host.kind === 'school' ? meta.host.schoolId : null,
      correlationId: meta.correlationId,
    });
  }

  /**
   * Always returns immediately with the same response. The lookup and email run in the
   * background so response time doesn't reveal whether the account exists.
   */
  requestPasswordReset(email: string, meta: RequestMeta): void {
    void this.sendResetIfEligible(email, meta).catch((err) =>
      this.logger.error({ msg: 'Password reset email failed', correlationId: meta.correlationId, err }),
    );
  }

  private async sendResetIfEligible(email: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, status: true, platformRole: true },
    });
    if (!user || user.status !== 'ACTIVE') return;
    if (meta.host.kind === 'school' && !(await this.access.loadSchoolAccess(user.id, meta.host.schoolId))) return;
    if (meta.host.kind === 'platform' && !user.platformRole) return;
    await queueAccountEmail(this.prisma, {
      userId: user.id,
      schoolId: meta.host.kind === 'school' ? meta.host.schoolId : null,
      template: 'RESET',
    });
  }

  async resetPassword(input: SetPasswordInput, meta: RequestMeta) {
    const passwordHash = await hashPassword(input.password);
    const userId = await this.prisma.$transaction(async (tx) => {
      const uid = await this.tokens.consume(tx, input.token, 'PASSWORD_RESET');
      if (!uid) throw invalidLink();
      const updated = await tx.user.updateMany({ where: { id: uid, status: 'ACTIVE' }, data: { passwordHash } });
      if (updated.count !== 1) throw invalidLink();
      // Sign out everywhere after a password change.
      await tx.session.updateMany({ where: { userId: uid, revokedAt: null }, data: { revokedAt: new Date() } });
      return uid;
    });
    this.limiter.reset(userId);
    await this.audit.record({
      action: 'auth.password_reset',
      outcome: 'SUCCESS',
      resourceType: 'user',
      resourceId: userId,
      actorUserId: userId,
      schoolId: meta.host.kind === 'school' ? meta.host.schoolId : null,
      correlationId: meta.correlationId,
    });
  }
}
