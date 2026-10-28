import type { NestExpressApplication } from '@nestjs/platform-express';
import { ACTIVATION_TTL_MS, AuthTokensService } from '../src/auth/auth-tokens.service';
import { Clock } from '../src/common/clock';
import { Mailer } from '../src/mail/mailer';
import { OutboxProcessor } from '../src/outbox/outbox.processor';
import { PrismaService } from '../src/prisma/prisma.service';
import { HOSTS, PASSWORD, resetDatabase, seedSchools } from './fixtures';
import { client, createTestApp, signIn } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
let clock: Clock;
let f: Awaited<ReturnType<typeof seedSchools>>;
type Client = ReturnType<typeof client>;

const TODAY = '2026-10-13';
const setToday = (date: string) => clock.setForTests(new Date(`${date}T10:00:00Z`)); // Africa/Accra is UTC

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
  clock = app.get(Clock);
});

beforeEach(async () => {
  await resetDatabase(prisma);
  f = await seedSchools(prisma);
  setToday(TODAY);
});

afterAll(async () => {
  clock.setForTests(null);
  await app.close();
});

const as = async (host: string, email: string) => client(app, host, await signIn(app, host, email));
const oakManager = () => as(HOSTS.oakwood, 'maya@example.test');

/** A current year with two terms, class A (Tom is class teacher, three students) and class B (one student). */
async function setUp(m: Client) {
  const year = (await m.post('/academic-years').send({ name: '2026/2027', startDate: '2026-09-01', endDate: '2027-07-31' }).expect(201)).body.data;
  await m.post(`/academic-years/${year.id}/terms`).send({ name: 'Term 1', startDate: '2026-09-01', endDate: '2026-12-18' }).expect(201);
  await m.post(`/academic-years/${year.id}/terms`).send({ name: 'Term 2', startDate: '2027-01-05', endDate: '2027-04-01' }).expect(201);
  await m.post(`/academic-years/${year.id}/activate`).send({}).expect(200);
  const levels = (await m.post('/education-levels/standard').send({ stages: ['PRIMARY'] }).expect(200)).body.data;
  const a = (await m.post('/classes').send({ academicYearId: year.id, levelId: levels[0].id, name: 'P1 A' }).expect(201)).body.data;
  const b = (await m.post('/classes').send({ academicYearId: year.id, levelId: levels[0].id, name: 'P1 B' }).expect(201)).body.data;
  await m.put(`/classes/${a.id}/class-teacher`).send({ membershipId: f.tom.membership.id }).expect(200);

  const admit = async (firstName: string, classId: string) =>
    (await m.post('/students').send({ firstName, lastName: 'Test', admissionDate: '2026-09-01', classId }).expect(201)).body.data.id as string;
  const s1 = await admit('Ama', a.id);
  const s2 = await admit('Kofi', a.id);
  const s3 = await admit('Efua', a.id);
  const sb = await admit('Yaw', b.id);
  return { year, a, b, s1, s2, s3, sb };
}

const mark = (c: Client, classId: string, date: string, records: { studentId: string; status: string }[], reason?: string) =>
  c.put('/attendance/register').send({ classId, date, records, ...(reason ? { reason } : {}) });

describe('taking a register', () => {
  it('lets the class teacher take today’s register without duplicates', async () => {
    const m = await oakManager();
    const { a, s1, s2, s3 } = await setUp(m);
    const tom = await as(HOSTS.oakwood, 'tom@example.test');

    const before = (await tom.get(`/attendance/register?classId=${a.id}`).expect(200)).body.data;
    expect(before).toMatchObject({ date: TODAY, mode: 'RECORD', session: null, term: { name: 'Term 1' } });
    expect(before.students.map((s: { firstName: string }) => s.firstName)).toEqual(['Ama', 'Efua', 'Kofi']);

    const records = [
      { studentId: s1, status: 'ABSENT' },
      { studentId: s2, status: 'LATE' },
      { studentId: s3, status: 'PRESENT' },
    ];
    await mark(tom, a.id, TODAY, records).expect(200);
    // Saving again (e.g. a double tap) changes nothing and creates nothing new.
    const again = (await mark(tom, a.id, TODAY, records).expect(200)).body.data;
    expect(again.students.map((s: { status: string }) => s.status)).toEqual(['ABSENT', 'PRESENT', 'LATE']);
    expect(await prisma.attendanceRecord.count()).toBe(3);
    expect(await prisma.attendanceSession.count()).toBe(1);

    // Same-day changes are free and aren't corrections.
    await mark(tom, a.id, TODAY, [{ studentId: s1, status: 'PRESENT' }]).expect(200);
    expect(await prisma.attendanceCorrection.count()).toBe(0);

    const list = (await tom.get('/attendance/classes').expect(200)).body.data;
    expect(list).toEqual([expect.objectContaining({ name: 'P1 A', students: 3, recorded: 3, canRecord: true })]);
  });

  it('refuses classes the teacher doesn’t teach, future dates, holidays and students from elsewhere', async () => {
    const m = await oakManager();
    const { a, b, s1, sb } = await setUp(m);
    const tom = await as(HOSTS.oakwood, 'tom@example.test');

    await mark(tom, b.id, TODAY, [{ studentId: sb, status: 'PRESENT' }]).expect(404);
    await tom.get(`/attendance/register?classId=${b.id}`).expect(404);
    expect((await mark(tom, a.id, '2026-10-20', [{ studentId: s1, status: 'PRESENT' }]).expect(400)).body.error.code).toBe('FUTURE_DATE');
    expect((await mark(tom, a.id, '2026-12-25', [{ studentId: s1, status: 'PRESENT' }]).expect(409)).body.error.code).toBe('NOT_A_SCHOOL_DAY');
    expect((await mark(tom, a.id, TODAY, [{ studentId: sb, status: 'PRESENT' }]).expect(400)).body.error.code).toBe('NOT_IN_CLASS');
    expect(await prisma.attendanceRecord.count()).toBe(0);
  });

  it('counts a student who moved class that day in the new class only', async () => {
    const m = await oakManager();
    const { a, b, s3 } = await setUp(m);
    await m.post(`/students/${s3}/transfer`).send({ classId: b.id, reason: 'Stream change', date: TODAY }).expect(200);
    const inA = (await m.get(`/attendance/register?classId=${a.id}`).expect(200)).body.data.students.map((s: { studentId: string }) => s.studentId);
    const inB = (await m.get(`/attendance/register?classId=${b.id}`).expect(200)).body.data.students.map((s: { studentId: string }) => s.studentId);
    expect(inA).not.toContain(s3);
    expect(inB).toContain(s3);
    // Yesterday's register for A still includes them.
    const yesterday = (await m.get(`/attendance/register?classId=${a.id}&date=2026-10-12`).expect(200)).body.data.students;
    expect(yesterday.map((s: { studentId: string }) => s.studentId)).toContain(s3);
  });
});

describe('corrections', () => {
  it('needs a reason after the day, keeps a history, and closes after the window', async () => {
    const m = await oakManager();
    const { a, s1 } = await setUp(m);
    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    await mark(tom, a.id, TODAY, [{ studentId: s1, status: 'ABSENT' }]).expect(200);

    setToday('2026-10-14');
    const view = (await tom.get(`/attendance/register?classId=${a.id}&date=${TODAY}`).expect(200)).body.data;
    expect(view).toMatchObject({ mode: 'CORRECT', reasonRequired: true });
    expect((await mark(tom, a.id, TODAY, [{ studentId: s1, status: 'EXCUSED' }]).expect(400)).body.error.code).toBe('REASON_REQUIRED');

    const fixed = (await mark(tom, a.id, TODAY, [{ studentId: s1, status: 'EXCUSED' }], 'Parent sent a sick note').expect(200)).body.data;
    expect(fixed.corrections).toEqual([expect.objectContaining({ from: 'ABSENT', to: 'EXCUSED', reason: 'Parent sent a sick note' })]);

    setToday('2026-11-10'); // 28 days later; the default window is 14
    const late = await mark(tom, a.id, TODAY, [{ studentId: s1, status: 'PRESENT' }], 'Late fix').expect(409);
    expect(late.body.error.code).toBe('CORRECTION_WINDOW_CLOSED');
    expect((await tom.get(`/attendance/register?classId=${a.id}&date=${TODAY}`).expect(200)).body.data.mode).toBe('READ_ONLY');
  });

  it('allows a missed register to be filled in later without a reason', async () => {
    const m = await oakManager();
    const { a, s1 } = await setUp(m);
    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    const res = await mark(tom, a.id, '2026-10-12', [{ studentId: s1, status: 'PRESENT' }]).expect(200);
    expect(res.body.data.mode).toBe('CORRECT'); // once recorded, further changes are corrections
  });

  it('only people with correction permission can change a past register', async () => {
    const m = await oakManager();
    const { b, sb } = await setUp(m);
    const role = await m
      .post('/roles')
      .send({ name: 'Register taker', permissions: [{ key: 'attendance.read', scope: 'ASSIGNED' }, { key: 'attendance.record', scope: 'ASSIGNED' }] })
      .expect(201);
    await m.put(`/staff/${f.carol.membership.id}/roles`).send({ roleIds: [role.body.data.id] }).expect(200);
    await m.put(`/classes/${b.id}/class-teacher`).send({ membershipId: f.carol.membership.id }).expect(200);
    const carol = await as(HOSTS.oakwood, 'carol@example.test');

    await mark(carol, b.id, TODAY, [{ studentId: sb, status: 'ABSENT' }]).expect(200);
    setToday('2026-10-14');
    await mark(carol, b.id, TODAY, [{ studentId: sb, status: 'PRESENT' }], 'Mistake').expect(403);
    await mark(m, b.id, TODAY, [{ studentId: sb, status: 'PRESENT' }], 'Mistake').expect(200);
  });

  it('closed years are read-only', async () => {
    const m = await oakManager();
    const { year, a, s1 } = await setUp(m);
    await m.post(`/academic-years/${year.id}/close`).expect(200);
    expect((await m.get(`/attendance/register?classId=${a.id}`).expect(200)).body.data.mode).toBe('READ_ONLY');
    expect((await mark(m, a.id, TODAY, [{ studentId: s1, status: 'PRESENT' }]).expect(409)).body.error.code).toBe('YEAR_NOT_CURRENT');
  });
});

describe('summaries', () => {
  it('totals each student over a period', async () => {
    const m = await oakManager();
    const { a, s1, s2, s3 } = await setUp(m);
    await mark(m, a.id, '2026-10-12', [
      { studentId: s1, status: 'PRESENT' },
      { studentId: s2, status: 'PRESENT' },
      { studentId: s3, status: 'EXCUSED' },
    ]).expect(200);
    await mark(m, a.id, TODAY, [
      { studentId: s1, status: 'ABSENT' },
      { studentId: s2, status: 'LATE' },
      { studentId: s3, status: 'PRESENT' },
    ]).expect(200);

    const summary = (await m.get(`/attendance/summary?classId=${a.id}&from=2026-10-01&to=${TODAY}`).expect(200)).body.data;
    expect(summary.registers).toBe(2);
    const row = (name: string) => summary.students.find((s: { name: string }) => s.name.startsWith(name));
    expect(row('Ama')).toMatchObject({ present: 1, absent: 1, recorded: 2, rate: 50 });
    expect(row('Kofi')).toMatchObject({ present: 1, late: 1, rate: 100 });
    expect(row('Efua')).toMatchObject({ excused: 1, present: 1, rate: 50 });

    const student = (await m.get(`/students/${s1}/attendance?from=2026-10-01`).expect(200)).body.data;
    expect(student.totals).toMatchObject({ present: 1, absent: 1, recorded: 2 });
    expect(student.records[0]).toMatchObject({ date: TODAY, status: 'ABSENT', className: 'P1 A' });
  });

  it('teachers only see attendance for their own students', async () => {
    const m = await oakManager();
    const { s1, sb } = await setUp(m);
    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    await tom.get(`/students/${s1}/attendance`).expect(200);
    await tom.get(`/students/${sb}/attendance`).expect(404);
  });
});

describe('absence notifications', () => {
  async function withParentEmail(m: Client, studentId: string) {
    await m
      .post(`/students/${studentId}/guardians`)
      .send({ guardian: { fullName: 'Parent Test', email: 'parent@example.test' }, relationship: 'MOTHER' })
      .expect(201);
  }
  const makeDue = () => prisma.outboxEvent.updateMany({ data: { availableAt: new Date(Date.now() - 1000) } });

  it('emails parents after the delay, once, and not if corrected in time', async () => {
    const m = await oakManager();
    const { a, s1, s2 } = await setUp(m);
    await withParentEmail(m, s1);
    await withParentEmail(m, s2);
    const send = jest.spyOn(app.get(Mailer), 'send');
    send.mockClear();

    await mark(m, a.id, TODAY, [
      { studentId: s1, status: 'ABSENT' },
      { studentId: s2, status: 'ABSENT' },
    ]).expect(200);
    expect(await prisma.outboxEvent.count()).toBe(2);

    // Nothing is due yet: the delay gives the teacher time to fix mistakes.
    expect(await app.get(OutboxProcessor).runOnce()).toBe(0);

    // Kofi turns out to be present before the email goes out.
    await mark(m, a.id, TODAY, [{ studentId: s2, status: 'PRESENT' }]).expect(200);
    await makeDue();
    expect(await app.get(OutboxProcessor).runOnce()).toBe(2);

    const calls = send.mock.calls.filter(([msg]) => msg.subject.includes('absence'));
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({ to: 'parent@example.test' });
    expect(calls[0]![0].text).toContain('Ama was marked absent from P1 A');

    // Marking absent again the same day doesn't queue a second message.
    await mark(m, a.id, TODAY, [{ studentId: s1, status: 'PRESENT' }]).expect(200);
    await mark(m, a.id, TODAY, [{ studentId: s1, status: 'ABSENT' }]).expect(200);
    expect(await prisma.outboxEvent.count()).toBe(2);
    expect(await prisma.outboxEvent.count({ where: { processedAt: null } })).toBe(0);
  });

  it('respects the school’s setting and doesn’t notify for past days', async () => {
    const m = await oakManager();
    const { a, s1, s2 } = await setUp(m);
    await mark(m, a.id, '2026-10-12', [{ studentId: s1, status: 'ABSENT' }]).expect(200);
    expect(await prisma.outboxEvent.count()).toBe(0);
    await m.patch('/school').send({ notifyAbsence: false }).expect(200);
    await mark(m, a.id, TODAY, [{ studentId: s2, status: 'ABSENT' }]).expect(200);
    expect(await prisma.outboxEvent.count()).toBe(0);
  });
});

describe('parents and other schools', () => {
  it('parents see their own child’s attendance only', async () => {
    const m = await oakManager();
    const { a, s1, s2 } = await setUp(m);
    await mark(m, a.id, TODAY, [{ studentId: s1, status: 'LATE' }, { studentId: s2, status: 'ABSENT' }]).expect(200);
    const linked = await m
      .post(`/students/${s1}/guardians`)
      .send({ guardian: { fullName: 'Akua', email: 'akua@example.test' }, relationship: 'MOTHER' })
      .expect(201);
    await m.post(`/guardians/${linked.body.data[0].guardianId}/invite`).expect(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'akua@example.test' } });
    const token = await app.get(AuthTokensService).issue(user.id, 'ACTIVATION', ACTIVATION_TTL_MS);
    await client(app, HOSTS.oakwood).post('/auth/activate').send({ token, password: PASSWORD }).expect(204);
    const parent = await as(HOSTS.oakwood, 'akua@example.test');

    const mine = (await parent.get(`/portal/children/${s1}/attendance`).expect(200)).body.data;
    expect(mine.records).toEqual([expect.objectContaining({ date: TODAY, status: 'LATE' })]);
    await parent.get(`/portal/children/${s2}/attendance`).expect(404);
    await parent.get(`/attendance/register?classId=${a.id}`).expect(403);
  });

  it("another school can't read or write this school's registers", async () => {
    const m = await oakManager();
    const { a, s1 } = await setUp(m);
    await mark(m, a.id, TODAY, [{ studentId: s1, status: 'PRESENT' }]).expect(200);
    const maple = await as(HOSTS.maple, 'mo@example.test');
    await maple.get(`/attendance/register?classId=${a.id}`).expect(404);
    await mark(maple, a.id, TODAY, [{ studentId: s1, status: 'ABSENT' }]).expect(404);
    await maple.get(`/attendance/summary?classId=${a.id}`).expect(404);
    await maple.get(`/students/${s1}/attendance`).expect(404);
    expect((await maple.get('/attendance/classes').expect(200)).body.data).toEqual([]);
    expect((await prisma.attendanceRecord.findFirstOrThrow()).status).toBe('PRESENT');
  });
});
