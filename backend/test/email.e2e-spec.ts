import type { NestExpressApplication } from '@nestjs/platform-express';
import { MailTransport, PermanentMailError, ResendTransport, type MailMessage } from '../src/mail/mailer';
import { PrismaService } from '../src/prisma/prisma.service';
import { HOSTS, resetDatabase, seedSchools } from './fixtures';
import { client, createTestApp, drainOutbox, signIn } from './helpers';

/** A fake Resend API: records requests and answers with whatever the test queues up. */
function fakeResend(responses: { status: number; body?: object; headers?: Record<string, string> }[]) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const r = responses.shift() ?? { status: 200, body: { id: `msg_${calls.length}` } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const message: MailMessage = { to: 'akua@example.test', subject: 'Payment received', text: 'Thank you.' };

describe('Resend transport', () => {
  it('sends the right request, with reply-to, attachments, tags and an idempotency key', async () => {
    const { calls, fetchFn } = fakeResend([{ status: 200, body: { id: 'msg_123' } }]);
    const t = new ResendTransport({ apiKey: 're_test', from: 'Portal <n@mail.example.com>', maxPerSecond: 100, fetch: fetchFn });
    const result = await t.deliver(
      { ...message, replyTo: 'office@oakwood.test', idempotencyKey: 'payment:abc:akua@example.test', attachments: [{ filename: 'receipt.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }] },
      { kind: 'payment.recorded' },
    );
    expect(result).toEqual({ messageId: 'msg_123' });
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer re_test', 'Idempotency-Key': 'payment:abc:akua@example.test' });
    expect(calls[0]!.body).toEqual({
      from: 'Portal <n@mail.example.com>',
      to: ['akua@example.test'],
      subject: 'Payment received',
      text: 'Thank you.',
      reply_to: 'office@oakwood.test',
      attachments: [{ filename: 'receipt.pdf', content: Buffer.from('%PDF-1.4').toString('base64'), content_type: 'application/pdf' }],
      tags: [{ name: 'kind', value: 'payment_recorded' }],
    });
  });

  it('waits and retries when rate limited', async () => {
    const waits: number[] = [];
    const { calls, fetchFn } = fakeResend([{ status: 429, body: { name: 'rate_limit_exceeded' }, headers: { 'retry-after': '1' } }, { status: 200, body: { id: 'msg_2' } }]);
    const t = new ResendTransport({ apiKey: 're_test', from: 'x@y.z', maxPerSecond: 100, fetch: fetchFn, sleep: async (ms) => void waits.push(ms) });
    expect(await t.deliver(message)).toEqual({ messageId: 'msg_2' });
    expect(calls).toHaveLength(2);
    expect(waits.some((w) => w >= 900)).toBe(true);
  });

  it('treats rejections as permanent and server errors as temporary', async () => {
    const { fetchFn } = fakeResend([{ status: 422, body: { name: 'validation_error', message: 'Invalid `to` field' } }, { status: 503, body: { name: 'internal_server_error' } }]);
    const t = new ResendTransport({ apiKey: 're_test', from: 'x@y.z', maxPerSecond: 100, fetch: fetchFn });
    await expect(t.deliver(message)).rejects.toBeInstanceOf(PermanentMailError);
    const temporary = await t.deliver(message).catch((e: unknown) => e);
    expect(temporary).toBeInstanceOf(Error);
    expect(temporary).not.toBeInstanceOf(PermanentMailError);
  });

  it('paces requests to the configured rate, even when sends overlap', async () => {
    const { calls, fetchFn } = fakeResend([]);
    const t = new ResendTransport({ apiKey: 're_test', from: 'x@y.z', maxPerSecond: 10, fetch: fetchFn });
    const started = Date.now();
    await Promise.all([1, 2, 3, 4].map(() => t.deliver(message)));
    expect(calls).toHaveLength(4);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280); // 4 requests at 10/s: at least 3 gaps of 100 ms
  });
});

describe('email jobs', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let sent: MailMessage[];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedSchools(prisma);
    sent = [];
    jest.restoreAllMocks();
    jest.spyOn(app.get(MailTransport), 'deliver').mockImplementation(async (m: MailMessage) => {
      sent.push(m);
      return { messageId: `m${sent.length}` };
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it('sends announcements as one job per parent, replying to the school office', async () => {
    const m = client(app, HOSTS.oakwood, await signIn(app, HOSTS.oakwood, 'maya@example.test'));
    await m.patch('/school').send({ contactEmail: 'office@oakwood.test' }).expect(200);
    const student = (await prisma.student.findFirstOrThrow({ where: { school: { slug: 'oakwood' } } })).id;
    await m.post(`/students/${student}/guardians`).send({ guardian: { fullName: 'Akua', email: 'akua@example.test' }, relationship: 'MOTHER' }).expect(201);
    await m.post(`/students/${student}/guardians`).send({ guardian: { fullName: 'Kwame', email: 'kwame@example.test' }, relationship: 'FATHER' }).expect(201);
    const ann = (await m.post('/announcements').send({ title: 'Sports day', body: 'Friday.', audience: 'PARENTS', notify: true }).expect(201)).body.data.id;
    await m.post(`/announcements/${ann}/publish`).send({}).expect(200);

    await drainOutbox(app);
    expect(await prisma.outboxEvent.count({ where: { type: 'email.send' } })).toBe(2);
    expect(sent.map((s) => s.to).sort()).toEqual(['akua@example.test', 'kwame@example.test']);
    expect(sent.every((s) => s.replyTo === 'office@oakwood.test' && s.idempotencyKey?.startsWith(`announcement.email:${ann}:`))).toBe(true);
  });

  it('gives up straight away when the provider rejects the email', async () => {
    jest.spyOn(app.get(MailTransport), 'deliver').mockRejectedValue(new PermanentMailError('Resend rejected the email (422) validation_error'));
    await prisma.outboxEvent.create({
      data: { type: 'email.send', dedupeKey: 'x', payload: { to: 'bad@', subject: 's', text: 't', replyTo: null, kind: 'announcement', idempotencyKey: 'x' } },
    });
    await drainOutbox(app);
    const e = await prisma.outboxEvent.findFirstOrThrow({ where: { dedupeKey: 'x' } });
    expect(e.attempts).toBe(1);
    expect(e.failedAt).not.toBeNull();
    expect(e.lastError).toContain('422');
  });
});
