import type { NestExpressApplication } from '@nestjs/platform-express';
import { ACTIVATION_TTL_MS, AuthTokensService } from '../src/auth/auth-tokens.service';
import { Clock } from '../src/common/clock';
import { workingDays } from '../src/leave/leave.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { HOSTS, PASSWORD, resetDatabase, seedSchools } from './fixtures';
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
const oak = () => as(HOSTS.oakwood, 'maya@example.test');

async function parentOf(m: Client, studentId: string) {
  const linked = await m.post(`/students/${studentId}/guardians`).send({ guardian: { fullName: 'Akua', email: 'akua@example.test' }, relationship: 'MOTHER' }).expect(201);
  await m.post(`/guardians/${linked.body.data[0].guardianId}/invite`).expect(200);
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'akua@example.test' } });
  const token = await app.get(AuthTokensService).issue(user.id, 'ACTIVATION', ACTIVATION_TTL_MS);
  await client(app, HOSTS.oakwood).post('/auth/activate').send({ token, password: PASSWORD }).expect(204);
  return as(HOSTS.oakwood, 'akua@example.test');
}

describe('library', () => {
  it('lends and returns copies, with accession numbers, limits and overdue tracking', async () => {
    const m = await oak();
    await m.patch('/school').send({ libraryMaxLoans: 2, libraryLoanDays: 7 }).expect(200);
    const book = (await m.post('/library/books').send({ title: 'Things Fall Apart', author: 'Chinua Achebe', copies: 3 }).expect(201)).body.data;
    expect(book.copies.map((c: { accessionNumber: string }) => c.accessionNumber)).toEqual(['LIB-000001', 'LIB-000002', 'LIB-000003']);

    const loan = (await m.post('/library/loans').send({ accessionNumber: 'lib-000001', studentId: f.oakStudent.id }).expect(201)).body.data;
    expect(loan).toMatchObject({ dueOn: '2026-10-20', overdue: false });
    expect((await m.post('/library/loans').send({ accessionNumber: 'LIB-000001', studentId: f.oakStudent.id }).expect(409)).body.error.code).toBe('NOT_AVAILABLE');
    await m.post('/library/loans').send({ accessionNumber: 'LIB-000002', studentId: f.oakStudent.id, dueOn: '2026-10-14' }).expect(201);
    expect((await m.post('/library/loans').send({ accessionNumber: 'LIB-000003', studentId: f.oakStudent.id }).expect(409)).body.error.code).toBe('LOAN_LIMIT');

    app.get(Clock).setForTests(new Date('2026-10-16T10:00:00Z'));
    const overdue = (await m.get('/library/loans?status=overdue').expect(200)).body.data;
    expect(overdue.map((l: { copy: { accessionNumber: string } }) => l.copy.accessionNumber)).toEqual(['LIB-000002']);
    app.get(Clock).setForTests(new Date('2026-10-13T10:00:00Z'));

    await m.post(`/library/loans/${loan.id}/return`).expect(200);
    await m.post(`/library/loans/${loan.id}/return`).expect(409);
    const copies = (await m.get(`/library/books/${book.id}`).expect(200)).body.data.copies.map((c: { status: string }) => c.status);
    expect(copies).toEqual(['AVAILABLE', 'ON_LOAN', 'AVAILABLE']);

    const parent = await parentOf(m, f.oakStudent.id);
    expect((await parent.get(`/portal/children/${f.oakStudent.id}/library`).expect(200)).body.data).toHaveLength(1);
  });
});

describe('transport', () => {
  it('assigns students to a stop on a route, respects seats, and shows parents the bus', async () => {
    const m = await oak();
    const route = (await m.post('/transport/routes').send({ name: 'Tema route', driverName: 'Mr Mensah', driverPhone: '+233 24 000 0000', capacity: 1 }).expect(201)).body.data;
    const withStops = (await m.put(`/transport/routes/${route.id}/stops`).send({ stops: [{ name: 'Community 1', pickupTime: '06:30' }, { name: 'Junction', pickupTime: '06:45' }] }).expect(200)).body.data;
    const other = (await m.post('/transport/routes').send({ name: 'Spintex route' }).expect(201)).body.data;
    const otherStop = (await m.put(`/transport/routes/${other.id}/stops`).send({ stops: [{ name: 'Mall' }] }).expect(200)).body.data.stops[0];

    expect((await m.put(`/students/${f.oakStudent.id}/transport`).send({ routeId: route.id, stopId: otherStop.id }).expect(400)).body.error.code).toBe('STOP_NOT_ON_ROUTE');
    await m.put(`/students/${f.oakStudent.id}/transport`).send({ routeId: route.id, stopId: withStops.stops[1].id }).expect(200);

    const second = (await m.post('/students').send({ firstName: 'Yaw', lastName: 'Test', admissionDate: '2026-09-01' }).expect(201)).body.data;
    expect((await m.put(`/students/${second.id}/transport`).send({ routeId: route.id, stopId: withStops.stops[0].id }).expect(409)).body.error.code).toBe('ROUTE_FULL');
    expect((await m.put(`/transport/routes/${route.id}/stops`).send({ stops: [{ id: withStops.stops[0].id, name: 'Community 1' }] }).expect(409)).body.error.code).toBe('STOP_IN_USE');

    const parent = await parentOf(m, f.oakStudent.id);
    const bus = (await parent.get(`/portal/children/${f.oakStudent.id}/transport`).expect(200)).body.data;
    expect(bus).toMatchObject({ route: { name: 'Tema route', driverName: 'Mr Mensah' }, stop: { name: 'Junction', pickupTime: '06:45' } });

    // The database refuses a stop from another route even if the API check were skipped.
    await expect(
      prisma.transportAssignment.update({ where: { schoolId_studentId: { schoolId: f.oakwood.id, studentId: f.oakStudent.id } }, data: { stopId: otherStop.id } }),
    ).rejects.toThrow();
  });
});

describe('staff leave', () => {
  it('counts working days, enforces allowances and overlaps, and needs someone else to approve', async () => {
    expect(workingDays('2026-10-12', '2026-10-18')).toBe(5);
    const m = await oak();
    const types = (await m.post('/leave/types').send({ name: 'Annual leave', daysPerYear: 6 }).expect(201)).body.data;
    const annual = types[0].id;
    const tom = await as(HOSTS.oakwood, 'tom@example.test');

    const req = (await tom.post('/leave/requests').send({ typeId: annual, startDate: '2026-11-02', endDate: '2026-11-06', reason: 'Family wedding' }).expect(201)).body.data;
    expect(req).toMatchObject({ days: 5, status: 'PENDING' });
    expect((await tom.post('/leave/requests').send({ typeId: annual, startDate: '2026-11-05', endDate: '2026-11-05', reason: 'x x' }).expect(409)).body.error.code).toBe('OVERLAPS');
    expect((await tom.post('/leave/requests').send({ typeId: annual, startDate: '2026-12-01', endDate: '2026-12-02', reason: 'Too much' }).expect(409)).body.error.code).toBe('NOT_ENOUGH_DAYS');
    expect((await tom.post('/leave/requests').send({ typeId: annual, startDate: '2026-12-26', endDate: '2027-01-02', reason: 'New year' }).expect(400)).body.error.code).toBe('SPANS_YEARS');

    await tom.post(`/leave/requests/${req.id}/approve`).send({}).expect(403);
    await m.post(`/leave/requests/${req.id}/approve`).send({ note: 'Enjoy the wedding' }).expect(200);
    await m.post(`/leave/requests/${req.id}/reject`).send({}).expect(409);
    const mine = (await tom.get('/leave/mine').expect(200)).body.data;
    expect(mine.balances[0]).toMatchObject({ used: 5, remaining: 1 });
    expect((await tom.get('/notifications').expect(200)).body.data[0]).toMatchObject({ kind: 'leave.decided', title: 'Leave approved' });

    const own = (await m.post('/leave/requests').send({ typeId: annual, startDate: '2026-11-09', endDate: '2026-11-09', reason: 'Appointment' }).expect(201)).body.data;
    expect((await m.post(`/leave/requests/${own.id}/approve`).send({}).expect(409)).body.error.code).toBe('SELF_APPROVAL');
  });
});

describe('isolation', () => {
  it("another school can't see or touch this school's books, buses or leave", async () => {
    const m = await oak();
    const book = (await m.post('/library/books').send({ title: 'Oak book', copies: 1 }).expect(201)).body.data;
    const loan = (await m.post('/library/loans').send({ accessionNumber: 'LIB-000001', studentId: f.oakStudent.id }).expect(201)).body.data;
    const route = (await m.post('/transport/routes').send({ name: 'Oak route' }).expect(201)).body.data;
    const type = (await m.post('/leave/types').send({ name: 'Sick', daysPerYear: 10 }).expect(201)).body.data[0];
    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    const req = (await tom.post('/leave/requests').send({ typeId: type.id, startDate: '2026-11-02', endDate: '2026-11-02', reason: 'Unwell' }).expect(201)).body.data;

    const mo = await as(HOSTS.maple, 'mo@example.test');
    await mo.get(`/library/books/${book.id}`).expect(404);
    await mo.post(`/library/loans/${loan.id}/return`).expect(404);
    await mo.post('/library/loans').send({ accessionNumber: 'LIB-000001', studentId: f.mapleStudent.id }).expect(404);
    await mo.get(`/transport/routes/${route.id}`).expect(404);
    await mo.put(`/students/${f.mapleStudent.id}/transport`).send({ routeId: route.id, stopId: route.id }).expect(404);
    await mo.post(`/leave/requests/${req.id}/approve`).send({}).expect(404);
    await mo.post('/leave/requests').send({ typeId: type.id, startDate: '2026-11-03', endDate: '2026-11-03', reason: 'x x x' }).expect(404);
    expect((await mo.get('/library/books').expect(200)).body.data).toEqual([]);
    expect((await mo.get('/leave/requests').expect(200)).body.data).toEqual([]);
  });
});
