import { ForbiddenException, Injectable, NestMiddleware, NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { getEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeHostname } from './hostname';

/**
 * Resolves the tenant from the request hostname against the trusted school_domains registry.
 * req.hostname honours X-Forwarded-Host only from proxies listed in TRUST_PROXY.
 * Unknown, unverified or inactive hosts are rejected; there is never a default tenant.
 * This identifies the school. It does NOT authorize the user — membership is checked separately.
 */
@Injectable()
export class TenantResolverMiddleware implements NestMiddleware {
  constructor(private readonly prisma: PrismaService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    let host = normalizeHostname(req.hostname);
    // Development only (refused in production at startup): a phone on the Wi-Fi reaches the API by IP.
    const env = getEnv();
    if (host && env.DEV_SCHOOL_HOST_ALIASES.includes(host)) host = env.SCHOOL_HOST;
    if (!host) throw new NotFoundException({ code: 'UNKNOWN_HOST', message: 'Unknown host' });

    if (host === getEnv().PLATFORM_ADMIN_HOST) {
      req.hostContext = { kind: 'platform' };
      return next();
    }

    const domain = await this.prisma.schoolDomain.findUnique({
      where: { hostname: host },
      select: {
        isVerified: true,
        school: { select: { id: true, slug: true, name: true, status: true, timezone: true } },
      },
    });

    if (!domain || !domain.isVerified) {
      throw new NotFoundException({ code: 'UNKNOWN_HOST', message: 'Unknown host' });
    }
    if (domain.school.status !== 'ACTIVE') {
      throw new ForbiddenException({ code: 'TENANT_UNAVAILABLE', message: 'The school portal is temporarily unavailable. Please try again later.' });
    }

    const { id, slug, name, timezone } = domain.school;
    req.hostContext = { kind: 'school', schoolId: id, slug, name, timezone };
    next();
  }
}
