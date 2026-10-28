import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AccessService } from './access.service';
import { AuthTokensService } from './auth-tokens.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CsrfGuard, PermissionsGuard, SessionGuard } from './guards';
import { LoginAttemptLimiter } from './login-attempts';
import { MfaService } from './mfa.service';
import { SessionsService } from './sessions.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionsService,
    AccessService,
    AuthTokensService,
    LoginAttemptLimiter,
    MfaService,
    // Global guards run in this order on every route.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [AuthTokensService, AccessService],
})
export class AuthModule {}
