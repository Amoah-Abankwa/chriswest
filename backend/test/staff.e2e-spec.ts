import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../src/prisma/prisma.service';
import { HOSTS, PASSWORD, member, resetDatabase, seedSchools } from './fixtures';
import { client, createTestApp, drainOutbox, signIn } from './helpers';
import { hashPassword } from '../src/auth/crypto';

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

const builtIn = async (schoolId: string, key: string) =>
  (await prisma.role.findFirstOrThrow({ where: { schoolId, key, isSystem: true } })).id;

/** An HR officer: can manage staff and roles, but holds no finance or academic-management permissions. */
async function hrOfficer(m: Client) {
  const role = await m
    .post('/roles')
    .send({
      name: 'HR officer',
      permissions: ['staff.read', 'staff.create', 'staff.update', 'staff.deactivate', 'roles.read', 'roles.manage', 'academics.read'].map(
        (key) => ({ key }),
      ),
    })
    .expect(201);
  const passwordHash = await hashPassword(PASSWORD);
  const hr = await member(prisma, f.oakwood.id, 'hana@example.test', { passwordHash, roleId: role.body.data.id });
  return { client: await as(HOSTS.oakwood, 'hana@example.test'), roleId: role.body.data.id as string, membershipId: hr.membership.id };
}

async function currentYearWithClass(m: Client) {
  const year = (await m.post('/academic-years').send({ name: '2026/2027', startDate: '2026-09-01', endDate: '2027-07-31' }).expect(201)).body.data;
  await m.post(`/academic-years/${year.id}/terms`).send({ name: 'Term 1', startDate: '2026-09-01', endDate: '2026-12-18' }).expect(201);
  await m.post(`/academic-years/${year.id}/activate`).send({}).expect(200);
  const levels = (await m.post('/education-levels/standard').send({ stages: ['PRIMARY'] }).expect(200)).body.data;
  const a = (await m.post('/classes').send({ academicYearId: year.id, levelId: levels[0].id, name: 'Primary 1A' }).expect(201)).body.data;
  const b = (await m.post('/classes').send({ academicYearId: year.id, levelId: levels[0].id, name: 'Primary 1B' }).expect(201)).body.data;
  return { year, a, b };
}

describe('inviting staff', () => {
  it('invites a new person with a role and profile', async () => {
    const m = await oakManager();
    const teacherRole = await builtIn(f.oakwood.id, 'teacher');
    const res = await m
      .post('/staff/invitations')
      .send({ email: 'Kwame@Example.test', fullName: 'Kwame Asante', jobTitle: 'Class teacher', staffNumber: 'T-014', roleIds: [teacherRole] })
      .expect(201);
    expect(res.body.data).toMatchObject({ accountStatus: 'INVITED', invitationQueued: true });
    await drainOutbox(app);

    const detail = await m.get(`/staff/${res.body.data.membershipId}`).expect(200);
    expect(detail.body.data).toMatchObject({
      email: 'kwame@example.test',
      fullName: 'Kwame Asante',
      staffNumber: 'T-014',
      roles: [expect.objectContaining({ name: 'Teacher' })],
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'kwame@example.test' } });
    expect(await prisma.authToken.count({ where: { userId: user.id, purpose: 'ACTIVATION' } })).toBe(1);
  });

  it('adds someone who already works at another school without a new account', async () => {
    const m = await oakManager();
    const res = await m.post('/staff/invitations').send({ email: 'bob@example.test', roleIds: [await builtIn(f.oakwood.id, 'teacher')] }).expect(201);
    expect(res.body.data.accountStatus).toBe('ACTIVE');
    expect(await prisma.user.count({ where: { email: 'bob@example.test' } })).toBe(1);
  });

  it('refuses duplicates, platform admins and taken staff numbers', async () => {
    const m = await oakManager();
    const role = await builtIn(f.oakwood.id, 'teacher');
    expect((await m.post('/staff/invitations').send({ email: 'tom@example.test', roleIds: [role] }).expect(409)).body.error.code).toBe('ALREADY_MEMBER');
    expect((await m.post('/staff/invitations').send({ email: 'root@platform.test', roleIds: [role] }).expect(409)).body.error.code).toBe('EMAIL_NOT_ALLOWED');
    await m.post('/staff/invitations').send({ email: 'a@example.test', staffNumber: 'S1', roleIds: [role] }).expect(201);
    expect((await m.post('/staff/invitations').send({ email: 'b@example.test', staffNumber: 'S1', roleIds: [role] }).expect(409)).body.error.code).toBe('STAFF_NUMBER_TAKEN');
  });

  it("can't use another school's roles", async () => {
    const m = await oakManager();
    await m.post('/staff/invitations').send({ email: 'x@example.test', roleIds: [await builtIn(f.maple.id, 'teacher')] }).expect(404);
  });
});

describe('delegation: you can only give out what you have', () => {
  it('stops an HR officer from creating roles or granting roles beyond their own permissions', async () => {
    const hr = (await hrOfficer(await oakManager())).client;

    const finance = await hr.post('/roles').send({ name: 'Cashier', permissions: [{ key: 'payments.record' }] }).expect(403);
    expect(finance.body.error.code).toBe('DELEGATION_DENIED');
    expect(finance.body.error.details.permissions).toEqual(['payments.record']);

    await hr.post('/staff/invitations').send({ email: 'boss@example.test', roleIds: [await builtIn(f.oakwood.id, 'manager')] }).expect(403);
    await hr.put(`/staff/${f.tom.membership.id}/roles`).send({ roleIds: [await builtIn(f.oakwood.id, 'accountant')] }).expect(403);

    // Allowed: a role made only of permissions the HR officer holds.
    await hr.post('/roles').send({ name: 'Staff viewer', permissions: [{ key: 'staff.read' }] }).expect(201);
  });

  it('stops anyone from demoting or deactivating someone more powerful', async () => {
    const hr = (await hrOfficer(await oakManager())).client;
    await hr.put(`/staff/${f.maya.membership.id}/roles`).send({ roleIds: [] }).expect(403);
    await hr.post(`/staff/${f.maya.membership.id}/deactivate`).send({ reason: 'coup' }).expect(403);
    const detail = await hr.get(`/staff/${f.maya.membership.id}`).expect(200);
    expect(detail.body.data.canManage).toBe(false);
  });

  it("doesn't let people change their own roles or deactivate themselves", async () => {
    const m = await oakManager();
    expect((await m.put(`/staff/${f.maya.membership.id}/roles`).send({ roleIds: [] }).expect(409)).body.error.code).toBe('SELF_CHANGE');
    await m.post(`/staff/${f.maya.membership.id}/deactivate`).send({ reason: 'leaving' }).expect(409);
  });

  it('lets one manager hand the role over to another', async () => {
    const m = await oakManager();
    const managerRole = await builtIn(f.oakwood.id, 'manager');
    // Promote Tom, then let Tom remove Maya's manager role: allowed, one manager remains.
    await m.put(`/staff/${f.tom.membership.id}/roles`).send({ roleIds: [managerRole] }).expect(200);
    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    await tom.put(`/staff/${f.maya.membership.id}/roles`).send({ roleIds: [await builtIn(f.oakwood.id, 'teacher')] }).expect(200);
    expect(await prisma.membershipRole.count({ where: { roleId: managerRole } })).toBe(1);
  });

  it('rejects assigned-only scope on permissions that are always school-wide', async () => {
    const m = await oakManager();
    const res = await m.post('/roles').send({ name: 'Odd', permissions: [{ key: 'payments.record', scope: 'ASSIGNED' }] }).expect(400);
    expect(res.body.error.code).toBe('SCOPE_NOT_ALLOWED');
  });
});

describe('roles', () => {
  it("doesn't allow built-in roles to be edited or deleted", async () => {
    const m = await oakManager();
    const teacher = await builtIn(f.oakwood.id, 'teacher');
    expect((await m.patch(`/roles/${teacher}`).send({ name: 'Tutor' }).expect(409)).body.error.code).toBe('SYSTEM_ROLE');
    await m.delete(`/roles/${teacher}`).expect(409);
  });

  it('edits a custom role, records what changed, and refuses to delete it while in use', async () => {
    const m = await oakManager();
    const { roleId } = await hrOfficer(m);
    await m.patch(`/roles/${roleId}`).send({ permissions: [{ key: 'staff.read' }, { key: 'academics.read', scope: 'ASSIGNED' }] }).expect(200);
    const history = (await m.get(`/roles/${roleId}/history`).expect(200)).body.data;
    expect(history[0]).toMatchObject({ action: 'role.update', actor: 'maya@example.test' });
    expect(history[0].summary.removed).toEqual(expect.arrayContaining(['staff.create', 'roles.manage']));
    expect(history[0].summary.rescoped).toEqual(['academics.read:ASSIGNED']);
    expect((await m.delete(`/roles/${roleId}`).expect(409)).body.error.code).toBe('ROLE_IN_USE');
  });

  it('applies permission changes on the very next request', async () => {
    const m = await oakManager();
    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    await tom.get('/classes').expect(200);
    await m.put(`/staff/${f.tom.membership.id}/roles`).send({ roleIds: [] }).expect(200);
    await tom.get('/classes').expect(403);
  });
});

describe('deactivation', () => {
  it('signs the person out, frees their current classes, and can be undone', async () => {
    const m = await oakManager();
    const { a } = await currentYearWithClass(m);
    await m.put(`/classes/${a.id}/class-teacher`).send({ membershipId: f.tom.membership.id }).expect(200);
    const tom = await as(HOSTS.oakwood, 'tom@example.test');

    await m.post(`/staff/${f.tom.membership.id}/deactivate`).send({ reason: 'Left the school' }).expect(200);
    await tom.get('/auth/me').expect(401);
    await client(app, HOSTS.oakwood).post('/auth/login').send({ email: 'tom@example.test', password: PASSWORD }).expect(401);
    expect(await prisma.classTeacher.count({ where: { classId: a.id } })).toBe(0);
    await m.put(`/classes/${a.id}/class-teacher`).send({ membershipId: f.tom.membership.id }).expect(404);

    await m.post(`/staff/${f.tom.membership.id}/reactivate`).send({ reason: 'Returned' }).expect(200);
    await signIn(app, HOSTS.oakwood, 'tom@example.test');

    const history = (await m.get(`/staff/${f.tom.membership.id}/history`).expect(200)).body.data;
    expect(history.map((h: { action: string }) => h.action)).toEqual(['staff.reactivate', 'staff.deactivate']);
  });
});

describe('assigned-class scope', () => {
  it('limits a role with assigned-only access to the classes the person teaches', async () => {
    const m = await oakManager();
    const { a, b } = await currentYearWithClass(m);
    const viewer = await m.post('/roles').send({ name: 'Class viewer', permissions: [{ key: 'academics.read', scope: 'ASSIGNED' }] }).expect(201);
    await m.put(`/staff/${f.carol.membership.id}/roles`).send({ roleIds: [viewer.body.data.id] }).expect(200);
    await m.put(`/classes/${a.id}/class-teacher`).send({ membershipId: f.carol.membership.id }).expect(200);

    const carol = await as(HOSTS.oakwood, 'carol@example.test');
    const list = (await carol.get('/classes').expect(200)).body.data;
    expect(list.map((c: { name: string }) => c.name)).toEqual(['Primary 1A']);
    await carol.get(`/classes/${a.id}`).expect(200);
    await carol.get(`/classes/${b.id}`).expect(404);

    const me = (await carol.get('/auth/me').expect(200)).body.data;
    expect(me.assignedOnly).toEqual(['academics.read']);
    const mine = (await carol.get('/me/assignments').expect(200)).body.data;
    expect(mine.classes).toEqual([expect.objectContaining({ name: 'Primary 1A', isClassTeacher: true })]);
  });

  it('a school-wide grant from one role beats an assigned-only grant from another', async () => {
    const m = await oakManager();
    await currentYearWithClass(m);
    const narrow = await m.post('/roles').send({ name: 'Narrow', permissions: [{ key: 'academics.read', scope: 'ASSIGNED' }] }).expect(201);
    const wide = await m.post('/roles').send({ name: 'Wide', permissions: [{ key: 'academics.read' }] }).expect(201);
    await m.put(`/staff/${f.carol.membership.id}/roles`).send({ roleIds: [narrow.body.data.id, wide.body.data.id] }).expect(200);
    const carol = await as(HOSTS.oakwood, 'carol@example.test');
    expect((await carol.get('/classes').expect(200)).body.data).toHaveLength(2);
  });

  it('teachers only see students enrolled in their own classes', async () => {
    const m = await oakManager();
    const { a, b } = await currentYearWithClass(m);
    await m.put(`/classes/${a.id}/class-teacher`).send({ membershipId: f.tom.membership.id }).expect(200);
    const tom = await as(HOSTS.oakwood, 'tom@example.test');

    // Not enrolled anywhere yet: invisible to the teacher, visible to the manager.
    expect((await m.get('/students').expect(200)).body.meta.total).toBe(1);
    expect((await tom.get('/students').expect(200)).body.meta.total).toBe(0);
    await tom.get(`/students/${f.oakStudent.id}`).expect(404);

    // Enrolled in someone else's class: still invisible.
    await m.post(`/students/${f.oakStudent.id}/enrollments`).send({ classId: b.id }).expect(201);
    expect((await tom.get('/students').expect(200)).body.meta.total).toBe(0);

    // Moved into Tom's class: now visible.
    await m.post(`/students/${f.oakStudent.id}/transfer`).send({ classId: a.id, reason: 'Stream change' }).expect(200);
    expect((await tom.get('/students').expect(200)).body.meta.total).toBe(1);
    await tom.get(`/students/${f.oakStudent.id}`).expect(200);
  });
});

describe('tenant isolation for staff and roles', () => {
  it("never exposes or changes another school's staff or roles", async () => {
    const maple = await as(HOSTS.maple, 'mo@example.test');
    await maple.get(`/staff/${f.tom.membership.id}`).expect(404);
    await maple.patch(`/staff/${f.tom.membership.id}`).send({ jobTitle: 'Hacked' }).expect(404);
    await maple.post(`/staff/${f.tom.membership.id}/deactivate`).send({ reason: 'x x x' }).expect(404);
    await maple.get(`/staff/${f.tom.membership.id}/history`).expect(404);
    await maple.get(`/roles/${await builtIn(f.oakwood.id, 'teacher')}`).expect(404);
    await maple.put(`/staff/${f.mo.membership.id}/roles`).send({ roleIds: [await builtIn(f.oakwood.id, 'manager')] }).expect(409); // own account
    await maple.put(`/staff/${f.bob.membership.id}/roles`).send({ roleIds: [await builtIn(f.oakwood.id, 'manager')] }).expect(404);

    const list = (await maple.get('/staff?pageSize=100').expect(200)).body.data.map((s: { email: string }) => s.email);
    expect(list).not.toContain('tom@example.test');
    expect(await prisma.schoolMembership.findUniqueOrThrow({ where: { id: f.tom.membership.id } })).toMatchObject({ status: 'ACTIVE' });
  });
});
