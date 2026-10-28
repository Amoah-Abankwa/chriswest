import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function correlationId(req: Request, res: Response, next: NextFunction) {
  req.correlationId = randomUUID();
  res.setHeader('X-Request-Id', req.correlationId);
  next();
}
