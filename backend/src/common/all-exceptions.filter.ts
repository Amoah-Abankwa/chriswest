import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

/** Standard error contract: { error: { code, message, details?, correlationId } }. No stack traces. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        code = typeof b.code === 'string' ? b.code : HttpStatus[status] ?? 'ERROR';
        message = typeof b.message === 'string' ? b.message : message;
        details = b.details;
      } else {
        message = String(body);
        code = HttpStatus[status] ?? 'ERROR';
      }
    } else {
      this.logger.error({ correlationId: req.correlationId, err: exception });
    }

    res.status(status).json({ error: { code, message, details, correlationId: req.correlationId } });
  }
}
