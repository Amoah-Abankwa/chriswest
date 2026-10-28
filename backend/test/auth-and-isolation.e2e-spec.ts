import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ACTIVATION_TTL_MS, AuthTokensService, PASSWORD_RESET_TTL_MS } from '../src/auth/auth-tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { HOSTS, PASSWORD, resetDatabase, seedSchools } from './fixtures';

let app: NestExpressApplication;
let prisma: PrismaService;
let tokens: AuthTokensService;
let f: Awaited<ReturnType<typeof seedSchools>>;

/** Requests as a browser on `host` would send them: Host header plus same-host Origin on writes. */
const on = (host: string) => {
  const http = request(app.getHttpServer());
  return {
    get: (path: string) => http.get(`/api/v1${path}`).set('Host', host),
    post: (path: string) => http.post(`/api/v1${path}`).set('Host', host).set('Origin', `http://${host}`),
  };
};

async function login(host: string, email: string, password = PASSWORD): Promise<string> {
  const res = await on(host).post('/auth/login').send({ email, password }).expect(204);
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  const cookie = setCookie.find((c) => c.startsWith('sid='));
  if (!cookie) throw new Error('No session cookie set');
  expect(cookie).toMatch(/HttpOnly/i);
  return cookie.split(';')[0]!;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  prisma = app.get(PrismaService);
  tokens = app.get(AuthTokensService);
});

beforeEach(async () => {
  await resetDatabase(prisma);
  f = await seedSchools(prisma);
});

afterAll(async () => {
  await app.close();
});

describe('host resolution', () => {
  it('rejects unknown hosts instead of falling back to a school', async () => {
    const res = await on('nope.test').get('/tenant/current').expect(404);
    expect(res.body.error.code).toBe('UNKNOWN_HOST');
  });

  it('rejects unverified domains', async () => {
    await on(HOSTS.pending).get('/tenant/current').expect(404);
  });

  it('blocks suspended schools', async () => {
    const res = await on(HOSTS.cedar).get('/tenant/current').expect(403);
    expect(res.body.error.code).toBe('TENANT_UNAVAILABLE');
  });

  it('resolves a verified school host', async () => {
    const res = await on(HOSTS.oakwood).get('/tenant/current').expect(200);
    expect(res.body.data).toEqual({ kind: 'school', slug: 'oakwood', name: 'Oakwood Academy' });
  });
});

describe('login and sessions', () => {
  it('signs in a member and returns their school context', async () => {
    const cookie = await login(HOSTS.oakwood, 'alice@example.test');
    const me = await on(HOSTS.oakwood).get('/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.data.context).toEqual({ kind: 'school', school: { slug: 'oakwood', name: 'Oakwood Academy' } });
    expect(me.body.data.permissions).toEqual(['students.read']);
  });

  it('uses one generic error for wrong passwords, unknown emails and non-members', async () => {
    const wrong = await on(HOSTS.oakwood).post('/auth/login').send({ email: 'alice@example.test', password: 'nope' });
    const unknown = await on(HOSTS.oakwood).post('/auth/login').send({ email: 'ghost@example.test', password: PASSWORD });
    const otherSchool = await on(HOSTS.maple).post('/auth/login').send({ email: 'alice@example.test', password: PASSWORD });
    for (const res of [wrong, unknown, otherSchool]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }
  });

  it("does not accept one school's session on another school's host", async () => {
    const cookie = await login(HOSTS.oakwood, 'alice@example.test');
    await on(HOSTS.maple).get('/auth/me').set('Cookie', cookie).expect(401);
    const denied = await prisma.auditLog.count({ where: { action: 'auth.session_host_mismatch' } });
    expect(denied).toBe(1);
  });

  it('revokes the session on logout', async () => {
    const cookie = await login(HOSTS.oakwood, 'alice@example.test');
    await on(HOSTS.oakwood).post('/auth/logout').set('Cookie', cookie).expect(204);
    await on(HOSTS.oakwood).get('/auth/me').set('Cookie', cookie).expect(401);
  });

  it('cuts off access as soon as the membership is disabled', async () => {
    const cookie = await login(HOSTS.oakwood, 'alice@example.test');
    await prisma.schoolMembership.update({ where: { id: f.alice.membership.id }, data: { status: 'DISABLED' } });
    await on(HOSTS.oakwood).get('/auth/me').set('Cookie', cookie).expect(401);
  });

  it('requires an authenticated session by default', async () => {
    await on(HOSTS.oakwood).get('/students').expect(401);
  });
});

describe('CSRF', () => {
  it('rejects writes with no Origin or Referer', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Host', HOSTS.oakwood)
      .send({ email: 'alice@example.test', password: PASSWORD })
      .expect(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it("rejects writes coming from another school's pages", async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Host', HOSTS.oakwood)
      .set('Origin', `http://${HOSTS.maple}`)
      .send({ email: 'alice@example.test', password: PASSWORD })
      .expect(403);
  });
});

describe('tenant isolation on school data', () => {
  it("reads its own school's student", async () => {
    const cookie = await login(HOSTS.oakwood, 'alice@example.test');
    const res = await on(HOSTS.oakwood).get(`/students/${f.oakStudent.id}`).set('Cookie', cookie).expect(200);
    expect(res.body.data.admissionNumber).toBe('OAK-001');
  });

  it("returns 404 for another school's student ID", async () => {
    const cookie = await login(HOSTS.oakwood, 'alice@example.test');
    await on(HOSTS.oakwood).get(`/students/${f.mapleStudent.id}`).set('Cookie', cookie).expect(404);
  });

  it('ignores a schoolId smuggled into the query string', async () => {
    const cookie = await login(HOSTS.oakwood, 'alice@example.test');
    const res = await on(HOSTS.oakwood)
      .get(`/students?schoolId=${f.maple.id}&pageSize=100`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([f.oakStudent.id]);
    expect(res.body.meta.total).toBe(1);
  });

  it('denies members without the required permission', async () => {
    const cookie = await login(HOSTS.oakwood, 'carol@example.test');
    const res = await on(HOSTS.oakwood).get('/students').set('Cookie', cookie).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('the database refuses role assignments that cross schools', async () => {
    await expect(
      prisma.membershipRole.create({
        data: { schoolId: f.oakwood.id, membershipId: f.alice.membership.id, roleId: f.mapleRole.id },
      }),
    ).rejects.toThrow();
  });
});

describe('activation', () => {
  it('activates an invited account once', async () => {
    const token = await tokens.issue(f.dave.user.id, 'ACTIVATION', ACTIVATION_TTL_MS);
    const password = 'a-brand-new-password';
    await on(HOSTS.oakwood).post('/auth/activate').send({ token, password }).expect(204);
    await login(HOSTS.oakwood, 'dave@example.test', password);
    const again = await on(HOSTS.oakwood).post('/auth/activate').send({ token, password }).expect(400);
    expect(again.body.error.code).toBe('INVALID_TOKEN');
  });

  it('rejects expired activation links', async () => {
    const token = await tokens.issue(f.dave.user.id, 'ACTIVATION', -1000);
    await on(HOSTS.oakwood).post('/auth/activate').send({ token, password: 'a-brand-new-password' }).expect(400);
  });

  it('enforces the password policy', async () => {
    const token = await tokens.issue(f.dave.user.id, 'ACTIVATION', ACTIVATION_TTL_MS);
    const res = await on(HOSTS.oakwood).post('/auth/activate').send({ token, password: 'short' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('password reset', () => {
  it('gives the same response whether or not the account exists', async () => {
    const known = await on(HOSTS.oakwood).post('/auth/forgot-password').send({ email: 'alice@example.test' }).expect(202);
    const unknown = await on(HOSTS.oakwood).post('/auth/forgot-password').send({ email: 'ghost@example.test' }).expect(202);
    expect(known.body).toEqual(unknown.body);
  });

  it('resets the password, signs out other sessions, and works only once', async () => {
    const oldCookie = await login(HOSTS.oakwood, 'alice@example.test');
    const token = await tokens.issue(f.alice.user.id, 'PASSWORD_RESET', PASSWORD_RESET_TTL_MS);
    const password = 'another-strong-password';

    await on(HOSTS.oakwood).post('/auth/reset-password').send({ token, password }).expect(204);
    await on(HOSTS.oakwood).get('/auth/me').set('Cookie', oldCookie).expect(401);
    await on(HOSTS.oakwood).post('/auth/login').send({ email: 'alice@example.test', password: PASSWORD }).expect(401);
    await login(HOSTS.oakwood, 'alice@example.test', password);
    await on(HOSTS.oakwood).post('/auth/reset-password').send({ token, password }).expect(400);
  });

  it('cannot use an activation token to reset a password', async () => {
    const token = await tokens.issue(f.alice.user.id, 'ACTIVATION', ACTIVATION_TTL_MS);
    await on(HOSTS.oakwood).post('/auth/reset-password').send({ token, password: 'another-strong-password' }).expect(400);
  });
});
