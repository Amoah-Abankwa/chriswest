import { createParamDecorator, ExecutionContext, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { SchoolContext } from './host-context';

/** Injects the server-resolved school context. Never read schoolId from body/query/params. */
export const CurrentSchool = createParamDecorator((_: unknown, ctx: ExecutionContext): SchoolContext => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (req.hostContext?.kind !== 'school') {
    throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
  }
  return req.hostContext;
});
