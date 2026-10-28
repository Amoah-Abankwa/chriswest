import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { portalOrigin } from '../common/urls';
import type { RequestMeta } from './auth.service';

export function requestMeta(req: Request): RequestMeta {
  if (!req.hostContext) throw new NotFoundException({ code: 'UNKNOWN_HOST', message: 'Unknown host' });
  return {
    host: req.hostContext,
    ip: req.ip,
    userAgent: req.get('user-agent')?.slice(0, 200),
    correlationId: req.correlationId,
    // req.hostname has already been checked against the domain registry.
    publicOrigin: portalOrigin(req.hostname),
  };
}
