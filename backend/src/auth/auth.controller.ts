import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, NotFoundException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ZodPipe } from '../common/zod.pipe';
import type { AuthContext } from './auth-context';
import { ActivateSchema, ForgotPasswordSchema, LoginSchema, MfaCodeSchema, MfaDisableSchema, SetPasswordSchema } from './auth.schemas';
import { MfaService } from './mfa.service';
import { bearerToken } from './guards';
import type { ActivateInput, LoginInput, SetPasswordInput } from './auth.schemas';
import { AuthService } from './auth.service';
import { CurrentAuth, Public, NoOriginCheck } from './decorators';
import { requestMeta } from './request-meta';
import { sessionCookieName, sessionCookieOptions } from './session-cookie';

const STRICT = { default: { limit: 10, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
  ) {}

  // ----- two-step sign-in (any signed-in person; required for platform accounts in production) -----

  @Get('mfa')
  mfaStatus(@CurrentAuth() auth: AuthContext) {
    return this.mfa.status(auth.userId);
  }

  @Post('mfa/setup')
  @HttpCode(HttpStatus.OK)
  mfaSetup(@CurrentAuth() auth: AuthContext) {
    return this.mfa.setup(auth);
  }

  @Post('mfa/enable')
  @HttpCode(HttpStatus.OK)
  @Throttle(STRICT)
  mfaEnable(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(MfaCodeSchema)) body: { code: string }, @Req() req: Request) {
    return this.mfa.enable(auth, body.code, req.correlationId);
  }

  @Post('mfa/disable')
  @HttpCode(HttpStatus.OK)
  @Throttle(STRICT)
  mfaDisable(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(MfaDisableSchema)) body: { password: string; code: string }, @Req() req: Request) {
    return this.mfa.disable(auth, body.password, body.code, req.correlationId);
  }

  @Public()
  @Throttle(STRICT)
  @Post('login')
  @HttpCode(HttpStatus.NO_CONTENT)
  async login(
    @Body(new ZodPipe(LoginSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, expiresAt } = await this.auth.login(body, requestMeta(req));
    res.cookie(sessionCookieName(), token, sessionCookieOptions(expiresAt));
  }

  /**
   * Sign-in for the mobile app: returns the session token instead of setting a cookie. The app keeps
   * it in secure storage and sends it as a bearer token. School address only (super admins use the web).
   */
  @Public()
  @NoOriginCheck()
  @Throttle(STRICT)
  @Post('mobile/login')
  @HttpCode(HttpStatus.OK)
  async mobileLogin(@Body(new ZodPipe(LoginSchema)) body: LoginInput, @Req() req: Request) {
    const meta = requestMeta(req);
    if (meta.host.kind !== 'school') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
    const { token, expiresAt } = await this.auth.login(body, meta, 'MOBILE');
    return { data: { token, expiresAt } };
  }

  @Public()
  @NoOriginCheck()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('mobile/forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  mobileForgotPassword(@Body(new ZodPipe(ForgotPasswordSchema)) body: { email: string }, @Req() req: Request) {
    return this.forgotPassword(body, req);
  }

  @Post('mobile/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async mobileLogout(@CurrentAuth() auth: AuthContext, @Req() req: Request) {
    await this.auth.logout(bearerToken(req), auth.userId, requestMeta(req));
  }

  /** Public so a stale or broken cookie can always be cleared. */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token: unknown = req.cookies?.[sessionCookieName()];
    await this.auth.logout(typeof token === 'string' ? token : undefined, req.auth?.userId ?? null, requestMeta(req));
    res.clearCookie(sessionCookieName(), sessionCookieOptions());
  }

  @Get('me')
  me(@CurrentAuth() auth: AuthContext, @Req() req: Request) {
    const host = requestMeta(req).host;
    return {
      data: {
        user: { id: auth.userId, email: auth.email, fullName: auth.fullName },
        context:
          host.kind === 'school'
            ? { kind: 'school', school: { slug: host.slug, name: host.name } }
            : { kind: 'platform', platformRole: auth.platformRole },
        // For rendering navigation only. The backend re-checks on every request.
        permissions: [...auth.permissions.keys()].sort(),
        assignedOnly: [...auth.permissions].filter(([, scope]) => scope === 'ASSIGNED').map(([key]) => key).sort(),
      },
    };
  }

  @Public()
  @Throttle(STRICT)
  @Post('activate')
  @HttpCode(HttpStatus.NO_CONTENT)
  async activate(@Body(new ZodPipe(ActivateSchema)) body: ActivateInput, @Req() req: Request) {
    await this.auth.activate(body, requestMeta(req));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  forgotPassword(@Body(new ZodPipe(ForgotPasswordSchema)) body: { email: string }, @Req() req: Request) {
    this.auth.requestPasswordReset(body.email, requestMeta(req));
    return {
      data: { message: "If an account exists for that email, we've sent a reset link. It expires in 30 minutes." },
    };
  }

  @Public()
  @Throttle(STRICT)
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body(new ZodPipe(SetPasswordSchema)) body: SetPasswordInput, @Req() req: Request) {
    await this.auth.resetPassword(body, requestMeta(req));
  }
}
