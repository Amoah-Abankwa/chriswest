import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { ACTIVATION_TTL_MS, AuthTokensService } from '../src/auth/auth-tokens.service';
import { Clock } from '../src/common/clock';
import { Mailer } from '../src/mail/mailer';
import { OutboxProcessor } from '../src/outbox/outbox.processor';
import { PrismaService } from '../src/prisma/prisma.service';
import { HOSTS, PASSWORD, resetDatabase, seedSchools } from './fixtures';
import { client, createTestApp, signIn } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
let f: Awaited<ReturnType<typeof seedSchools>>;
type Client = ReturnType<typeof client>;

const TODAY = '2026-10-13';

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
  app.get(Clock).setForTests(new Date(`${TODAY}T10:00:00Z`));
});

beforeEach(async () => {
  await resetDatabase(prisma);
  f = await seedSchools(prisma);
});

afterAll(async () => {
  app.get(Clock).setForTests(null);
  await app.close();
});

const as = async (host: string, email: string) => client(app, host, await signIn(app, host, email));
const oakManager = () => as(HOSTS.oakwood, 'maya@example.test');

/** Activates whoever was just invited and signs them in. */
async function activate(email: string, host = HOSTS.oakwood) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const token = await app.get(AuthTokensService).issue(user.id, 'ACTIVATION', ACTIVATION_TTL_MS);
  await client(app, host).post('/auth/activate').send({ token, password: PASSWORD }).expect(204);
  return as(host, email);
}

const drainOutbox = async () => {
  await prisma.outboxEvent.updateMany({ where: { processedAt: null }, data: { availableAt: new Date(Date.now() - 1000) } });
  while ((await app.get(OutboxProcessor).runOnce()) > 0);
};

/**
 * Two classes (P1 A with Tom teaching Maths, P1 B). Akua is mother of Ama (P1 A) and Kojo (P1 B);
 * Yaw is in P1 A with no link to Akua.
 */
async function setUp(m: Client) {
  const year = (await m.post('/academic-years').send({ name: '2026/2027', startDate: '2026-09-01', endDate: '2027-07-31' }).expect(201)).body.data;
  await m.post(`/academic-years/${year.id}/terms`).send({ name: 'Term 1', startDate: '2026-09-01', endDate: '2026-12-18' }).expect(201);
  await m.post(`/academic-years/${year.id}/activate`).send({}).expect(200);
  const levels = (await m.post('/education-levels/standard').send({ stages: ['PRIMARY'] }).expect(200)).body.data;
  const a = (await m.post('/classes').send({ academicYearId: year.id, levelId: levels[0].id, name: 'P1 A' }).expect(201)).body.data;
  const b = (await m.post('/classes').send({ academicYearId: year.id, levelId: levels[0].id, name: 'P1 B' }).expect(201)).body.data;
  const subjects = (await m.post('/subjects/common').expect(200)).body.data as { id: string; code: string }[];
  const math = subjects.find((s) => s.code === 'MATH')!.id;
  const eng = subjects.find((s) => s.code === 'ENG')!.id;
  await m.put(`/classes/${a.id}/subjects`).send({ subjects: [{ subjectId: math, teacherMembershipId: f.tom.membership.id }, { subjectId: eng }] }).expect(200);
  await m.put(`/classes/${b.id}/subjects`).send({ subjects: [{ subjectId: math, teacherMembershipId: f.tom.membership.id }] }).expect(200);
  const admit = async (firstName: string, classId: string) =>
    (await m.post('/students').send({ firstName, lastName: 'Test', admissionDate: '2026-09-01', classId }).expect(201)).body.data.id as string;
  const ama = await admit('Ama', a.id);
  const kojo = await admit('Kojo', b.id);
  const yaw = await admit('Yaw', a.id);

  const linked = await m.post(`/students/${ama}/guardians`).send({ guardian: { fullName: 'Akua Test', email: 'akua@example.test' }, relationship: 'MOTHER' }).expect(201);
  const guardianId = linked.body.data[0].guardianId;
  await m.post(`/students/${kojo}/guardians`).send({ guardianId, relationship: 'MOTHER' }).expect(201);
  await m.post(`/guardians/${guardianId}/invite`).expect(200);
  const parent = await activate('akua@example.test');
  return { year, a, b, math, eng, ama, kojo, yaw, parent, guardianId };
}

describe('parent portal', () => {
  it('shows each linked child with an overview, and nobody else', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    const children = (await s.parent.get('/portal/children').expect(200)).body.data;
    expect(children.map((c: { firstName: string; className: string }) => `${c.firstName}:${c.className}`)).toEqual(['Ama:P1 A', 'Kojo:P1 B']);

    const overview = (await s.parent.get(`/portal/children/${s.ama}/overview`).expect(200)).body.data;
    expect(overview).toMatchObject({ balance: { balanceMinor: 0 }, latestReportCard: null });
    await s.parent.get(`/portal/children/${s.yaw}/overview`).expect(404);
    await s.parent.get(`/portal/children/${s.yaw}`).expect(404);
    await s.parent.get(`/portal/children/${s.yaw}/timetable`).expect(404);
    expect((await s.parent.get('/portal/me').expect(200)).body.data).toBeNull();
  });
});

describe('student accounts', () => {
  it('lets a student see their own records only, with fees behind a school setting', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    expect((await m.post(`/students/${s.ama}/account`).send({ email: 'ama@student.test' }).expect(200)).body.data).toEqual({ account: 'INVITED', invitationQueued: true });
    const ama = await activate('ama@student.test');

    expect((await ama.get('/portal/me').expect(200)).body.data).toMatchObject({ studentId: s.ama, className: 'P1 A', canSeeFees: false });
    expect((await ama.get(`/portal/children/${s.ama}`).expect(200)).body.data).toMatchObject({ relationship: 'SELF', canSeeFees: false });
    await ama.get(`/portal/children/${s.ama}/attendance`).expect(200);
    await ama.get(`/portal/children/${s.ama}/report-cards`).expect(200);
    await ama.get(`/portal/children/${s.ama}/fees`).expect(404);
    expect((await ama.get(`/portal/children/${s.ama}/overview`).expect(200)).body.data.balance).toBeNull();

    await m.patch('/school').send({ studentPortalFees: true }).expect(200);
    await ama.get(`/portal/children/${s.ama}/fees`).expect(200);

    // Their classmate, their sibling's records and staff pages are out of reach.
    await ama.get(`/portal/children/${s.yaw}`).expect(404);
    await ama.get(`/portal/children/${s.kojo}/attendance`).expect(404);
    expect((await ama.get('/portal/children').expect(200)).body.data).toEqual([]);
    await ama.get('/students').expect(403);
    await ama.get(`/attendance/register?classId=${s.a.id}`).expect(403);
    await ama.get('/announcements').expect(403);
  });

  it('refuses emails that belong to staff or parents at the school, and can be revoked', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    expect((await m.post(`/students/${s.ama}/account`).send({ email: 'tom@example.test' }).expect(409)).body.error.code).toBe('EMAIL_IN_USE');
    expect((await m.post(`/students/${s.ama}/account`).send({ email: 'akua@example.test' }).expect(409)).body.error.code).toBe('EMAIL_IN_USE');

    await m.post(`/students/${s.ama}/account`).send({ email: 'ama@student.test' }).expect(200);
    const ama = await activate('ama@student.test');
    await m.post(`/students/${s.ama}/account/revoke`).expect(200);
    await ama.get('/auth/me').expect(401);
    expect((await m.get(`/students/${s.ama}`).expect(200)).body.data.account).toBeNull();
  });
});

describe('timetable', () => {
  it('builds class timetables, refuses teacher clashes, and shows the right week to each person', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    const periods = (
      await m
        .put('/timetable/periods')
        .send({
          periods: [
            { name: 'Period 1', startTime: '08:00', endTime: '08:40' },
            { name: 'Break', startTime: '08:40', endTime: '09:00', isBreak: true },
            { name: 'Period 2', startTime: '09:00', endTime: '09:40' },
          ],
        })
        .expect(200)
    ).body.data as { id: string; name: string }[];
    const p1 = periods.find((p) => p.name === 'Period 1')!.id;
    const brk = periods.find((p) => p.name === 'Break')!.id;
    const p2 = periods.find((p) => p.name === 'Period 2')!.id;

    await m.put(`/timetable/classes/${s.a.id}`).send({ entries: [{ dayOfWeek: 1, periodId: p1, subjectId: s.math }, { dayOfWeek: 1, periodId: p2, subjectId: s.eng }] }).expect(200);
    expect((await m.put(`/timetable/classes/${s.a.id}`).send({ entries: [{ dayOfWeek: 1, periodId: brk, subjectId: s.math }] }).expect(400)).body.error.code).toBe('BREAK_PERIOD');

    // Tom teaches Maths in both classes: same slot is a clash, a different slot is fine.
    const clash = await m.put(`/timetable/classes/${s.b.id}`).send({ entries: [{ dayOfWeek: 1, periodId: p1, subjectId: s.math }] }).expect(409);
    expect(clash.body.error).toMatchObject({ code: 'TEACHER_CLASH', details: { clashes: [expect.objectContaining({ otherClass: 'P1 A' })] } });
    await m.put(`/timetable/classes/${s.b.id}`).send({ entries: [{ dayOfWeek: 1, periodId: p2, subjectId: s.math }] }).expect(200);

    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    const mine = (await tom.get('/timetable/mine').expect(200)).body.data.entries;
    expect(mine.map((e: { className: string; dayOfWeek: number }) => `${e.className}:${e.dayOfWeek}`).sort()).toEqual(['P1 A:1', 'P1 B:1']);

    const amaWeek = (await s.parent.get(`/portal/children/${s.ama}/timetable`).expect(200)).body.data;
    expect(amaWeek.entries.map((e: { subjectName: string }) => e.subjectName).sort()).toEqual(['English Language', 'Mathematics']);
    await tom.put(`/timetable/classes/${s.a.id}`).send({ entries: [] }).expect(403);
  });
});

describe('announcements', () => {
  it('reaches the right people: audience, class targeting, scheduling and expiry', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    const create = async (body: Record<string, unknown>) => (await m.post('/announcements').send(body).expect(201)).body.data.id as string;
    const publish = (id: string, publishAt?: string) => m.post(`/announcements/${id}/publish`).send(publishAt ? { publishAt } : {}).expect(200);

    const all = await create({ title: 'Mid-term break', body: 'School closes on Friday.', audience: 'EVERYONE' });
    const staffOnly = await create({ title: 'Staff meeting', body: 'Monday 3pm.', audience: 'STAFF' });
    const classB = await create({ title: 'P1 B trip', body: 'Bring a packed lunch.', audience: 'PARENTS', classIds: [s.b.id] });
    const otherClass = await create({ title: 'P1 A only', body: 'Spelling test.', audience: 'PARENTS', classIds: [s.a.id] });
    const later = await create({ title: 'Next week', body: 'Not yet.', audience: 'EVERYONE' });
    const draft = await create({ title: 'Draft', body: 'Unpublished.', audience: 'EVERYONE' });
    for (const id of [all, staffOnly, classB, otherClass]) await publish(id);
    await publish(later, '2026-10-20T08:00:00Z');
    void draft;

    const titles = async (c: Client) => (await c.get('/announcements/feed').expect(200)).body.data.map((x: { title: string }) => x.title).sort();
    // Akua has children in both P1 A and P1 B.
    expect(await titles(s.parent)).toEqual(['Mid-term break', 'P1 A only', 'P1 B trip']);
    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    expect(await titles(tom)).toEqual(['Mid-term break', 'Staff meeting']);

    // Unlinking Kojo removes the P1 B notice from her feed.
    await m.delete(`/students/${s.kojo}/guardians/${s.guardianId}`).expect(200);
    expect(await titles(s.parent)).toEqual(['Mid-term break', 'P1 A only']);

    await m.post(`/announcements/${all}/withdraw`).expect(200);
    expect(await titles(tom)).toEqual(['Staff meeting']);
    await tom.post('/announcements').send({ title: 'Hi all', body: 'x', audience: 'EVERYONE' }).expect(403);
    await m.delete(`/announcements/${staffOnly}`).expect(409);
  });
});

describe('notifications', () => {
  it('delivers in-app notices for announcements and payments, readable only by their owner', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    const send = jest.spyOn(app.get(Mailer), 'send');
    send.mockClear();

    const ann = (await m.post('/announcements').send({ title: 'Sports day', body: 'Wear house colours.', audience: 'PARENTS', notify: true }).expect(201)).body.data.id;
    await m.post(`/announcements/${ann}/publish`).send({}).expect(200);

    // A payment for Ama queues a confirmation too.
    const cat = (await m.post('/fee-categories').send({ name: 'Tuition' }).expect(201)).body.data[0].id;
    const term = (await m.get('/academic-years').expect(200)).body.data[0].terms[0].id;
    await m.post('/invoices').send({ studentId: s.ama, termId: term, items: [{ categoryId: cat, amountMinor: 10000 }] }).expect(201);
    await m.post('/payments').set('Idempotency-Key', randomUUID()).send({ studentId: s.ama, amountMinor: 4000, method: 'CASH', receivedOn: TODAY }).expect(201);

    await drainOutbox();
    const list = (await s.parent.get('/notifications').expect(200)).body;
    expect(list.data.map((n: { kind: string }) => n.kind).sort()).toEqual(['announcement', 'payment.recorded']);
    expect(list.meta.unread).toBe(2);
    expect(list.data.find((n: { kind: string }) => n.kind === 'payment.recorded').body).toContain('received for Ama');
    expect(send.mock.calls.map(([msg]) => msg.to)).toEqual(expect.arrayContaining(['akua@example.test']));

    const first = list.data[0].id;
    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    await tom.post(`/notifications/${first}/read`).expect(404);
    expect((await s.parent.post(`/notifications/${first}/read`).expect(200)).body.data.unread).toBe(1);
    expect((await s.parent.post('/notifications/read-all').expect(200)).body.data.unread).toBe(0);
    expect((await tom.get('/notifications').expect(200)).body.data).toEqual([]);
  });

  it('a reversed payment never sends a confirmation', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    const cat = (await m.post('/fee-categories').send({ name: 'Tuition' }).expect(201)).body.data[0].id;
    const term = (await m.get('/academic-years').expect(200)).body.data[0].terms[0].id;
    await m.post('/invoices').send({ studentId: s.ama, termId: term, items: [{ categoryId: cat, amountMinor: 10000 }] }).expect(201);
    const p = (await m.post('/payments').set('Idempotency-Key', randomUUID()).send({ studentId: s.ama, amountMinor: 4000, method: 'CASH', receivedOn: TODAY }).expect(201)).body.data;
    await m.post(`/payments/${p.id}/reversals`).send({ reason: 'Typo' }).expect(200);
    await drainOutbox();
    expect((await s.parent.get('/notifications').expect(200)).body.data).toEqual([]);
  });
});

describe('isolation', () => {
  it("another school sees none of this school's portal content", async () => {
    const m = await oakManager();
    const s = await setUp(m);
    const ann = (await m.post('/announcements').send({ title: 'Oak only', body: 'x', audience: 'EVERYONE' }).expect(201)).body.data.id;
    await m.post(`/announcements/${ann}/publish`).send({}).expect(200);
    const maple = await as(HOSTS.maple, 'mo@example.test');
    expect((await maple.get('/announcements/feed').expect(200)).body.data).toEqual([]);
    await maple.post(`/announcements/${ann}/withdraw`).expect(404);
    await maple.get(`/timetable/classes/${s.a.id}`).expect(404);
    await maple.put(`/timetable/classes/${s.a.id}`).send({ entries: [] }).expect(404);
    await maple.get(`/portal/children/${s.ama}`).expect(404);
    await maple.post(`/students/${s.ama}/account`).send({ email: 'x@y.test' }).expect(404);
    // The Oakwood parent's session doesn't work at Maple at all.
    await client(app, HOSTS.maple).post('/auth/login').send({ email: 'akua@example.test', password: PASSWORD }).expect(401);
  });
});
