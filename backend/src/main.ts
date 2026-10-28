import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { getEnv } from './config/env';

async function bootstrap() {
  const env = getEnv(); // fail fast on bad config
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new ConsoleLogger({ json: env.NODE_ENV === 'production' }),
  });
  configureApp(app);
  app.enableShutdownHooks();
  // Bind to localhost only; Nginx/Caddy is the public entry point.
  // Behind Nginx in production, so only reachable from this machine. DEV_LISTEN_ALL lets a phone on
  // the same Wi-Fi reach a development backend.
  await app.listen(env.PORT, env.DEV_LISTEN_ALL === 'true' ? '0.0.0.0' : '127.0.0.1');
}

void bootstrap();
