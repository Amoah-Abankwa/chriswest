import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { stepAt, totpAt, verifyTotp } from '../src/auth/totp';
import { Clock } from '../src/common/clock';
import { OutboxProcessor } from '../src/outbox/outbox.processor';
import { PrismaService } from '../src/prisma/prisma.service';
import { HOSTS, PASSWORD, resetDatabase, seedSchools } from './fixtures';
import { client, createTestApp, drainOutbox, signIn } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
let clock: Clock;
let f: Awaited<ReturnType<typeof seedSchools>>;
type Client = ReturnType<typeof client>;

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
  clock = app.get(Clock);
});
beforeEach(async () => {
  await resetDatabase(prisma);
  f = await seedSchools(prisma);
  clock.setForTests(new Date('2026-10-13T10:00:00Z'));
});
afterAll(async () => {
  clock.setForTests(null);
  await app.close();
});

const as = async (host: string, email: string) => client(app, host, await signIn(app, host, email));
const tick = (seconds: number) => clock.setForTests(new Date(clock.now().getTime() + seconds * 1000));

describe('two-step sign-in', () => {
  it('matches the RFC 6238 test vector', () => {
    // RFC 6238 appendix B, SHA-1 secret "12345678901234567890" at T=59s → 94287082 (last 6 digits).
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totpAt(secret, stepAt(new Date(59_000)))).toBe('287082');
    expect(verifyTotp(secret, '287082', new Date(59_000), null)).toBe(1);
    expect(verifyTotp(secret, '287082', new Date(59_000), 1)).toBeNull(); // already used
  });

  it('sets up, then requires a fresh code at sign-in, and accepts each recovery code once', async () => {
    const admin = await as(HOSTS.admin, 'root@platform.test');
    const { secret } = (await admin.post('/auth/mfa/setup').expect(200)).body.data;
    expect((await admin.post('/auth/mfa/enable').send({ code: '000000' }).expect(400)).body.error.code).toBe('INVALID_CODE');
    const enabled = (await admin.post('/auth/mfa/enable').send({ code: totpAt(secret, stepAt(clock.now())) }).expect(200)).body.data;
    expect(enabled.recoveryCodes).toHaveLength(10);
    const stored = await prisma.user.findUniqueOrThrow({ where: { email: 'root@platform.test' } });
    expect(stored.mfaSecret).not.toContain(secret); // encrypted at rest

    const login = (body: object) => client(app, HOSTS.admin).post('/auth/login').send({ email: 'root@platform.test', password: PASSWORD, ...body });
    expect((await login({}).expect(401)).body.error.code).toBe('MFA_REQUIRED');
    expect((await login({ code: '123456' }).expect(401)).body.error.code).toBe('INVALID_CODE');
    tick(30);
    const code = totpAt(secret, stepAt(clock.now()));
    await login({ code }).expect(204);
    await login({ code }).expect(401); // the same code can't be replayed

    await login({ code: enabled.recoveryCodes[0] }).expect(204);
    await login({ code: enabled.recoveryCodes[0] }).expect(401);
    expect((await admin.get('/auth/mfa').expect(200)).body.data).toMatchObject({ enabled: true, recoveryCodesLeft: 9 });

    // Wrong password never reveals whether two-step sign-in is on.
    expect((await login({ password: 'wrong-password' }).expect(401)).body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('retention and data portability', () => {
  it('removes expired sign-in records and old audit entries, and keeps school records', async () => {
    const old = new Date('2019-01-01T00:00:00Z');
    await prisma.session.create({ data: { userId: f.maya.user.id, schoolId: f.oakwood.id, tokenHash: randomUUID(), expiresAt: old, createdAt: old, lastSeenAt: old } });
    await prisma.authToken.create({ data: { userId: f.maya.user.id, purpose: 'PASSWORD_RESET', tokenHash: randomUUID(), expiresAt: old, createdAt: old } });
    await prisma.auditLog.create({ data: { action: 'old', outcome: 'SUCCESS', resourceType: 'x', createdAt: new Date('2010-01-01T00:00:00Z') } });
    const result = await app.get(OutboxProcessor).cleanup();
    expect(result).toMatchObject({ sessions: 1, tokens: 1, audit: 1 });
    expect(await prisma.student.count()).toBe(2);
  });

  it('exports a school’s whole record set for its managers, without secrets', async () => {
    const m = await as(HOSTS.oakwood, 'maya@example.test');
    const job = (await m.post('/exports/school-data').expect(202)).body.data;
    await drainOutbox(app);
    expect((await m.get(`/exports/${job.id}`).expect(200)).body.data.status).toBe('READY');
    const file = await m.get(`/exports/${job.id}/download`).expect(200);
    expect(file.headers['content-type']).toContain('application/json');
    const data = JSON.parse(Buffer.isBuffer(file.body) ? file.body.toString() : file.text);
    expect(data.students.map((s: { admissionNumber: string }) => s.admissionNumber)).toEqual([f.oakStudent.admissionNumber]);
    const text = JSON.stringify(data);
    for (const secret of ['passwordHash', 'tokenHash', 'mfaSecret', f.mapleStudent.admissionNumber]) expect(text).not.toContain(secret);

    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    await tom.post('/exports/school-data').expect(403);
  });
});

describe('access review', () => {
  it('lists every privileged account and flags missing two-step sign-in', async () => {
    const admin = await as(HOSTS.admin, 'root@platform.test');
    const review = (await admin.get('/platform/ops/access-review').expect(200)).body.data;
    expect(review.platformAccounts.map((a: { email: string }) => a.email)).toEqual(['helpdesk@platform.test', 'root@platform.test']);
    expect(review.platformAccounts.every((a: { needsAttention: boolean }) => a.needsAttention)).toBe(true);
    expect(review.schoolManagers.map((s: { school: string }) => s.school)).toEqual(['Maple Primary', 'Oakwood Academy']);
    const support = await as(HOSTS.admin, 'helpdesk@platform.test');
    await support.get('/platform/ops/access-review').expect(403);
  });
});

/**
 * The release gate from the architecture document: fill one school with data in every module, then
 * check that another school's manager (who holds every permission) can't see any of it in any list,
 * and gets 404 for every record asked for directly.
 */
describe('cross-tenant sweep', () => {
  async function fillOakwood(m: Client) {
    const year = (await m.post('/academic-years').send({ name: '2026/2027', startDate: '2026-09-01', endDate: '2027-07-31' }).expect(201)).body.data;
    const term = (await m.post(`/academic-years/${year.id}/terms`).send({ name: 'Term 1', startDate: '2026-09-01', endDate: '2026-12-18' }).expect(201)).body.data.terms[0];
    await m.post(`/academic-years/${year.id}/activate`).send({}).expect(200);
    const levels = (await m.post('/education-levels/standard').send({ stages: ['PRIMARY'] }).expect(200)).body.data;
    const cls = (await m.post('/classes').send({ academicYearId: year.id, levelId: levels[0].id, name: 'Oak secret class' }).expect(201)).body.data;
    const subject = (await m.post('/subjects').send({ name: 'Oak secret subject', code: 'OAKX' }).expect(201)).body.data.find((s: { code: string }) => s.code === 'OAKX');
    await m.put(`/classes/${cls.id}/subjects`).send({ subjects: [{ subjectId: subject.id }] }).expect(200);
    const student = (await m.post('/students').send({ firstName: 'Zebediah', lastName: 'Oaksecret', admissionDate: '2026-09-01', classId: cls.id }).expect(201)).body.data;
    const guardian = (await m.post(`/students/${student.id}/guardians`).send({ guardian: { fullName: 'Oak Secret Parent', email: 'oakparent@example.test' }, relationship: 'FATHER' }).expect(201)).body.data[0];
    await m.put('/attendance/register').send({ classId: cls.id, date: '2026-10-13', records: [{ studentId: student.id, status: 'ABSENT' }] }).expect(200);
    const cat = (await m.post('/fee-categories').send({ name: 'Oak secret fee' }).expect(201)).body.data[0];
    const invoice = (await m.post('/invoices').send({ studentId: student.id, termId: term.id, items: [{ categoryId: cat.id, amountMinor: 5000 }] }).expect(201)).body.data;
    const payment = (await m.post('/payments').set('Idempotency-Key', randomUUID()).send({ studentId: student.id, amountMinor: 1000, method: 'CASH', receivedOn: '2026-10-13' }).expect(201)).body.data;
    const ann = (await m.post('/announcements').send({ title: 'Oak secret notice', body: 'x', audience: 'EVERYONE' }).expect(201)).body.data;
    await m.post(`/announcements/${ann.id}/publish`).send({}).expect(200);
    const book = (await m.post('/library/books').send({ title: 'Oak secret book', copies: 1 }).expect(201)).body.data;
    const route = (await m.post('/transport/routes').send({ name: 'Oak secret route' }).expect(201)).body.data;
    const page = (await m.post('/website/pages').send({ title: 'Oak secret page', body: 'x' }).expect(201)).body.data;
    const leaveType = (await m.post('/leave/types').send({ name: 'Oak secret leave', daysPerYear: 5 }).expect(201)).body.data[0];
    return { year, term, cls, subject, student, guardian, invoice, payment, ann, book, route, page, leaveType };
  }

  it('leaks nothing through any list, and refuses every direct lookup', async () => {
    const oak = await as(HOSTS.oakwood, 'maya@example.test');
    const o = await fillOakwood(oak);
    const secrets = [
      'Oaksecret', 'Oak secret', o.student.id, o.student.admissionNumber, o.cls.id, o.subject.id, o.invoice.id, o.invoice.number,
      o.payment.id, o.payment.receipt.number, o.guardian.guardianId, o.book.id, o.route.id, o.page.id, o.ann.id, o.year.id, o.term.id,
      f.maya.user.email, f.tom.user.email,
    ];

    const mo = await as(HOSTS.maple, 'mo@example.test');
    const lists = [
      '/students?pageSize=100', '/staff?pageSize=100', '/guardians?pageSize=100', '/classes', '/academic-years', '/subjects', '/education-levels',
      '/roles', '/members', '/invoices?pageSize=100', '/payments?pageSize=100', '/fee-categories', '/fee-structures', '/announcements', '/announcements/feed',
      '/library/books', '/library/loans?status=all', '/transport/routes', '/leave/requests', '/leave/types', '/website/pages', '/website/posts',
      '/website/messages', '/notifications', '/exports', '/school/emails', '/reports/enrollment', '/reports/attendance', '/reports/overview',
      '/reports/csv/students', '/reports/csv/attendance', '/attendance/classes', '/timetable/periods', '/school',
      '/portal/children', '/me/assignments',
    ];
    for (const path of lists) {
      const res = await mo.get(path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      const text = res.text;
      for (const s of secrets) {
        if (text.includes(s)) throw new Error(`${path} leaked "${s}"`);
      }
    }

    const lookups = [
      `/students/${o.student.id}`, `/students/${o.student.id}/attendance`, `/students/${o.student.id}/account`, `/students/${o.student.id}/documents`,
      `/students/${o.student.id}/guardians`, `/students/${o.student.id}/report-cards`, `/students/${o.student.id}/transport`, `/students/${o.student.id}/history`,
      `/guardians/${o.guardian.guardianId}`, `/classes/${o.cls.id}`, `/academic-years/${o.year.id}`, `/invoices/${o.invoice.id}`, `/payments/${o.payment.id}`,
      `/receipts/${o.payment.receipt.id}`, `/receipts/${o.payment.receipt.id}/pdf`, `/library/books/${o.book.id}`, `/transport/routes/${o.route.id}`,
      `/timetable/classes/${o.cls.id}`, `/attendance/register?classId=${o.cls.id}`, `/attendance/summary?classId=${o.cls.id}`,
      `/results/sheet?termId=${o.term.id}&classId=${o.cls.id}&subjectId=${o.subject.id}`, `/reports/academic?termId=${o.term.id}`,
      `/reports/finance?termId=${o.term.id}`, `/finance/summary?termId=${o.term.id}`, `/assessments?termId=${o.term.id}`,
      `/portal/children/${o.student.id}`, `/staff/${f.tom.membership.id}`, `/staff/${f.tom.membership.id}/history`,
    ];
    for (const path of lookups) {
      const res = await mo.get(path);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }

    const writes: [string, string, object][] = [
      ['patch', `/students/${o.student.id}`, { homeAddress: 'x' }],
      ['post', `/students/${o.student.id}/withdraw`, { status: 'WITHDRAWN', reason: 'hijack' }],
      ['post', `/invoices/${o.invoice.id}/void`, { reason: 'hijack' }],
      ['post', `/payments/${o.payment.id}/reversals`, { reason: 'hijack' }],
      ['patch', `/classes/${o.cls.id}`, { name: 'x' }],
      ['post', `/announcements/${o.ann.id}/withdraw`, {}],
      ['patch', `/website/pages/${o.page.id}`, { title: 'x' }],
      ['put', `/timetable/classes/${o.cls.id}`, { entries: [] }],
      ['post', `/academic-years/${o.year.id}/close`, {}],
    ];
    for (const [method, path, body] of writes) {
      const res = await (mo as unknown as Record<string, (p: string) => { send: (b: object) => Promise<{ status: number }> }>)[method]!(path).send(body);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }

    // And nothing changed.
    expect((await prisma.student.findUniqueOrThrow({ where: { id: o.student.id } })).status).toBe('ACTIVE');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: o.payment.id } })).status).toBe('RECORDED');
  });
});
