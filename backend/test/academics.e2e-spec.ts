import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../src/prisma/prisma.service';
import { HOSTS, resetDatabase, seedSchools } from './fixtures';
import { client, createTestApp, signIn } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
let f: Awaited<ReturnType<typeof seedSchools>>;

type Client = ReturnType<typeof client>;

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});

beforeEach(async () => {
  await resetDatabase(prisma);
  f = await seedSchools(prisma);
});

afterAll(async () => {
  await app.close();
});

const as = async (host: string, email: string) => client(app, host, await signIn(app, host, email));
const oakManager = () => as(HOSTS.oakwood, 'maya@example.test');
const mapleManager = () => as(HOSTS.maple, 'mo@example.test');

async function currentYear(m: Client, name = '2026/2027', start = '2026-09-01', end = '2027-07-31') {
  const year = (await m.post('/academic-years').send({ name, startDate: start, endDate: end }).expect(201)).body.data;
  await m.post(`/academic-years/${year.id}/terms`).send({ name: 'Term 1', startDate: start, endDate: '2026-12-18' }).expect(201);
  await m.post(`/academic-years/${year.id}/activate`).send({}).expect(200);
  return year as { id: string };
}

async function aClass(m: Client, yearId: string, name = 'Primary 1A') {
  const levels = (await m.post('/education-levels/standard').send({ stages: ['PRIMARY'] }).expect(200)).body.data;
  return (await m.post('/classes').send({ academicYearId: yearId, levelId: levels[0].id, name }).expect(201)).body.data as {
    id: string;
  };
}

describe('academic years and terms', () => {
  it('creates a year with terms and makes it current', async () => {
    const m = await oakManager();
    const year = await currentYear(m);
    const res = await m.get(`/academic-years/${year.id}`).expect(200);
    expect(res.body.data).toMatchObject({ status: 'ACTIVE', startDate: '2026-09-01', terms: [{ name: 'Term 1' }] });
  });

  it('rejects overlapping years and terms outside or overlapping their year', async () => {
    const m = await oakManager();
    const year = await currentYear(m);
    const overlap = await m.post('/academic-years').send({ name: 'Overlap', startDate: '2027-01-01', endDate: '2027-12-31' }).expect(409);
    expect(overlap.body.error.code).toBe('DATES_OVERLAP');
    const outside = await m
      .post(`/academic-years/${year.id}/terms`)
      .send({ name: 'Late', startDate: '2027-07-01', endDate: '2027-08-31' })
      .expect(400);
    expect(outside.body.error.code).toBe('TERM_OUTSIDE_YEAR');
    await m.post(`/academic-years/${year.id}/terms`).send({ name: 'Clash', startDate: '2026-12-01', endDate: '2027-01-31' }).expect(409);
    await m.post('/academic-years').send({ name: 'Backwards', startDate: '2028-07-01', endDate: '2027-09-01' }).expect(400);
  });

  it('only switches the current year when asked to close the old one', async () => {
    const m = await oakManager();
    const first = await currentYear(m);
    const next = (await m.post('/academic-years').send({ name: '2027/2028', startDate: '2027-09-01', endDate: '2028-07-31' }).expect(201)).body.data;

    const noTerms = await m.post(`/academic-years/${next.id}/activate`).send({}).expect(409);
    expect(noTerms.body.error.code).toBe('NO_TERMS');
    await m.post(`/academic-years/${next.id}/terms`).send({ name: 'Term 1', startDate: '2027-09-01', endDate: '2027-12-17' }).expect(201);

    const blocked = await m.post(`/academic-years/${next.id}/activate`).send({}).expect(409);
    expect(blocked.body.error.code).toBe('ACTIVE_YEAR_EXISTS');

    await m.post(`/academic-years/${next.id}/activate`).send({ closeCurrent: true }).expect(200);
    const old = await m.get(`/academic-years/${first.id}`).expect(200);
    expect(old.body.data.status).toBe('CLOSED');
  });

  it('keeps closed years read-only', async () => {
    const m = await oakManager();
    const year = await currentYear(m);
    const cls = await aClass(m, year.id);
    await m.post(`/academic-years/${year.id}/close`).expect(200);

    const term = await m.post(`/academic-years/${year.id}/terms`).send({ name: 'Term 2', startDate: '2027-01-05', endDate: '2027-04-01' }).expect(409);
    expect(term.body.error.code).toBe('YEAR_CLOSED');
    await m.patch(`/classes/${cls.id}`).send({ name: 'Renamed' }).expect(409);
    await m.post(`/academic-years/${year.id}/activate`).send({ closeCurrent: true }).expect(409);
  });
});

describe('levels and subjects', () => {
  it('adds standard levels idempotently and in order', async () => {
    const m = await oakManager();
    await m.post('/education-levels/standard').send({ stages: ['JHS', 'CRECHE'] }).expect(200);
    const again = await m.post('/education-levels/standard').send({ stages: ['JHS', 'CRECHE'] }).expect(200);
    expect(again.body.data.map((l: { name: string }) => l.name)).toEqual(['Crèche', 'JHS 1', 'JHS 2', 'JHS 3']);
  });

  it('adds common subjects once and rejects duplicate codes', async () => {
    const m = await oakManager();
    const first = await m.post('/subjects/common').expect(200);
    const again = await m.post('/subjects/common').expect(200);
    expect(again.body.data).toHaveLength(first.body.data.length);
    const dup = await m.post('/subjects').send({ name: 'Maths again', code: 'math' }).expect(409);
    expect(dup.body.error.code).toBe('DUPLICATE_SUBJECT');
  });
});

describe('classes and teacher assignments', () => {
  it('assigns a class teacher and subject teachers from the same school', async () => {
    const m = await oakManager();
    const year = await currentYear(m);
    const cls = await aClass(m, year.id);
    const subjects = (await m.post('/subjects/common').expect(200)).body.data as { id: string; code: string }[];
    const math = subjects.find((s) => s.code === 'MATH')!;
    const eng = subjects.find((s) => s.code === 'ENG')!;

    const withTeacher = await m.put(`/classes/${cls.id}/class-teacher`).send({ membershipId: f.tom.membership.id }).expect(200);
    expect(withTeacher.body.data.classTeacher.email).toBe('tom@example.test');

    const res = await m
      .put(`/classes/${cls.id}/subjects`)
      .send({ subjects: [{ subjectId: math.id, teacherMembershipId: f.tom.membership.id }, { subjectId: eng.id }] })
      .expect(200);
    expect(res.body.data.subjects).toEqual([
      expect.objectContaining({ code: 'ENG', teacher: null }),
      expect.objectContaining({ code: 'MATH', teacher: expect.objectContaining({ email: 'tom@example.test' }) }),
    ]);

    // Replacing the list removes subjects (and their teachers) that are no longer listed.
    const trimmed = await m.put(`/classes/${cls.id}/subjects`).send({ subjects: [{ subjectId: eng.id }] }).expect(200);
    expect(trimmed.body.data.subjects).toHaveLength(1);
    expect(await prisma.subjectTeacher.count({ where: { classId: cls.id } })).toBe(0);
  });

  it('rejects duplicate class names within a year', async () => {
    const m = await oakManager();
    const year = await currentYear(m);
    const cls = await aClass(m, year.id);
    const level = (await prisma.schoolClass.findUniqueOrThrow({ where: { id: cls.id } })).levelId;
    const dup = await m.post('/classes').send({ academicYearId: year.id, levelId: level, name: 'Primary 1A' }).expect(409);
    expect(dup.body.error.code).toBe('NAME_TAKEN');
  });

  it('lets teachers read classes but not change them', async () => {
    const m = await oakManager();
    const year = await currentYear(m);
    const cls = await aClass(m, year.id);
    const teacher = await as(HOSTS.oakwood, 'tom@example.test');
    await teacher.get('/classes').expect(200);
    await teacher.patch(`/classes/${cls.id}`).send({ name: 'Mine now' }).expect(403);
    await teacher.post('/academic-years').send({ name: 'x', startDate: '2030-01-01', endDate: '2030-12-31' }).expect(403);
  });
});

describe('tenant isolation in academic data', () => {
  it("never shows or changes another school's academic records", async () => {
    const oak = await oakManager();
    const year = await currentYear(oak);
    const cls = await aClass(oak, year.id);
    const oakSubjects = (await oak.post('/subjects/common').expect(200)).body.data as { id: string }[];

    const maple = await mapleManager();
    expect((await maple.get('/academic-years').expect(200)).body.data).toEqual([]);
    expect((await maple.get('/subjects').expect(200)).body.data).toEqual([]);
    await maple.get(`/academic-years/${year.id}`).expect(404);
    await maple.get(`/classes/${cls.id}`).expect(404);
    await maple.patch(`/classes/${cls.id}`).send({ name: 'Taken over' }).expect(404);
    await maple.delete(`/classes/${cls.id}`).expect(404);
    await maple.post(`/academic-years/${year.id}/close`).expect(404);
    await maple.get(`/classes?academicYearId=${year.id}`).expect(404);

    // Maple can't pull Oakwood's subjects or staff into its own class.
    const mapleYear = await currentYear(maple);
    const mapleClass = await aClass(maple, mapleYear.id, 'Primary 1M');
    await maple.put(`/classes/${mapleClass.id}/subjects`).send({ subjects: [{ subjectId: oakSubjects[0]!.id }] }).expect(404);
    await maple.put(`/classes/${mapleClass.id}/class-teacher`).send({ membershipId: f.tom.membership.id }).expect(404);

    // And Oakwood can't assign Maple's staff.
    await oak.put(`/classes/${cls.id}/class-teacher`).send({ membershipId: f.mo.membership.id }).expect(404);

    expect((await prisma.schoolClass.findUniqueOrThrow({ where: { id: cls.id } })).name).toBe('Primary 1A');
  });

  it('the database refuses cross-school class links', async () => {
    const oak = await oakManager();
    const year = await currentYear(oak);
    const cls = await aClass(oak, year.id);
    const mapleSubject = await prisma.subject.create({ data: { schoolId: f.maple.id, name: 'Maple Maths', code: 'MM' } });
    await expect(
      prisma.classSubject.create({ data: { schoolId: f.oakwood.id, classId: cls.id, subjectId: mapleSubject.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.classTeacher.create({ data: { schoolId: f.oakwood.id, classId: cls.id, membershipId: f.mo.membership.id } }),
    ).rejects.toThrow();
  });
});

describe('school profile and setup', () => {
  it('reports missing steps and completes once everything is in place', async () => {
    const m = await oakManager();
    const early = await m.post('/school/setup/complete').expect(409);
    expect(early.body.error.code).toBe('SETUP_INCOMPLETE');
    expect(early.body.error.details.missing).toEqual(['profile', 'academicYear', 'terms', 'levels', 'subjects', 'classes']);

    await m.patch('/school').send({ phone: '+233 30 000 0000', addressLine: '12 Ring Road', city: 'Accra' }).expect(200);
    const year = await currentYear(m);
    await aClass(m, year.id);
    await m.post('/subjects/common').expect(200);

    const done = await m.post('/school/setup/complete').expect(200);
    expect(done.body.data.completedAt).not.toBeNull();
    expect(done.body.data.steps.every((s: { done: boolean }) => s.done)).toBe(true);
  });

  it('renames the school everywhere it is shown', async () => {
    const m = await oakManager();
    await m.patch('/school').send({ name: 'Oakwood International' }).expect(200);
    const host = await client(app, HOSTS.oakwood).get('/tenant/current').expect(200);
    expect(host.body.data.name).toBe('Oakwood International');
  });

  it('ignores attempts to change protected fields through the profile', async () => {
    const m = await oakManager();
    await m.patch('/school').send({ slug: 'hijack', status: 'ARCHIVED' }).expect(200);
    const school = await prisma.school.findUniqueOrThrow({ where: { id: f.oakwood.id } });
    expect(school).toMatchObject({ slug: 'oakwood', status: 'ACTIVE' });
  });
});
