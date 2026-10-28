import { Controller, Get, NotFoundException, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/decorators';

@Controller('tenant')
export class TenancyController {
  /** Public branding for signed-out pages. Exposes only non-sensitive fields. */
  @Public()
  @Get('current')
  current(@Req() req: Request) {
    const host = req.hostContext;
    if (!host) throw new NotFoundException({ code: 'UNKNOWN_HOST', message: 'Unknown host' });
    return {
      data:
        host.kind === 'school'
          ? { kind: 'school', slug: host.slug, name: host.name }
          : { kind: 'platform', name: 'Platform administration' },
    };
  }
}
