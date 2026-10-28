import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { HOSTS, PASSWORD, resetDatabase, seedSchools } from './fixtures';
import { createTestApp, signIn } from './helpers';

/** The mobile app signs in for a bearer token, kept in the phone's secure storage. */
let app: NestExpressApplication;
let prisma: PrismaService;

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});
beforeEach(async () => {
  await resetDatabase(prisma);
  await seedSchools(prisma);
});
afterAll(async () => {
  await app.close();
});

const api = () => request(app.getHttpServer());
const mobileLogin = (email: string, host = HOSTS.oakwood) =>
  api().post('/api/v1/auth/mobile/login').set('Host', host).send({ email, password: PASSWORD });

describe('mobile sign-in', () => {
  it('returns a token that works as a bearer, without cookies or an Origin header', async () => {
    const res = await mobileLogin('maya@example.test').expect(200);
    const { token, expiresAt } = res.body.data;
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);

    const auth = { Authorization: `Bearer ${token}` };
    await api().get('/api/v1/auth/me').set('Host', HOSTS.oakwood).set(auth).expect(200);
    // A write with no Origin header: allowed for bearer requests.
    await api().post('/api/v1/notifications/read-all').set('Host', HOSTS.oakwood).set(auth).expect(200);

    await api().post('/api/v1/auth/mobile/logout').set('Host', HOSTS.oakwood).set(auth).expect(204);
    await api().get('/api/v1/auth/me').set('Host', HOSTS.oakwood).set(auth).expect(401);
  });

  it('keeps app tokens and browser cookies apart, and each to its own school', async () => {
    const token = (await mobileLogin('maya@example.test').expect(200)).body.data.token as string;
    // The app token doesn't work as a cookie...
    await api().get('/api/v1/auth/me').set('Host', HOSTS.oakwood).set('Cookie', `sid=${token}`).expect(401);
    // ...and a browser session doesn't work as a bearer token.
    const cookie = await signIn(app, HOSTS.oakwood, 'maya@example.test');
    const webToken = /sid=([^;]+)/.exec(cookie)![1]!;
    await api().get('/api/v1/auth/me').set('Host', HOSTS.oakwood).set('Authorization', `Bearer ${webToken}`).expect(401);
    // ...and it only works on the school it was issued for.
    await api().get('/api/v1/auth/me').set('Host', HOSTS.maple).set('Authorization', `Bearer ${token}`).expect(401);
  });

  it('still protects cookie requests from forged writes', async () => {
    const cookie = await signIn(app, HOSTS.oakwood, 'maya@example.test');
    // A cookie plus a made-up bearer header doesn't get past the Origin check.
    await api()
      .post('/api/v1/notifications/read-all')
      .set('Host', HOSTS.oakwood)
      .set('Cookie', cookie)
      .set('Authorization', 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      .expect(403);
  });

  it('lets the app ask for a password reset without an Origin header', async () => {
    await api().post('/api/v1/auth/mobile/forgot-password').set('Host', HOSTS.oakwood).send({ email: 'maya@example.test' }).expect(202);
    // The browser route still insists on a same-site Origin.
    await api().post('/api/v1/auth/forgot-password').set('Host', HOSTS.oakwood).send({ email: 'maya@example.test' }).expect(403);
  });

  it('is not available on the admin address, and asks for the two-step code when needed', async () => {
    await mobileLogin('root@platform.test', HOSTS.admin).expect(404);
    await prisma.user.update({ where: { email: 'maya@example.test' }, data: { mfaEnabled: true } });
    expect((await mobileLogin('maya@example.test').expect(401)).body.error.code).toBe('MFA_REQUIRED');
  });
});
