import type { NestExpressApplication } from '@nestjs/platform-express';
import { PERMISSIONS } from '../src/access/permissions';
import { MailTransport, type MailMessage } from '../src/mail/mailer';
import { PrismaService } from '../src/prisma/prisma.service';
import { HOSTS, PASSWORD, resetDatabase, seedPlatformOnly } from './fixtures';
import { client, createTestApp, drainOutbox, signIn } from './helpers';

/**
 * The super admin creates the one school and its owner; the owner takes it from there.
 * SCHOOL_HOST in .env.test is oakwood.test, so the created school lives at HOSTS.oakwood.
 */
let app: NestExpressApplication;
let prisma: PrismaService;
let sent: MailMessage[];

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});
beforeEach(async () => {
  await resetDatabase(prisma);
  await seedPlatformOnly(prisma);
  sent = [];
  jest.restoreAllMocks();
  jest.spyOn(app.get(MailTransport), 'deliver').mockImplementation(async (m: MailMessage) => {
    sent.push(m);
    return {};
  });
});
afterAll(async () => {
  await app.close();
});

const admin = async () => client(app, HOSTS.admin, await signIn(app, HOSTS.admin, 'root@platform.test'));
const school = { name: 'Oakwood Academy', ownerName: 'Akosua Mensah', ownerEmail: 'owner@oakwood.test' };

async function activateFromEmail(email: string) {
  const msg = sent.filter((m) => m.to === email).at(-1);
  const token = msg?.text.match(/\/activate\?token=([A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error(`No activation link sent to ${email}`);
  await client(app, HOSTS.oakwood).post('/auth/activate').send({ token, password: PASSWORD }).expect(204);
}

describe('creating the school', () => {
  it('happens once, invites the owner, and the owner can set up staff and roles', async () => {
    const a = await admin();
    expect((await a.get('/platform/school').expect(200)).body.data).toBeNull();
    await client(app, HOSTS.oakwood).get('/tenant/current').expect(404); // nothing at the school address yet

    const created = (await a.post('/platform/school').send(school).expect(201)).body.data;
    expect(created).toMatchObject({ name: 'Oakwood Academy', hostname: HOSTS.oakwood, status: 'ACTIVE', owners: [expect.objectContaining({ email: 'owner@oakwood.test', status: 'INVITED' })] });
    expect((await a.post('/platform/school').send({ ...school, name: 'Second school' }).expect(409)).body.error.code).toBe('SCHOOL_EXISTS');
    expect(await prisma.school.count()).toBe(1);

    await drainOutbox(app);
    expect(sent[0]!.subject).toBe('Set up your Oakwood Academy account');
    expect(sent[0]!.text).toContain('owner of Oakwood Academy');
    await activateFromEmail('owner@oakwood.test');

    const owner = client(app, HOSTS.oakwood, await signIn(app, HOSTS.oakwood, 'owner@oakwood.test'));
    const me = (await owner.get('/auth/me').expect(200)).body.data;
    expect(me.permissions).toHaveLength(PERMISSIONS.length); // the owner holds every permission
    expect((await prisma.role.findFirstOrThrow({ where: { key: 'manager' } })).name).toBe('School owner');
    const teacher = (await owner.get('/roles').expect(200)).body.data.find((r: { key: string }) => r.key === 'teacher');
    await owner.post('/staff/invitations').send({ email: 'teacher@oakwood.test', fullName: 'Kofi Asante', roleIds: [teacher.id] }).expect(201);
    await owner.get('/school/setup').expect(200);
  });

  it('allows only one school even when two requests race', async () => {
    const a = await admin();
    const results = await Promise.all([a.post('/platform/school').send(school), a.post('/platform/school').send({ ...school, name: 'Twin' })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.school.count()).toBe(1);
  });
});

describe('owners', () => {
  it('can be added, re-invited until they activate, and never be a super admin', async () => {
    const a = await admin();
    await a.post('/platform/school').send(school).expect(201);
    const after = (await a.post('/platform/school/owners').send({ email: 'coowner@oakwood.test', fullName: 'Yaw Boateng' }).expect(201)).body.data;
    expect(after.owners.map((o: { email: string }) => o.email).sort()).toEqual(['coowner@oakwood.test', 'owner@oakwood.test']);
    expect((await a.post('/platform/school/owners').send({ email: 'coowner@oakwood.test' }).expect(409)).body.error.code).toBe('ALREADY_OWNER');
    expect((await a.post('/platform/school/owners').send({ email: 'root@platform.test' }).expect(409)).body.error.code).toBe('EMAIL_NOT_ALLOWED');

    const first = after.owners.find((o: { email: string }) => o.email === 'owner@oakwood.test');
    await a.post(`/platform/school/owners/${first.id}/resend-invitation`).expect(200);
    await drainOutbox(app);
    await activateFromEmail('owner@oakwood.test');
    expect((await a.post(`/platform/school/owners/${first.id}/resend-invitation`).expect(409)).body.error.code).toBe('ALREADY_ACTIVE');
  });
});

describe('suspending', () => {
  it('signs everyone at the school out and keeps them out until reactivated', async () => {
    const a = await admin();
    await a.post('/platform/school').send(school).expect(201);
    await drainOutbox(app);
    await activateFromEmail('owner@oakwood.test');
    const owner = client(app, HOSTS.oakwood, await signIn(app, HOSTS.oakwood, 'owner@oakwood.test'));

    await a.patch('/platform/school/status').send({ status: 'SUSPENDED', reason: 'Security incident' }).expect(200);
    expect((await owner.get('/auth/me').expect(403)).body.error.code).toBe('TENANT_UNAVAILABLE');
    await a.patch('/platform/school/status').send({ status: 'SUSPENDED', reason: 'again' }).expect(409);
    await a.patch('/platform/school/status').send({ status: 'ACTIVE', reason: 'Resolved' }).expect(200);
    await signIn(app, HOSTS.oakwood, 'owner@oakwood.test');
    expect(await prisma.auditLog.count({ where: { action: 'school.status_change' } })).toBe(2);
  });
});

describe('who can do what', () => {
  it('keeps the admin area to platform accounts, and support read-only', async () => {
    await client(app, HOSTS.admin).get('/platform/school').expect(401);
    const support = client(app, HOSTS.admin, await signIn(app, HOSTS.admin, 'helpdesk@platform.test'));
    await support.get('/platform/school').expect(200);
    await support.post('/platform/school').send(school).expect(403);

    const a = await admin();
    await a.post('/platform/school').send(school).expect(201);
    await support.patch('/platform/school/status').send({ status: 'SUSPENDED', reason: 'test' }).expect(403);
    await support.post('/platform/school/owners').send({ email: 'x@oakwood.test' }).expect(403);

    // The school address never serves platform routes, even to a signed-in owner.
    await drainOutbox(app);
    await activateFromEmail('owner@oakwood.test');
    const owner = client(app, HOSTS.oakwood, await signIn(app, HOSTS.oakwood, 'owner@oakwood.test'));
    await owner.get('/platform/school').expect(404);
    // And super admins can't sign in at the school address.
    await client(app, HOSTS.oakwood).post('/auth/login').send({ email: 'root@platform.test', password: PASSWORD }).expect(401);
  });
});
