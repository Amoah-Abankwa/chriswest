import type { NestExpressApplication } from '@nestjs/platform-express';
import { ACTIVATION_TTL_MS, AuthTokensService } from '../src/auth/auth-tokens.service';
import { Clock } from '../src/common/clock';
import { PrismaService } from '../src/prisma/prisma.service';
import { gradeFor, positions, totalPercent, DEFAULT_BANDS } from '../src/results/grading';
import { HOSTS, PASSWORD, resetDatabase, seedSchools } from './fixtures';
import { client, createTestApp, signIn } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
let f: Awaited<ReturnType<typeof seedSchools>>;
type Client = ReturnType<typeof client>;

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
  app.get(Clock).setForTests(new Date('2026-12-10T10:00:00Z'));
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

/**
 * Term 1 with Class work /30 (30%) and Exam /100 (70%). Class P1 A takes Maths (taught by Tom)
 * and English (no teacher assigned). Students: Ama and Kofi.
 */
async function setUp(m: Client) {
  const year = (await m.post('/academic-years').send({ name: '2026/2027', startDate: '2026-09-01', endDate: '2027-07-31' }).expect(201)).body.data;
  const term = (await m.post(`/academic-years/${year.id}/terms`).send({ name: 'Term 1', startDate: '2026-09-01', endDate: '2026-12-18' }).expect(201)).body.data.terms[0];
  await m.post(`/academic-years/${year.id}/activate`).send({}).expect(200);
  const levels = (await m.post('/education-levels/standard').send({ stages: ['PRIMARY'] }).expect(200)).body.data;
  const cls = (await m.post('/classes').send({ academicYearId: year.id, levelId: levels[0].id, name: 'P1 A' }).expect(201)).body.data;
  const subjects = (await m.post('/subjects/common').expect(200)).body.data as { id: string; code: string }[];
  const math = subjects.find((s) => s.code === 'MATH')!.id;
  const eng = subjects.find((s) => s.code === 'ENG')!.id;
  await m.put(`/classes/${cls.id}/subjects`).send({ subjects: [{ subjectId: math, teacherMembershipId: f.tom.membership.id }, { subjectId: eng }] }).expect(200);
  const admit = async (firstName: string) =>
    (await m.post('/students').send({ firstName, lastName: 'Test', admissionDate: '2026-09-01', classId: cls.id }).expect(201)).body.data.id as string;
  const ama = await admit('Ama');
  const kofi = await admit('Kofi');
  const scheme = (
    await m.put('/assessments').send({ termId: term.id, components: [{ name: 'Class work', maxMarks: 30, weight: 30 }, { name: 'Exam', maxMarks: 100, weight: 70 }] }).expect(200)
  ).body.data.components as { id: string; name: string }[];
  const [classwork, exam] = [scheme.find((c) => c.name === 'Class work')!.id, scheme.find((c) => c.name === 'Exam')!.id];
  const key = (subjectId: string) => ({ termId: term.id, classId: cls.id, subjectId });
  return { term, cls, math, eng, ama, kofi, classwork, exam, key };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

const enter = (c: Client, s: Setup, subjectId: string, rows: [string, number | null, number | null | 'absent'][]) =>
  c.put('/results/sheet/marks').send({
    ...s.key(subjectId),
    marks: rows.flatMap(([studentId, cw, ex]) => [
      { studentId, assessmentId: s.classwork, score: cw },
      ex === 'absent' ? { studentId, assessmentId: s.exam, absent: true } : { studentId, assessmentId: s.exam, score: ex },
    ]),
  });

/** Enters, submits and approves both subjects. */
async function readyToPublish(m: Client, s: Setup) {
  const tom = await as(HOSTS.oakwood, 'tom@example.test');
  await enter(tom, s, s.math, [[s.ama, 25, 80], [s.kofi, 15, 50]]).expect(200);
  await tom.post('/results/sheet/submit').send(s.key(s.math)).expect(200);
  await enter(m, s, s.eng, [[s.ama, 20, 60], [s.kofi, 30, 'absent']]).expect(200);
  await m.post('/results/sheet/submit').send(s.key(s.eng)).expect(200);
  await m.post('/results/sheet/approve').send(s.key(s.math)).expect(200);
  await m.post('/results/sheet/approve').send(s.key(s.eng)).expect(200);
  return tom;
}

describe('grading arithmetic', () => {
  it('weights, grades and ranks as documented', () => {
    const comps = [{ id: 'cw', name: 'CW', maxMarks: 30, weight: 30 }, { id: 'ex', name: 'Ex', maxMarks: 100, weight: 70 }];
    const marks = (cw: number, ex: number | 'absent') =>
      new Map([['cw', { score: cw, absent: false }], ['ex', ex === 'absent' ? { score: null, absent: true } : { score: ex, absent: false }]]);
    expect(totalPercent(comps, marks(25, 80))).toBe(81);
    expect(totalPercent(comps, marks(30, 'absent'))).toBe(30);
    expect(totalPercent(comps, new Map([['cw', { score: 10, absent: false }]]))).toBeNull();
    expect(gradeFor(DEFAULT_BANDS, 81).grade).toBe('A');
    expect(gradeFor(DEFAULT_BANDS, 79.9).grade).toBe('B');
    expect(gradeFor(DEFAULT_BANDS, 0).grade).toBe('F');
    const ranks = positions([{ id: 'a', total: 90 }, { id: 'b', total: 80 }, { id: 'c', total: 80 }, { id: 'd', total: 70 }]);
    expect([...ranks.values()]).toEqual([1, 2, 2, 4]);
  });
});

describe('assessment setup', () => {
  it('requires weights adding up to 100', async () => {
    const m = await oakManager();
    const { term } = await setUp(m);
    await m.put('/assessments').send({ termId: term.id, components: [{ name: 'Exam', maxMarks: 100, weight: 90 }] }).expect(400);
  });

  it('won’t lower a maximum below a mark already given', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    await enter(m, s, s.eng, [[s.ama, 28, 90]]).expect(200);
    const res = await m
      .put('/assessments')
      .send({ termId: s.term.id, components: [{ id: s.classwork, name: 'Class work', maxMarks: 20, weight: 30 }, { id: s.exam, name: 'Exam', maxMarks: 100, weight: 70 }] })
      .expect(409);
    expect(res.body.error.code).toBe('MARKS_ABOVE_MAX');
  });
});

describe('mark entry and the workflow', () => {
  it('lets only the subject teacher enter and submit, and checks scores', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    const tom = await as(HOSTS.oakwood, 'tom@example.test');

    await enter(tom, s, s.eng, [[s.ama, 10, 50]]).expect(403);
    expect((await enter(tom, s, s.math, [[s.ama, 31, 50]]).expect(400)).body.error.code).toBe('SCORE_TOO_HIGH');

    const sheet = (await enter(tom, s, s.math, [[s.ama, 25, 80]]).expect(200)).body.data;
    expect(sheet.status).toBe('DRAFT');
    expect(sheet.students.find((x: { studentId: string }) => x.studentId === s.ama)).toMatchObject({ totalPercent: 81, grade: 'A' });

    const incomplete = await tom.post('/results/sheet/submit').send(s.key(s.math)).expect(409);
    expect(incomplete.body.error).toMatchObject({ code: 'INCOMPLETE', details: { missing: 2 } });

    await enter(tom, s, s.math, [[s.kofi, 15, 50]]).expect(200);
    await tom.post('/results/sheet/submit').send(s.key(s.math)).expect(200);
    expect((await enter(tom, s, s.math, [[s.kofi, 16, 50]]).expect(409)).body.error.code).toBe('SHEET_LOCKED');
    await tom.post('/results/sheet/approve').send(s.key(s.math)).expect(403);
  });

  it('returns results for correction and lets them be resubmitted', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    await enter(tom, s, s.math, [[s.ama, 25, 80], [s.kofi, 15, 50]]).expect(200);
    await tom.post('/results/sheet/submit').send(s.key(s.math)).expect(200);

    const returned = (await m.post('/results/sheet/return').send({ ...s.key(s.math), reason: 'Kofi’s exam was marked out of 50' }).expect(200)).body.data;
    expect(returned).toMatchObject({ status: 'RETURNED', returnReason: 'Kofi’s exam was marked out of 50' });
    await enter(tom, s, s.math, [[s.kofi, 15, 95]]).expect(200);
    await tom.post('/results/sheet/submit').send(s.key(s.math)).expect(200);
    await m.post('/results/sheet/approve').send(s.key(s.math)).expect(200);
    await m.post('/results/sheet/approve').send(s.key(s.math)).expect(409);
  });

  it('publishes a class only when every subject is approved', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    await enter(tom, s, s.math, [[s.ama, 25, 80], [s.kofi, 15, 50]]).expect(200);
    await tom.post('/results/sheet/submit').send(s.key(s.math)).expect(200);
    await m.post('/results/sheet/approve').send(s.key(s.math)).expect(200);

    const notReady = await m.post('/results/publish').send({ termId: s.term.id, classId: s.cls.id }).expect(409);
    expect(notReady.body.error.details.notReady).toEqual([{ subject: 'English Language', status: 'NOT_STARTED' }]);
    await tom.post('/results/publish').send({ termId: s.term.id, classId: s.cls.id }).expect(403);
  });
});

describe('publishing, report cards and corrections', () => {
  it('freezes grades at publication and produces a report card', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    await readyToPublish(m, s);
    const published = (await m.post('/results/publish').send({ termId: s.term.id, classId: s.cls.id }).expect(200)).body.data[0];
    expect(published).toMatchObject({ published: true });

    // Changing the scale or the scheme afterwards doesn't touch published results.
    await m.put('/grading-scale').send({ bands: [{ minPercent: 90, grade: 'A', remark: 'Top' }, { minPercent: 0, grade: 'B', remark: 'Rest' }] }).expect(200);
    expect((await m.put('/assessments').send({ termId: s.term.id, components: [{ name: 'Exam', maxMarks: 100, weight: 100 }] }).expect(409)).body.error.code).toBe('TERM_PUBLISHED');

    const card = (await m.get(`/students/${s.ama}/report-cards/${s.term.id}`).expect(200)).body.data;
    expect(card).toMatchObject({ className: 'P1 A', classSize: 2, overallPosition: 1 });
    const maths = card.subjects.find((x: { subject: string }) => x.subject === 'Mathematics');
    expect(maths).toMatchObject({ totalPercent: 81, grade: 'A', remark: 'Excellent', position: 1, outOf: 2 });
    expect(maths.components).toEqual([
      expect.objectContaining({ name: 'Class work', score: 25, maxMarks: 30 }),
      expect.objectContaining({ name: 'Exam', score: 80, maxMarks: 100 }),
    ]);
    // English: Ama 20/30*30 + 60*0.7 = 62 (C). Average (81 + 62) / 2 = 71.5.
    expect(card.average).toBe(71.5);

    const kofi = (await m.get(`/students/${s.kofi}/report-cards/${s.term.id}`).expect(200)).body.data;
    const kofiEng = kofi.subjects.find((x: { subject: string }) => x.subject === 'English Language');
    expect(kofiEng).toMatchObject({ totalPercent: 30, grade: 'F' });
    expect(kofiEng.components[1]).toMatchObject({ absent: true, score: null });
  });

  it('corrects a published mark with a reason and recalculates grade and position', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    const tom = await readyToPublish(m, s);
    await m.post('/results/publish').send({ termId: s.term.id, classId: s.cls.id }).expect(200);

    await tom.post('/results/sheet/corrections').send({ ...s.key(s.math), studentId: s.kofi, assessmentId: s.exam, score: 100, reason: 'Page missed' }).expect(403);
    await m.post('/results/sheet/corrections').send({ ...s.key(s.math), studentId: s.kofi, assessmentId: s.exam, score: 100 }).expect(400);
    const sheet = (
      await m.post('/results/sheet/corrections').send({ ...s.key(s.math), studentId: s.kofi, assessmentId: s.exam, score: 100, reason: 'A page was missed when adding up' }).expect(201)
    ).body.data;
    expect(sheet.students.find((x: { studentId: string }) => x.studentId === s.kofi)).toMatchObject({ totalPercent: 85, grade: 'A', position: 1 });
    expect(sheet.students.find((x: { studentId: string }) => x.studentId === s.ama)).toMatchObject({ position: 2 });
    expect(sheet.corrections).toEqual([expect.objectContaining({ from: '50', to: '100', reason: 'A page was missed when adding up' })]);
    // Still graded with the scale frozen at publication, not the one in force now.
    expect(await prisma.resultCorrection.count()).toBe(1);
  });

  it('queues parent emails on publication', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    await readyToPublish(m, s);
    await m.post('/results/publish').send({ termId: s.term.id, classId: s.cls.id }).expect(200);
    expect(await prisma.outboxEvent.count({ where: { type: 'results.published' } })).toBe(2);
  });
});

describe('access', () => {
  it('parents see report cards only once published, and only for their own child', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    const linked = await m.post(`/students/${s.ama}/guardians`).send({ guardian: { fullName: 'Akua', email: 'akua@example.test' }, relationship: 'MOTHER' }).expect(201);
    await m.post(`/guardians/${linked.body.data[0].guardianId}/invite`).expect(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'akua@example.test' } });
    const token = await app.get(AuthTokensService).issue(user.id, 'ACTIVATION', ACTIVATION_TTL_MS);
    await client(app, HOSTS.oakwood).post('/auth/activate').send({ token, password: PASSWORD }).expect(204);
    const parent = await as(HOSTS.oakwood, 'akua@example.test');

    await readyToPublish(m, s);
    expect((await parent.get(`/portal/children/${s.ama}/report-cards`).expect(200)).body.data).toEqual([]);
    await parent.get(`/portal/children/${s.ama}/report-cards/${s.term.id}`).expect(404);

    await m.post('/results/publish').send({ termId: s.term.id, classId: s.cls.id }).expect(200);
    expect((await parent.get(`/portal/children/${s.ama}/report-cards`).expect(200)).body.data).toEqual([expect.objectContaining({ termName: 'Term 1' })]);
    await parent.get(`/portal/children/${s.ama}/report-cards/${s.term.id}`).expect(200);
    await parent.get(`/portal/children/${s.kofi}/report-cards/${s.term.id}`).expect(404);
    await parent.get(`/results/sheet?termId=${s.term.id}&classId=${s.cls.id}&subjectId=${s.math}`).expect(403);
  });

  it("another school can't read, enter, approve, publish or correct", async () => {
    const m = await oakManager();
    const s = await setUp(m);
    await readyToPublish(m, s);
    const maple = await as(HOSTS.maple, 'mo@example.test');
    await maple.get(`/results/sheet?termId=${s.term.id}&classId=${s.cls.id}&subjectId=${s.math}`).expect(404);
    await maple.get(`/results/sheets?termId=${s.term.id}`).expect(404);
    await enter(maple, s, s.math, [[s.ama, 1, 1]]).expect(404);
    await maple.post('/results/sheet/approve').send(s.key(s.math)).expect(404);
    await maple.post('/results/sheet/return').send({ ...s.key(s.math), reason: 'hijack' }).expect(404);
    await maple.post('/results/publish').send({ termId: s.term.id, classId: s.cls.id }).expect(404);
    await maple.put('/assessments').send({ termId: s.term.id, components: [{ name: 'X', maxMarks: 10, weight: 100 }] }).expect(404);
    await maple.get(`/students/${s.ama}/report-cards`).expect(404);
    expect(await prisma.resultSheet.count({ where: { status: 'APPROVED' } })).toBe(2);
  });

  it('the database refuses marks or sheets that cross schools', async () => {
    const m = await oakManager();
    const s = await setUp(m);
    await enter(m, s, s.math, [[s.ama, 10, 10]]).expect(200);
    const sheet = await prisma.resultSheet.findFirstOrThrow();
    await expect(
      prisma.mark.create({ data: { schoolId: f.oakwood.id, sheetId: sheet.id, assessmentId: s.exam, studentId: f.mapleStudent.id, score: 1, enteredByUserId: f.maya.user.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.resultSheet.create({ data: { schoolId: f.maple.id, termId: s.term.id, classId: s.cls.id, subjectId: s.math } }),
    ).rejects.toThrow();
  });
});
