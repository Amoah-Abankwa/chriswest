import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { Clock } from '../src/common/clock';
import { Mailer, MailTransport, type MailMessage } from '../src/mail/mailer';
import { OutboxProcessor } from '../src/outbox/outbox.processor';
import { PrismaService } from '../src/prisma/prisma.service';
import { HOSTS, PASSWORD, resetDatabase, seedSchools } from './fixtures';
import { client, createTestApp, drainOutbox, signIn } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
let f: Awaited<ReturnType<typeof seedSchools>>;
let sent: MailMessage[];
type Client = ReturnType<typeof client>;

const TODAY = '2026-12-10';

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
  app.get(Clock).setForTests(new Date(`${TODAY}T10:00:00Z`));
});

beforeEach(async () => {
  await resetDatabase(prisma);
  f = await seedSchools(prisma);
  sent = [];
  jest.restoreAllMocks();
  jest.spyOn(app.get(MailTransport), 'deliver').mockImplementation(async (m: MailMessage) => {
    sent.push(m);
    return { messageId: `test-${sent.length}` };
  });
});

afterAll(async () => {
  app.get(Clock).setForTests(null);
  await app.close();
});

const as = async (host: string, email: string) => client(app, host, await signIn(app, host, email));
const oakManager = () => as(HOSTS.oakwood, 'maya@example.test');
const linkFrom = (m: MailMessage, path: string) => {
  const match = m.text.match(new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`));
  if (!match) throw new Error(`No ${path} link in email`);
  return match[1]!;
};

describe('account emails go through the queue', () => {
  it('sends a staff invitation from the worker, and its link activates the account', async () => {
    const m = await oakManager();
    const teacher = (await prisma.role.findFirstOrThrow({ where: { schoolId: f.oakwood.id, key: 'teacher' } })).id;
    await m.post('/staff/invitations').send({ email: 'esi@example.test', roleIds: [teacher] }).expect(201);

    // Nothing is sent during the request, and no link exists yet.
    expect(sent).toHaveLength(0);
    expect(await prisma.authToken.count()).toBe(0);
    const queued = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'account.email' } });
    expect(JSON.stringify(queued.payload)).not.toMatch(/token/i);

    await drainOutbox(app);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'esi@example.test', subject: 'Set up your Oakwood Academy account' });
    const token = linkFrom(sent[0]!, '/activate');
    await client(app, HOSTS.oakwood).post('/auth/activate').send({ token, password: PASSWORD }).expect(204);
    await signIn(app, HOSTS.oakwood, 'esi@example.test');

    const log = (await m.get('/school/emails').expect(200)).body.data;
    expect(log).toEqual([expect.objectContaining({ toAddress: 'esi@example.test', status: 'SENT', kind: 'account.invite' })]);
  });

  it('sends password resets through the queue too', async () => {
    await client(app, HOSTS.oakwood).post('/auth/forgot-password').send({ email: 'alice@example.test' }).expect(202);
    await new Promise((r) => setTimeout(r, 50)); // the request queues in the background
    await drainOutbox(app);
    const token = linkFrom(sent.find((x) => x.to === 'alice@example.test')!, '/reset-password');
    await client(app, HOSTS.oakwood).post('/auth/reset-password').send({ token, password: 'a-new-strong-password' }).expect(204);
    await signIn(app, HOSTS.oakwood, 'alice@example.test', 'a-new-strong-password');
  });

  it('skips an invitation if access was removed before it went out', async () => {
    const m = await oakManager();
    const teacher = (await prisma.role.findFirstOrThrow({ where: { schoolId: f.oakwood.id, key: 'teacher' } })).id;
    const invited = (await m.post('/staff/invitations').send({ email: 'gone@example.test', roleIds: [teacher] }).expect(201)).body.data;
    await m.post(`/staff/${invited.membershipId}/deactivate`).send({ reason: 'Hired by mistake' }).expect(200);
    await drainOutbox(app);
    expect(sent.filter((x) => x.to === 'gone@example.test')).toEqual([]);
  });
});

describe('failures are retried, recorded and visible', () => {
  it('retries with backoff, gives up after 5 attempts, and can be retried by a super admin', async () => {
    const m = await oakManager();
    const teacher = (await prisma.role.findFirstOrThrow({ where: { schoolId: f.oakwood.id, key: 'teacher' } })).id;
    await m.post('/staff/invitations').send({ email: 'kwesi@example.test', roleIds: [teacher] }).expect(201);
    const deliver = jest.spyOn(app.get(MailTransport), 'deliver').mockRejectedValue(new Error('SMTP connection refused'));

    for (let i = 0; i < 5; i++) await drainOutbox(app);
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'account.email' } });
    expect(event).toMatchObject({ attempts: 5, lastError: 'SMTP connection refused' });
    expect(event.failedAt).not.toBeNull();
    expect(deliver).toHaveBeenCalledTimes(5);
    expect(await prisma.emailDelivery.count({ where: { status: 'FAILED' } })).toBe(5);

    const admin = client(app, HOSTS.admin, await signIn(app, HOSTS.admin, 'root@platform.test'));
    const summary = (await admin.get('/platform/ops/summary').expect(200)).body.data;
    expect(summary.outbox.failed).toBe(1);
    expect(summary.email.failedLast24h).toBe(5);
    expect(summary.worker.alive).toBe(false);

    const failed = (await admin.get('/platform/ops/events?status=failed').expect(200)).body.data;
    expect(failed).toEqual([expect.objectContaining({ id: event.id, type: 'account.email', schoolName: 'Oakwood Academy', lastError: 'SMTP connection refused' })]);
    expect(failed[0].payload).toBeUndefined();

    // Mail is fixed; the admin retries.
    deliver.mockRestore();
    jest.spyOn(app.get(MailTransport), 'deliver').mockImplementation(async (msg: MailMessage) => {
      sent.push(msg);
      return {};
    });
    const support = client(app, HOSTS.admin, await signIn(app, HOSTS.admin, 'helpdesk@platform.test'));
    await support.post(`/platform/ops/events/${event.id}/retry`).expect(403);
    await admin.post(`/platform/ops/events/${event.id}/retry`).expect(200);
    await drainOutbox(app);
    expect(sent.map((x) => x.to)).toContain('kwesi@example.test');
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).processedAt).not.toBeNull();

    await app.get(OutboxProcessor).heartbeat('test-worker');
    expect((await admin.get('/platform/ops/summary').expect(200)).body.data.worker.alive).toBe(true);
    await m.get('/platform/ops/summary').expect(404);
  });

  it('cleans up old finished jobs and email records', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    await prisma.outboxEvent.create({ data: { type: 'x', payload: {}, dedupeKey: 'old', processedAt: old, createdAt: old } });
    await prisma.emailDelivery.create({ data: { toAddress: 'a@b.test', subject: 'old', status: 'SENT', createdAt: old } });
    expect(await app.get(OutboxProcessor).cleanup()).toMatchObject({ events: 1, emails: 1 });
  });
});

describe('PDFs', () => {
  async function paidStudent(m: Client) {
    const year = (await m.post('/academic-years').send({ name: '2026/2027', startDate: '2026-09-01', endDate: '2027-07-31' }).expect(201)).body.data;
    const term = (await m.post(`/academic-years/${year.id}/terms`).send({ name: 'Term 1', startDate: '2026-09-01', endDate: '2026-12-18' }).expect(201)).body.data.terms[0];
    await m.post(`/academic-years/${year.id}/activate`).send({}).expect(200);
    const levels = (await m.post('/education-levels/standard').send({ stages: ['PRIMARY'] }).expect(200)).body.data;
    const cls = (await m.post('/classes').send({ academicYearId: year.id, levelId: levels[0].id, name: 'P1 A' }).expect(201)).body.data;
    const studentId = (await m.post('/students').send({ firstName: 'Ama', lastName: 'Test', admissionDate: '2026-09-01', classId: cls.id }).expect(201)).body.data.id;
    await m.post(`/students/${studentId}/guardians`).send({ guardian: { fullName: 'Akua', email: 'akua@example.test' }, relationship: 'MOTHER' }).expect(201);
    const cat = (await m.post('/fee-categories').send({ name: 'Tuition' }).expect(201)).body.data[0].id;
    await m.post('/invoices').send({ studentId, termId: term.id, items: [{ categoryId: cat, amountMinor: 120000 }] }).expect(201);
    const payment = (await m.post('/payments').set('Idempotency-Key', randomUUID()).send({ studentId, amountMinor: 50000, method: 'CASH', receivedOn: TODAY }).expect(201)).body.data;
    return { term, cls, studentId, payment };
  }

  const binary = (res: NodeJS.ReadableStream, done: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  };

  it('produces a receipt PDF and attaches it to the payment confirmation', async () => {
    const m = await oakManager();
    const { payment } = await paidStudent(m);
    const pdf = await m.get(`/receipts/${payment.receipt.id}/pdf`).buffer(true).parse(binary as never).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    await drainOutbox(app);
    const confirmation = sent.find((x) => x.subject.includes('payment received'))!;
    expect(confirmation.to).toBe('akua@example.test');
    expect(confirmation.attachments).toEqual([expect.objectContaining({ filename: `receipt-${payment.receipt.number}.pdf`, contentType: 'application/pdf' })]);
    expect(confirmation.attachments![0]!.content.subarray(0, 5).toString()).toBe('%PDF-');

    const maple = await as(HOSTS.maple, 'mo@example.test');
    await maple.get(`/receipts/${payment.receipt.id}/pdf`).expect(404);
  });

  it('builds a class’s report cards in the background for the person who asked', async () => {
    const m = await oakManager();
    const { term, cls, studentId } = await paidStudent(m);
    const subjects = (await m.post('/subjects/common').expect(200)).body.data as { id: string; code: string }[];
    const math = subjects.find((s) => s.code === 'MATH')!.id;
    await m.put(`/classes/${cls.id}/subjects`).send({ subjects: [{ subjectId: math }] }).expect(200);
    const comps = (await m.put('/assessments').send({ termId: term.id, components: [{ name: 'Exam', maxMarks: 100, weight: 100 }] }).expect(200)).body.data.components;
    const key = { termId: term.id, classId: cls.id, subjectId: math };

    // Not published yet: nothing to export.
    expect((await m.post('/exports/report-cards').send({ termId: term.id, classId: cls.id }).expect(409)).body.error.code).toBe('NOT_PUBLISHED');
    await m.put('/results/sheet/marks').send({ ...key, marks: [{ studentId, assessmentId: comps[0].id, score: 74 }] }).expect(200);
    await m.post('/results/sheet/submit').send(key).expect(200);
    await m.post('/results/sheet/approve').send(key).expect(200);
    await m.post('/results/publish').send({ termId: term.id, classId: cls.id }).expect(200);

    const single = await m.get(`/students/${studentId}/report-cards/${term.id}/pdf`).buffer(true).parse(binary as never).expect(200);
    expect((single.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const job = (await m.post('/exports/report-cards').send({ termId: term.id, classId: cls.id }).expect(202)).body.data;
    expect(job.status).toBe('QUEUED');
    await m.get(`/exports/${job.id}/download`).expect(409);
    await drainOutbox(app);
    expect((await m.get(`/exports/${job.id}`).expect(200)).body.data.status).toBe('READY');
    const file = await m.get(`/exports/${job.id}/download`).buffer(true).parse(binary as never).expect(200);
    expect((file.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await m.get('/notifications').expect(200)).body.data).toEqual([expect.objectContaining({ kind: 'export.ready' })]);

    // Only the requester can see or download it, and other schools can't at all.
    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    await tom.get(`/exports/${job.id}/download`).expect(404);
    const maple = await as(HOSTS.maple, 'mo@example.test');
    await maple.get(`/exports/${job.id}`).expect(404);
    await maple.get(`/students/${studentId}/report-cards/${term.id}/pdf`).expect(404);
  });
});
