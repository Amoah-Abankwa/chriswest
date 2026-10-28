import type { NestExpressApplication } from '@nestjs/platform-express';
import { AuthTokensService, ACTIVATION_TTL_MS } from '../src/auth/auth-tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { HOSTS, PASSWORD, resetDatabase, seedSchools } from './fixtures';
import { client, createTestApp, signIn } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
let tokens: AuthTokensService;
let f: Awaited<ReturnType<typeof seedSchools>>;
type Client = ReturnType<typeof client>;

beforeAll(async () => {
  app = await createTestApp();
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

/** Collects a binary response body into a Buffer. */
const binary = (res: NodeJS.ReadableStream, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

const as = async (host: string, email: string) => client(app, host, await signIn(app, host, email));
const oakManager = () => as(HOSTS.oakwood, 'maya@example.test');
const mapleManager = () => as(HOSTS.maple, 'mo@example.test');

async function setUpYear(m: Client, capacity?: number) {
  const year = (await m.post('/academic-years').send({ name: '2026/2027', startDate: '2026-09-01', endDate: '2027-07-31' }).expect(201)).body.data;
  await m.post(`/academic-years/${year.id}/terms`).send({ name: 'Term 1', startDate: '2026-09-01', endDate: '2026-12-18' }).expect(201);
  await m.post(`/academic-years/${year.id}/activate`).send({}).expect(200);
  const levels = (await m.post('/education-levels/standard').send({ stages: ['PRIMARY'] }).expect(200)).body.data;
  const a = (await m.post('/classes').send({ academicYearId: year.id, levelId: levels[0].id, name: 'P1 A', capacity }).expect(201)).body.data;
  const b = (await m.post('/classes').send({ academicYearId: year.id, levelId: levels[0].id, name: 'P1 B' }).expect(201)).body.data;
  return { year, a, b };
}

const admit = (m: Client, body: Record<string, unknown>) =>
  m.post('/students').send({ firstName: 'Esi', lastName: 'Boateng', dateOfBirth: '2019-03-14', admissionDate: '2026-09-01', ...body });

describe('admissions', () => {
  it('generates sequential admission numbers per school and year', async () => {
    const m = await oakManager();
    await m.patch('/school').send({ admissionNumberPrefix: 'oak' }).expect(200);
    const first = (await admit(m, {}).expect(201)).body.data;
    const second = (await admit(m, { firstName: 'Yaw', lastName: 'Mensah' }).expect(201)).body.data;
    expect(first.admissionNumber).toBe('OAK-2026-0001');
    expect(second.admissionNumber).toBe('OAK-2026-0002');
    const maple = (await admit(await mapleManager(), {}).expect(201)).body.data;
    expect(maple.admissionNumber).toBe('MAP-2026-0001');
  });

  it('skips generated numbers that were already used manually, and rejects duplicate manual numbers', async () => {
    const m = await oakManager();
    await m.patch('/school').send({ admissionNumberPrefix: 'OAK' }).expect(200);
    await admit(m, { admissionNumber: 'OAK-2026-0001', firstName: 'Manual' }).expect(201);
    const generated = (await admit(m, {}).expect(201)).body.data;
    expect(generated.admissionNumber).toBe('OAK-2026-0002');
    const dup = await admit(m, { admissionNumber: 'OAK-2026-0001', firstName: 'Other' }).expect(409);
    expect(dup.body.error.code).toBe('ADMISSION_NUMBER_TAKEN');
  });

  it('warns about a possible duplicate and admits only when confirmed', async () => {
    const m = await oakManager();
    await admit(m, {}).expect(201);
    const warn = await admit(m, { firstName: 'ESI' }).expect(409);
    expect(warn.body.error.code).toBe('POSSIBLE_DUPLICATE');
    expect(warn.body.error.details.matches).toHaveLength(1);
    await admit(m, { firstName: 'ESI', confirmDuplicate: true }).expect(201);
  });

  it('can enroll on admission and respects class capacity', async () => {
    const m = await oakManager();
    const { a } = await setUpYear(m, 1);
    const first = (await admit(m, { classId: a.id }).expect(201)).body.data;
    expect(first.currentClass.name).toBe('P1 A');
    const full = await admit(m, { firstName: 'Kojo', classId: a.id }).expect(409);
    expect(full.body.error.code).toBe('CLASS_FULL');
    // The failed admission left nothing behind.
    expect(await prisma.student.count({ where: { schoolId: f.oakwood.id, firstName: 'Kojo' } })).toBe(0);
  });

  it('requires a reason to correct identity details and records it', async () => {
    const m = await oakManager();
    const s = (await admit(m, {}).expect(201)).body.data;
    const noReason = await m.patch(`/students/${s.id}`).send({ lastName: 'Boateng-Ansah' }).expect(400);
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    await m.patch(`/students/${s.id}`).send({ lastName: 'Boateng-Ansah', reason: 'Birth certificate spelling' }).expect(200);
    await m.patch(`/students/${s.id}`).send({ homeAddress: 'Osu, Accra' }).expect(200);
    const history = (await m.get(`/students/${s.id}/history`).expect(200)).body.data;
    expect(history[1]).toMatchObject({ action: 'student.correct', summary: { corrected: ['lastName'], reason: 'Birth certificate spelling' } });
    expect(history[0].action).toBe('student.update');
  });
});

describe('enrollment', () => {
  it('enrolls once per year, transfers with history, and withdraws', async () => {
    const m = await oakManager();
    const { a, b } = await setUpYear(m);
    const s = (await admit(m, {}).expect(201)).body.data;

    await m.post(`/students/${s.id}/enrollments`).send({ classId: a.id, startDate: '2026-09-01' }).expect(201);
    const twice = await m.post(`/students/${s.id}/enrollments`).send({ classId: b.id }).expect(409);
    expect(twice.body.error.code).toBe('ALREADY_ENROLLED');

    const moved = (await m.post(`/students/${s.id}/transfer`).send({ classId: b.id, reason: 'Parent request', date: '2026-10-01' }).expect(200)).body.data;
    expect(moved.currentClass.name).toBe('P1 B');
    expect(moved.enrollments.map((e: { status: string; className: string }) => `${e.className}:${e.status}`)).toEqual([
      'P1 B:ACTIVE',
      'P1 A:TRANSFERRED',
    ]);

    const left = (await m.post(`/students/${s.id}/withdraw`).send({ status: 'WITHDRAWN', reason: 'Family moved', date: '2026-11-01' }).expect(200)).body.data;
    expect(left).toMatchObject({ status: 'WITHDRAWN', currentClass: null });
    await m.post(`/students/${s.id}/enrollments`).send({ classId: a.id }).expect(409);
  });

  it('closing the year completes enrollments and blocks new ones', async () => {
    const m = await oakManager();
    const { year, a } = await setUpYear(m);
    const s = (await admit(m, { classId: a.id }).expect(201)).body.data;
    await m.post(`/academic-years/${year.id}/close`).expect(200);
    const after = (await m.get(`/students/${s.id}`).expect(200)).body.data;
    expect(after.enrollments[0]).toMatchObject({ status: 'COMPLETED', endDate: '2027-07-31' });
    expect((await m.post(`/students/${s.id}/enrollments`).send({ classId: a.id }).expect(409)).body.error.code).toBe('YEAR_CLOSED');
  });

  it("refuses to delete a class that has had students", async () => {
    const m = await oakManager();
    const { a } = await setUpYear(m);
    await admit(m, { classId: a.id }).expect(201);
    expect((await m.delete(`/classes/${a.id}`).expect(409)).body.error.code).toBe('CLASS_IN_USE');
  });
});

describe('parents and the parent portal', () => {
  async function parentWithChild(m: Client, email = 'akua@example.test') {
    const { a } = await setUpYear(m);
    const child = (await admit(m, { classId: a.id }).expect(201)).body.data;
    const other = (await admit(m, { firstName: 'Not', lastName: 'Mine', classId: a.id }).expect(201)).body.data;
    const linked = await m
      .post(`/students/${child.id}/guardians`)
      .send({ guardian: { fullName: 'Akua Boateng', email, phone: '+233 20 000 0000' }, relationship: 'MOTHER', isPrimaryContact: true })
      .expect(201);
    const guardianId = linked.body.data[0].guardianId as string;
    const invited = await m.post(`/guardians/${guardianId}/invite`).expect(200);
    return { child, other, guardianId, invited: invited.body.data };
  }

  async function activateParent(email: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const token = await tokens.issue(user.id, 'ACTIVATION', ACTIVATION_TTL_MS);
    await client(app, HOSTS.oakwood).post('/auth/activate').send({ token, password: PASSWORD, fullName: 'Akua Boateng' }).expect(204);
    return as(HOSTS.oakwood, email);
  }

  it('lets an invited parent see only their linked child', async () => {
    const m = await oakManager();
    const { child, other, invited } = await parentWithChild(m);
    expect(invited).toEqual({ portal: 'INVITED', invitationQueued: true });
    const parent = await activateParent('akua@example.test');

    const children = (await parent.get('/portal/children').expect(200)).body.data;
    expect(children).toEqual([expect.objectContaining({ id: child.id, className: 'P1 A', relationship: 'MOTHER' })]);
    const detail = (await parent.get(`/portal/children/${child.id}`).expect(200)).body.data;
    expect(detail.currentClass).toMatchObject({ name: 'P1 A', yearName: '2026/2027' });

    await parent.get(`/portal/children/${other.id}`).expect(404);
    await parent.get(`/portal/children/${f.mapleStudent.id}`).expect(404);
    // Parents have no staff permissions.
    await parent.get('/students').expect(403);
    await parent.get(`/students/${child.id}`).expect(403);
    await parent.get('/staff').expect(403);
  });

  it('removes access immediately when the link is turned off or removed', async () => {
    const m = await oakManager();
    const { child, guardianId } = await parentWithChild(m);
    const parent = await activateParent('akua@example.test');

    await m.patch(`/students/${child.id}/guardians/${guardianId}`).send({ portalAccess: false }).expect(200);
    expect((await parent.get('/portal/children').expect(200)).body.data).toEqual([]);
    await parent.get(`/portal/children/${child.id}`).expect(404);

    await m.patch(`/students/${child.id}/guardians/${guardianId}`).send({ portalAccess: true }).expect(200);
    await parent.get(`/portal/children/${child.id}`).expect(200);

    await m.delete(`/students/${child.id}/guardians/${guardianId}`).expect(200);
    await parent.get(`/portal/children/${child.id}`).expect(404);
  });

  it('revoking portal access signs a parent-only account out', async () => {
    const m = await oakManager();
    const { guardianId } = await parentWithChild(m);
    const parent = await activateParent('akua@example.test');
    await m.post(`/guardians/${guardianId}/revoke-access`).expect(200);
    await parent.get('/auth/me').expect(401);
  });

  it("a parent account at one school gives nothing at another", async () => {
    const m = await oakManager();
    await parentWithChild(m);
    await activateParent('akua@example.test');
    await client(app, HOSTS.maple).post('/auth/login').send({ email: 'akua@example.test', password: PASSWORD }).expect(401);
  });

  it('a teacher who is also a parent keeps one account with both kinds of access', async () => {
    const m = await oakManager();
    const { child } = await parentWithChild(m, 'tom@example.test');
    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    expect((await tom.get('/portal/children').expect(200)).body.data.map((c: { id: string }) => c.id)).toEqual([child.id]);
    await tom.get('/classes').expect(200);
    expect(await prisma.schoolMembership.count({ where: { userId: f.tom.user.id } })).toBe(1);
  });

  it('staff without a guardian link see an empty portal', async () => {
    const m = await oakManager();
    expect((await m.get('/portal/children').expect(200)).body.data).toEqual([]);
  });
});

describe('student documents', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 0x20), Buffer.from('\n%%EOF')]);
  const fakePdf = Buffer.from('MZ\x90\x00 this is really an executable, not a pdf');

  it('uploads, lists, downloads and deletes a private document', async () => {
    const m = await oakManager();
    const s = (await admit(m, {}).expect(201)).body.data;
    const up = await m
      .post(`/students/${s.id}/documents`)
      .field('kind', 'BIRTH_CERTIFICATE')
      .attach('file', pdf, { filename: 'Birth cert (Esi).pdf', contentType: 'application/pdf' })
      .expect(201);
    expect(up.body.data).toMatchObject({ kind: 'BIRTH_CERTIFICATE', contentType: 'application/pdf', sizeBytes: pdf.length });

    const list = (await m.get(`/students/${s.id}/documents`).expect(200)).body.data;
    expect(list).toHaveLength(1);

    const download = await m
      .get(`/students/${s.id}/documents/${up.body.data.id}/download`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(Buffer.compare(download.body as Buffer, pdf)).toBe(0);
    expect(download.headers['content-disposition']).toContain('attachment;');
    expect(download.headers['cache-control']).toBe('private, no-store');

    const stored = await prisma.studentDocument.findUniqueOrThrow({ where: { id: up.body.data.id } });
    expect(stored.storageKey).not.toContain('Birth');
    expect(await prisma.auditLog.count({ where: { action: 'document.download' } })).toBe(1);

    await m.delete(`/students/${s.id}/documents/${up.body.data.id}`).expect(204);
    await m.get(`/students/${s.id}/documents/${up.body.data.id}/download`).expect(404);
  });

  it('checks the real file type, not the name or declared type', async () => {
    const m = await oakManager();
    const s = (await admit(m, {}).expect(201)).body.data;
    const res = await m
      .post(`/students/${s.id}/documents`)
      .field('kind', 'OTHER')
      .attach('file', fakePdf, { filename: 'report.pdf', contentType: 'application/pdf' })
      .expect(400);
    expect(res.body.error.code).toBe('UNSUPPORTED_FILE');
  });

  it('keeps documents away from people without document permissions and from other schools', async () => {
    const m = await oakManager();
    const s = (await admit(m, {}).expect(201)).body.data;
    const up = (
      await m.post(`/students/${s.id}/documents`).field('kind', 'MEDICAL').attach('file', pdf, { filename: 'x.pdf', contentType: 'application/pdf' }).expect(201)
    ).body.data;

    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    await tom.get(`/students/${s.id}/documents`).expect(403);
    await tom.get(`/students/${s.id}/documents/${up.id}/download`).expect(403);

    const maple = await mapleManager();
    await maple.get(`/students/${s.id}/documents`).expect(404);
    await maple.get(`/students/${s.id}/documents/${up.id}/download`).expect(404);
    await maple.get(`/students/${f.mapleStudent.id}/documents/${up.id}/download`).expect(404);
  });
});

describe('tenant isolation for students and parents', () => {
  it("can't enroll, link or edit another school's students", async () => {
    const oak = await oakManager();
    const { a: oakClass } = await setUpYear(oak);
    const maple = await mapleManager();
    const { a: mapleClass } = await setUpYear(maple);

    await maple.post(`/students/${f.oakStudent.id}/enrollments`).send({ classId: mapleClass.id }).expect(404);
    await maple.post(`/students/${f.mapleStudent.id}/enrollments`).send({ classId: oakClass.id }).expect(404);
    await maple.patch(`/students/${f.oakStudent.id}`).send({ homeAddress: 'x' }).expect(404);
    await maple.post(`/students/${f.oakStudent.id}/withdraw`).send({ status: 'WITHDRAWN', reason: 'hijack' }).expect(404);

    const oakGuardian = (
      await oak.post(`/students/${f.oakStudent.id}/guardians`).send({ guardian: { fullName: 'Oak Parent' }, relationship: 'FATHER' }).expect(201)
    ).body.data[0].guardianId;
    await maple.post(`/students/${f.mapleStudent.id}/guardians`).send({ guardianId: oakGuardian, relationship: 'FATHER' }).expect(404);
    await maple.get(`/guardians/${oakGuardian}`).expect(404);
    await maple.post(`/guardians/${oakGuardian}/invite`).expect(404);
    expect((await maple.get('/guardians').expect(200)).body.data).toEqual([]);
  });

  it('the database refuses enrollments whose class, year or school disagree', async () => {
    const oak = await oakManager();
    const { a } = await setUpYear(oak);
    const maple = await mapleManager();
    const { year: mapleYear } = await setUpYear(maple);
    await expect(
      prisma.enrollment.create({
        data: { schoolId: f.maple.id, studentId: f.mapleStudent.id, classId: a.id, academicYearId: mapleYear.id, startDate: new Date() },
      }),
    ).rejects.toThrow();
  });
});
