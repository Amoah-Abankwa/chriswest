import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { Clock } from '../src/common/clock';
import { PrismaService } from '../src/prisma/prisma.service';
import { toCsv } from '../src/reports/csv';
import { HOSTS, resetDatabase, seedSchools } from './fixtures';
import { client, createTestApp, signIn } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
let f: Awaited<ReturnType<typeof seedSchools>>;
type Client = ReturnType<typeof client>;

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
  app.get(Clock).setForTests(new Date('2026-10-13T10:00:00Z'));
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

/** One class with three students, five registers, one published subject, and fees part-paid. */
async function setUp(m: Client) {
  const year = (await m.post('/academic-years').send({ name: '2026/2027', startDate: '2026-09-01', endDate: '2027-07-31' }).expect(201)).body.data;
  const term = (await m.post(`/academic-years/${year.id}/terms`).send({ name: 'Term 1', startDate: '2026-09-01', endDate: '2026-12-18' }).expect(201)).body.data.terms[0];
  await m.post(`/academic-years/${year.id}/activate`).send({}).expect(200);
  const levels = (await m.post('/education-levels/standard').send({ stages: ['PRIMARY'] }).expect(200)).body.data;
  const cls = (await m.post('/classes').send({ academicYearId: year.id, levelId: levels[0].id, name: 'P1 A' }).expect(201)).body.data;
  const admit = async (firstName: string, sex: string) =>
    (await m.post('/students').send({ firstName, lastName: 'Test', sex, admissionDate: '2026-09-01', classId: cls.id, confirmDuplicate: true }).expect(201)).body.data.id as string;
  const ama = await admit('Ama', 'FEMALE');
  const kofi = await admit('Kofi', 'MALE');
  const evil = await admit('=HYPERLINK("http://x")', 'FEMALE');

  for (const date of ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13']) {
    const kofiAbsent = ['2026-10-07', '2026-10-08', '2026-10-09'].includes(date);
    await m.put('/attendance/register').send({ classId: cls.id, date, records: [{ studentId: ama, status: 'PRESENT' }, { studentId: kofi, status: kofiAbsent ? 'ABSENT' : 'PRESENT' }, { studentId: evil, status: 'LATE' }] }).expect(200);
  }

  const subjects = (await m.post('/subjects/common').expect(200)).body.data as { id: string; code: string }[];
  const math = subjects.find((s) => s.code === 'MATH')!.id;
  await m.put(`/classes/${cls.id}/subjects`).send({ subjects: [{ subjectId: math }] }).expect(200);
  const exam = (await m.put('/assessments').send({ termId: term.id, components: [{ name: 'Exam', maxMarks: 100, weight: 100 }] }).expect(200)).body.data.components[0].id;
  const key = { termId: term.id, classId: cls.id, subjectId: math };
  await m.put('/results/sheet/marks').send({ ...key, marks: [{ studentId: ama, assessmentId: exam, score: 90 }, { studentId: kofi, assessmentId: exam, score: 60 }, { studentId: evil, assessmentId: exam, score: 75 }] }).expect(200);
  await m.post('/results/sheet/submit').send(key).expect(200);
  await m.post('/results/sheet/approve').send(key).expect(200);
  await m.post('/results/publish').send({ termId: term.id, classId: cls.id }).expect(200);

  const cat = (await m.post('/fee-categories').send({ name: 'Tuition' }).expect(201)).body.data[0].id;
  for (const id of [ama, kofi]) await m.post('/invoices').send({ studentId: id, termId: term.id, items: [{ categoryId: cat, amountMinor: 100000 }] }).expect(201);
  await m.post('/payments').set('Idempotency-Key', randomUUID()).send({ studentId: ama, amountMinor: 100000, method: 'CASH', receivedOn: '2026-10-05' }).expect(201);
  await m.post('/payments').set('Idempotency-Key', randomUUID()).send({ studentId: kofi, amountMinor: 25000, method: 'CASH', receivedOn: '2026-10-13' }).expect(201);
  return { term, cls, ama, kofi, evil };
}

describe('reports', () => {
  it('produces the dashboard, enrollment, attendance, academic and finance figures', async () => {
    const m = await as(HOSTS.oakwood, 'maya@example.test');
    const s = await setUp(m);

    const overview = (await m.get('/reports/overview').expect(200)).body.data;
    expect(overview.students).toEqual({ total: 4, female: 2, male: 1 }); // plus the seeded student with no sex recorded
    expect(overview.attendanceLast30Days).toBe(80); // 12 of 15 present or late
    expect(overview.fees).toMatchObject({ billedMinor: 200000, collectedMinor: 125000, collectionRate: 62.5 });

    const enrollment = (await m.get('/reports/enrollment').expect(200)).body.data;
    expect(enrollment.byClass).toEqual([{ level: 'Primary 1', class: 'P1 A', female: 2, male: 1, unrecorded: 0, total: 3 }]);
    expect(enrollment.byMonth.find((x: { month: string }) => x.month === '2026-09')).toMatchObject({ admitted: 3 });

    const att = (await m.get('/reports/attendance?from=2026-10-01&to=2026-10-13').expect(200)).body.data;
    expect(att.daily).toHaveLength(5);
    expect(att.daily[0]).toMatchObject({ date: '2026-10-07', rate: 66.7 });
    expect(att.belowThreshold).toEqual([expect.objectContaining({ studentId: s.kofi, rate: 40, absent: 3 })]);

    const academic = (await m.get(`/reports/academic?termId=${s.term.id}`).expect(200)).body.data;
    expect(academic.bySubject).toEqual([{ class: 'P1 A', subject: 'Mathematics', average: 75, students: 3 }]);
    expect(academic.top[0]).toMatchObject({ name: 'Ama Test', average: 90 });

    const finance = (await m.get(`/reports/finance?termId=${s.term.id}`).expect(200)).body.data;
    expect(finance.weekly.reduce((n: number, w: { collectedMinor: number }) => n + w.collectedMinor, 0)).toBe(125000);
    expect(finance.byClass).toEqual([expect.objectContaining({ class: 'P1 A', billedMinor: 200000, outstandingMinor: 75000 })]);
  });

  it('exports CSV that spreadsheets can’t turn into formulas', async () => {
    expect(toCsv(['a'], [['=1+1'], ['plain'], ['say "hi"']])).toBe('\uFEFF"a"\r\n"\'=1+1"\r\n"plain"\r\n"say ""hi"""\r\n');
    const m = await as(HOSTS.oakwood, 'maya@example.test');
    const s = await setUp(m);
    const res = await m.get('/reports/csv/students').expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(res.text).not.toMatch(/(^|,)"=HYPERLINK/m);
    const results = await m.get(`/reports/csv/results?termId=${s.term.id}`).expect(200);
    expect(results.text.split('\r\n').filter(Boolean)).toHaveLength(4);
    expect(await prisma.auditLog.count({ where: { action: 'report.export' } })).toBe(2);
  });
});

describe('who sees which report', () => {
  it('needs school-wide access to the area, not just the reports permission', async () => {
    const m = await as(HOSTS.oakwood, 'maya@example.test');
    const s = await setUp(m);
    const accountant = (await prisma.role.findFirstOrThrow({ where: { schoolId: f.oakwood.id, key: 'accountant' } })).id;
    await m.put(`/staff/${f.carol.membership.id}/roles`).send({ roleIds: [accountant] }).expect(200);
    const carol = await as(HOSTS.oakwood, 'carol@example.test');
    await carol.get(`/reports/finance?termId=${s.term.id}`).expect(200);
    await carol.get(`/reports/academic?termId=${s.term.id}`).expect(403);
    await carol.get('/reports/csv/results?termId=' + s.term.id).expect(403);
    const overview = (await carol.get('/reports/overview').expect(200)).body.data;
    expect(overview.fees).toBeDefined();
    expect(overview.attendanceLast30Days).toBeUndefined();

    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    await tom.get('/reports/attendance').expect(403);
  });

  it('another school’s reports contain none of this school’s data', async () => {
    const m = await as(HOSTS.oakwood, 'maya@example.test');
    const s = await setUp(m);
    const mo = await as(HOSTS.maple, 'mo@example.test');
    expect((await mo.get('/reports/enrollment').expect(200)).body.data.byClass).toEqual([]);
    expect((await mo.get('/reports/attendance').expect(200)).body.data.daily).toEqual([]);
    await mo.get(`/reports/academic?termId=${s.term.id}`).expect(404);
    const csv = (await mo.get('/reports/csv/students').expect(200)).text;
    expect(csv).not.toContain('Ama');
    expect(csv).toContain(f.mapleStudent.admissionNumber);

    const admin = client(app, HOSTS.admin, await signIn(app, HOSTS.admin, 'root@platform.test'));
    const metrics = (await admin.get('/platform/metrics').expect(200)).body.data;
    expect(metrics.activeStudents).toBe(5); // 4 at Oakwood, 1 at Maple
    await m.get('/platform/metrics').expect(404);
  });
});
