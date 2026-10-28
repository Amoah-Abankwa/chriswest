import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { OutboxProcessor } from '../src/outbox/outbox.processor';
import { PrismaService } from '../src/prisma/prisma.service';
import { PASSWORD } from './fixtures';

export async function createTestApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  return app;
}

/** Requests as a browser on `host` would send them: Host header plus same-host Origin on writes. */
export function client(app: NestExpressApplication, host: string, cookie?: string) {
  const http = request(app.getHttpServer());
  const withCookie = <T extends request.Test>(t: T) => (cookie ? t.set('Cookie', cookie) : t);
  const write = <T extends request.Test>(t: T) => withCookie(t.set('Host', host).set('Origin', `http://${host}`));
  return {
    get: (path: string) => withCookie(http.get(`/api/v1${path}`).set('Host', host)),
    post: (path: string) => write(http.post(`/api/v1${path}`)),
    patch: (path: string) => write(http.patch(`/api/v1${path}`)),
    put: (path: string) => write(http.put(`/api/v1${path}`)),
    delete: (path: string) => write(http.delete(`/api/v1${path}`)),
  };
}

export async function signIn(app: NestExpressApplication, host: string, email: string, password = PASSWORD) {
  const res = await client(app, host).post('/auth/login').send({ email, password }).expect(204);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('sid='));
  if (!cookie) throw new Error('No session cookie set');
  return cookie.split(';')[0]!;
}

/** Makes every queued job due now and runs the worker until the queue is empty. */
export async function drainOutbox(app: NestExpressApplication) {
  const prisma = app.get(PrismaService);
  await prisma.outboxEvent.updateMany({ where: { processedAt: null, failedAt: null }, data: { availableAt: new Date(Date.now() - 1000) } });
  let guard = 0;
  while ((await app.get(OutboxProcessor).runOnce()) > 0 && guard++ < 50);
}
