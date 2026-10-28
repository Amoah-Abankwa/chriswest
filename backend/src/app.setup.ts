import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { correlationId } from './common/correlation-id.middleware';
import { getEnv } from './config/env';

/** Shared by main.ts and the e2e tests so tests exercise the real configuration. */
export function configureApp(app: NestExpressApplication): void {
  // Only trust X-Forwarded-* from the reverse proxy; never from the open internet.
  app.set('trust proxy', getEnv().TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(correlationId);
  app.use(helmet());
  app.use(cookieParser());
  // Frontend and API share one origin through the reverse proxy, so CORS stays off.
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
}
