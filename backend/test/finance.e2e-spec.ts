import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { ACTIVATION_TTL_MS, AuthTokensService } from '../src/auth/auth-tokens.service';
import { Clock } from '../src/common/clock';
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

/** Term 1, Primary 1 (two students) and Primary 2 (one student); fees: Tuition GH₵1,200 + PTA GH₵50. */
async function setUp(m: Client) {
  const year = (await m.post('/academic-years').send({ name: '2026/2027', startDate: '2026-09-01', endDate: '2027-07-31' }).expect(201)).body.data;
  const term = (await m.post(`/academic-years/${year.id}/terms`).send({ name: 'Term 1', startDate: '2026-09-01', endDate: '2026-12-18' }).expect(201)).body.data.terms[0];
  await m.post(`/academic-years/${year.id}/activate`).send({}).expect(200);
  const levels = (await m.post('/education-levels/standard').send({ stages: ['PRIMARY'] }).expect(200)).body.data;
  const p1 = (await m.post('/classes').send({ academicYearId: year.id, levelId: levels[0].id, name: 'P1 A' }).expect(201)).body.data;
  const p2 = (await m.post('/classes').send({ academicYearId: year.id, levelId: levels[1].id, name: 'P2 A' }).expect(201)).body.data;
  const admit = async (firstName: string, classId: string) =>
    (await m.post('/students').send({ firstName, lastName: 'Test', admissionDate: '2026-09-01', classId }).expect(201)).body.data.id as string;
  const s1 = await admit('Ama', p1.id);
  const s2 = await admit('Kofi', p1.id);
  const s3 = await admit('Efua', p2.id);

  const cats = (await m.post('/fee-categories').send({ name: 'Tuition' }).expect(201)).body.data;
  const all = (await m.post('/fee-categories').send({ name: 'PTA levy' }).expect(201)).body.data;
  const tuition = cats.find((c: { name: string }) => c.name === 'Tuition').id;
  const pta = all.find((c: { name: string }) => c.name === 'PTA levy').id;
  const structure = (
    await m
      .post('/fee-structures')
      .send({ termId: term.id, levelId: levels[0].id, name: 'Term 1 fees', dueDate: '2026-09-30', items: [{ categoryId: tuition, amountMinor: 120000 }, { categoryId: pta, amountMinor: 5000 }] })
      .expect(201)
  ).body.data;
  return { year, term, levels, p1, p2, s1, s2, s3, tuition, pta, structure };
}

const pay = (c: Client, body: Record<string, unknown>, key: string = randomUUID()) =>
  c.post('/payments').set('Idempotency-Key', key).send({ method: 'CASH', receivedOn: TODAY, ...body });

const invoiceOf = async (studentId: string) => prisma.invoice.findFirstOrThrow({ where: { studentId, status: { not: 'VOID' } } });

describe('fee structures and billing', () => {
  it('bills each student in the level once, with sequential invoice numbers', async () => {
    const m = await oakManager();
    const { structure, s1, s2, s3 } = await setUp(m);
    const first = (await m.post(`/fee-structures/${structure.id}/bill`).expect(200)).body.data;
    expect(first).toEqual({ created: 2, alreadyBilled: 0 });
    const again = (await m.post(`/fee-structures/${structure.id}/bill`).expect(200)).body.data;
    expect(again).toEqual({ created: 0, alreadyBilled: 2 });

    const invoices = await prisma.invoice.findMany({ orderBy: { number: 'asc' } });
    expect(invoices.map((i) => i.number)).toEqual(['INV-2026-000001', 'INV-2026-000002']);
    expect(invoices.map((i) => i.studentId).sort()).toEqual([s1, s2].sort());
    expect(invoices.every((i) => i.totalMinor === 125000 && i.currency === 'GHS')).toBe(true);
    expect(await prisma.invoice.count({ where: { studentId: s3 } })).toBe(0);
  });

  it('locks a structure’s fees once billed', async () => {
    const m = await oakManager();
    const { structure, tuition } = await setUp(m);
    await m.post(`/fee-structures/${structure.id}/bill`).expect(200);
    const res = await m.patch(`/fee-structures/${structure.id}`).send({ items: [{ categoryId: tuition, amountMinor: 1 }] }).expect(409);
    expect(res.body.error.code).toBe('STRUCTURE_BILLED');
    await m.delete(`/fee-structures/${structure.id}`).expect(409);
    await m.patch(`/fee-structures/${structure.id}`).send({ name: 'Renamed is fine' }).expect(200);
  });
});

describe('payments', () => {
  it('records a part payment, issues a receipt, and is safe to retry', async () => {
    const m = await oakManager();
    const { structure, s1 } = await setUp(m);
    await m.post(`/fee-structures/${structure.id}/bill`).expect(200);

    const key = randomUUID();
    const first = await pay(m, { studentId: s1, amountMinor: 50000 }, key).expect(201);
    expect(first.body.data).toMatchObject({ amountMinor: 50000, status: 'RECORDED', receipt: { number: 'RCT-2026-000001' } });
    expect(await invoiceOf(s1)).toMatchObject({ paidMinor: 50000, status: 'PARTIALLY_PAID' });

    // The browser retries after a timeout: same key, same body, same payment back.
    const retry = await pay(m, { studentId: s1, amountMinor: 50000 }, key).expect(200);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await prisma.payment.count()).toBe(1);
    expect((await invoiceOf(s1)).paidMinor).toBe(50000);

    expect((await pay(m, { studentId: s1, amountMinor: 1 }, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await m.post('/payments').send({ studentId: s1, amountMinor: 100, method: 'CASH', receivedOn: TODAY }).expect(400)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    await pay(m, { studentId: s1, amountMinor: 75000 }).expect(201);
    expect(await invoiceOf(s1)).toMatchObject({ paidMinor: 125000, status: 'PAID' });
    expect((await m.get(`/students/${s1}/account`).expect(200)).body.data.balanceMinor).toBe(0);
  });

  it('refuses overpayments, bad allocations, future dates and reused references', async () => {
    const m = await oakManager();
    const { structure, s1, s2 } = await setUp(m);
    await m.post(`/fee-structures/${structure.id}/bill`).expect(200);
    const inv1 = await invoiceOf(s1);
    const inv2 = await invoiceOf(s2);

    const over = await pay(m, { studentId: s1, amountMinor: 125001 }).expect(409);
    expect(over.body.error).toMatchObject({ code: 'OVERPAYMENT', details: { owedMinor: 125000 } });
    expect((await pay(m, { studentId: s1, amountMinor: 1000, allocations: [{ invoiceId: inv1.id, amountMinor: 999 }] }).expect(400)).body.error.code).toBe('ALLOCATION_MISMATCH');
    await pay(m, { studentId: s1, amountMinor: 1000, allocations: [{ invoiceId: inv2.id, amountMinor: 1000 }] }).expect(404);
    expect((await pay(m, { studentId: s1, amountMinor: 1000, receivedOn: '2026-10-14' }).expect(400)).body.error.code).toBe('FUTURE_DATE');
    await pay(m, { studentId: s1, amountMinor: 1000, allocations: [{ invoiceId: inv1.id, amountMinor: 1000 }] }).expect(201);

    await pay(m, { studentId: s1, amountMinor: 2000, method: 'MOBILE_MONEY', reference: 'MP261013.1234.A1' }).expect(201);
    const dup = await pay(m, { studentId: s2, amountMinor: 2000, method: 'MOBILE_MONEY', reference: 'mp261013.1234.a1' }).expect(409);
    expect(dup.body.error.code).toBe('DUPLICATE_REFERENCE');
    expect(await prisma.payment.count()).toBe(2);
  });

  it('two payments at the same moment can’t both pay the same balance', async () => {
    const m = await oakManager();
    const { structure, s1 } = await setUp(m);
    await m.post(`/fee-structures/${structure.id}/bill`).expect(200);
    const [a, b] = await Promise.all([pay(m, { studentId: s1, amountMinor: 125000 }), pay(m, { studentId: s1, amountMinor: 125000 })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await invoiceOf(s1)).toMatchObject({ paidMinor: 125000, status: 'PAID' });
    expect(await prisma.payment.count()).toBe(1);
  });

  it('reversal restores what is owed and voids the receipt, once', async () => {
    const m = await oakManager();
    const { structure, s1 } = await setUp(m);
    await m.post(`/fee-structures/${structure.id}/bill`).expect(200);
    const p = (await pay(m, { studentId: s1, amountMinor: 125000, method: 'BANK_TRANSFER', reference: 'GCB-778' }).expect(201)).body.data;

    const reversed = (await m.post(`/payments/${p.id}/reversals`).send({ reason: 'Cheque bounced' }).expect(200)).body.data;
    expect(reversed).toMatchObject({ status: 'REVERSED', reversalReason: 'Cheque bounced' });
    expect(reversed.receipt.voidedAt).not.toBeNull();
    expect(await invoiceOf(s1)).toMatchObject({ paidMinor: 0, status: 'ISSUED' });
    expect((await m.post(`/payments/${p.id}/reversals`).send({ reason: 'Again' }).expect(409)).body.error.code).toBe('ALREADY_REVERSED');

    // The reference can be used again once the original payment is reversed.
    await pay(m, { studentId: s1, amountMinor: 125000, method: 'BANK_TRANSFER', reference: 'GCB-778' }).expect(201);
    expect(await prisma.auditLog.count({ where: { action: 'payment.reverse' } })).toBe(1);
  });
});

describe('invoice corrections', () => {
  it('applies discounts and charges without going below what was paid', async () => {
    const m = await oakManager();
    const { structure, s1 } = await setUp(m);
    await m.post(`/fee-structures/${structure.id}/bill`).expect(200);
    const inv = await invoiceOf(s1);
    await pay(m, { studentId: s1, amountMinor: 100000 }).expect(201);

    const discounted = (await m.post(`/invoices/${inv.id}/adjustments`).send({ kind: 'DISCOUNT', amountMinor: 20000, reason: 'Sibling discount' }).expect(201)).body.data;
    expect(discounted).toMatchObject({ totalMinor: 105000, paidMinor: 100000, balanceMinor: 5000, status: 'PARTIALLY_PAID' });

    const tooMuch = await m.post(`/invoices/${inv.id}/adjustments`).send({ kind: 'WAIVER', amountMinor: 6000, reason: 'Too much' }).expect(409);
    expect(tooMuch.body.error.code).toBe('ADJUSTMENT_BELOW_PAID');

    const waived = (await m.post(`/invoices/${inv.id}/adjustments`).send({ kind: 'WAIVER', amountMinor: 5000, reason: 'PTA waived' }).expect(201)).body.data;
    expect(waived).toMatchObject({ totalMinor: 100000, status: 'PAID', balanceMinor: 0 });

    const charged = (await m.post(`/invoices/${inv.id}/adjustments`).send({ kind: 'CHARGE', amountMinor: 3000, reason: 'Lost library book' }).expect(201)).body.data;
    expect(charged).toMatchObject({ totalMinor: 103000, status: 'PARTIALLY_PAID' });
    expect(charged.adjustments).toHaveLength(3);
  });

  it('voids only unpaid invoices, and a voided invoice can be billed again', async () => {
    const m = await oakManager();
    const { structure, s1, s2 } = await setUp(m);
    await m.post(`/fee-structures/${structure.id}/bill`).expect(200);
    await pay(m, { studentId: s1, amountMinor: 1000 }).expect(201);
    expect((await m.post(`/invoices/${(await invoiceOf(s1)).id}/void`).send({ reason: 'Wrong level' }).expect(409)).body.error.code).toBe('HAS_PAYMENTS');

    const inv2 = await invoiceOf(s2);
    await m.post(`/invoices/${inv2.id}/void`).send({ reason: 'Billed in error' }).expect(200);
    expect((await m.post(`/fee-structures/${structure.id}/bill`).expect(200)).body.data).toEqual({ created: 1, alreadyBilled: 1 });
    await pay(m, { studentId: s2, amountMinor: 1000, allocations: [{ invoiceId: inv2.id, amountMinor: 1000 }] }).expect(409);
  });

  it('creates one-off invoices', async () => {
    const m = await oakManager();
    const { term, s3, tuition } = await setUp(m);
    const inv = (await m.post('/invoices').send({ studentId: s3, termId: term.id, items: [{ categoryId: tuition, description: 'Excursion', amountMinor: 8000 }] }).expect(201)).body.data;
    expect(inv).toMatchObject({ totalMinor: 8000, fromStructure: false, items: [expect.objectContaining({ description: 'Excursion' })] });
  });
});

describe('reports', () => {
  it('summarises a term and lists who owes what', async () => {
    const m = await oakManager();
    const { term, structure, s1, s2 } = await setUp(m);
    await m.post(`/fee-structures/${structure.id}/bill`).expect(200);
    await pay(m, { studentId: s1, amountMinor: 125000, method: 'MOBILE_MONEY', reference: 'X1' }).expect(201);
    await pay(m, { studentId: s2, amountMinor: 25000 }).expect(201);

    const summary = (await m.get(`/finance/summary?termId=${term.id}`).expect(200)).body.data;
    expect(summary).toMatchObject({ billedMinor: 250000, collectedMinor: 150000, outstandingMinor: 100000, collectionRate: 60, byMethod: { MOBILE_MONEY: 125000, CASH: 25000 } });
    expect(summary.byCategory).toEqual([{ category: 'Tuition', amountMinor: 240000 }, { category: 'PTA levy', amountMinor: 10000 }]);

    const arrears = (await m.get(`/finance/arrears?termId=${term.id}`).expect(200)).body;
    expect(arrears.data).toEqual([expect.objectContaining({ name: 'Kofi Test', owedMinor: 100000, className: 'P1 A' })]);
    expect(arrears.meta.totalOwedMinor).toBe(100000);
  });
});

describe('who can see and do what', () => {
  it('lets the accountant take payments but keeps teachers out', async () => {
    const m = await oakManager();
    const { structure, s1 } = await setUp(m);
    await m.post(`/fee-structures/${structure.id}/bill`).expect(200);
    const accountant = (await prisma.role.findFirstOrThrow({ where: { schoolId: f.oakwood.id, key: 'accountant' } })).id;
    await m.put(`/staff/${f.carol.membership.id}/roles`).send({ roleIds: [accountant] }).expect(200);
    const carol = await as(HOSTS.oakwood, 'carol@example.test');
    await pay(carol, { studentId: s1, amountMinor: 1000 }).expect(201);

    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    await tom.get('/invoices').expect(403);
    await tom.get(`/students/${s1}/account`).expect(403);
    await pay(tom, { studentId: s1, amountMinor: 1000 }).expect(403);
  });

  it('parents see their own child’s fees and receipts only', async () => {
    const m = await oakManager();
    const { structure, s1, s2 } = await setUp(m);
    await m.post(`/fee-structures/${structure.id}/bill`).expect(200);
    const mine = (await pay(m, { studentId: s1, amountMinor: 50000 }).expect(201)).body.data;
    const theirs = (await pay(m, { studentId: s2, amountMinor: 50000 }).expect(201)).body.data;

    const linked = await m.post(`/students/${s1}/guardians`).send({ guardian: { fullName: 'Akua', email: 'akua@example.test' }, relationship: 'MOTHER' }).expect(201);
    await m.post(`/guardians/${linked.body.data[0].guardianId}/invite`).expect(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'akua@example.test' } });
    const token = await app.get(AuthTokensService).issue(user.id, 'ACTIVATION', ACTIVATION_TTL_MS);
    await client(app, HOSTS.oakwood).post('/auth/activate').send({ token, password: PASSWORD }).expect(204);
    const parent = await as(HOSTS.oakwood, 'akua@example.test');

    const fees = (await parent.get(`/portal/children/${s1}/fees`).expect(200)).body.data;
    expect(fees).toMatchObject({ balanceMinor: 75000, currency: 'GHS' });
    expect(fees.invoices).toHaveLength(1);
    const receipt = (await parent.get(`/portal/children/${s1}/receipts/${mine.receipt.id}`).expect(200)).body.data;
    expect(receipt).toMatchObject({ number: mine.receipt.number, recordedBy: null });

    await parent.get(`/portal/children/${s2}/fees`).expect(404);
    await parent.get(`/portal/children/${s1}/receipts/${theirs.receipt.id}`).expect(404);
    await parent.get(`/receipts/${mine.receipt.id}`).expect(403);
  });

  it("another school can't read or touch this school's money", async () => {
    const m = await oakManager();
    const { structure, s1, term } = await setUp(m);
    await m.post(`/fee-structures/${structure.id}/bill`).expect(200);
    const p = (await pay(m, { studentId: s1, amountMinor: 1000 }).expect(201)).body.data;
    const inv = await invoiceOf(s1);

    const maple = await as(HOSTS.maple, 'mo@example.test');
    await maple.get(`/invoices/${inv.id}`).expect(404);
    await maple.get(`/payments/${p.id}`).expect(404);
    await maple.get(`/receipts/${p.receipt.id}`).expect(404);
    await maple.get(`/students/${s1}/account`).expect(404);
    await maple.post(`/fee-structures/${structure.id}/bill`).expect(404);
    await maple.post(`/invoices/${inv.id}/void`).send({ reason: 'hijack' }).expect(404);
    await maple.post(`/invoices/${inv.id}/adjustments`).send({ kind: 'WAIVER', amountMinor: 100, reason: 'hijack' }).expect(404);
    await maple.post(`/payments/${p.id}/reversals`).send({ reason: 'hijack' }).expect(404);
    await pay(maple, { studentId: s1, amountMinor: 1000 }).expect(404);
    await pay(maple, { studentId: f.mapleStudent.id, amountMinor: 1000, allocations: [{ invoiceId: inv.id, amountMinor: 1000 }] }).expect(404);
    await maple.get(`/finance/summary?termId=${term.id}`).expect(404);
    expect((await maple.get('/invoices').expect(200)).body.data).toEqual([]);
    expect(await invoiceOf(s1)).toMatchObject({ paidMinor: 1000, status: 'PARTIALLY_PAID' });
  });

  it('the database refuses a payment allocated to another student’s invoice', async () => {
    const m = await oakManager();
    const { structure, s1, s2 } = await setUp(m);
    await m.post(`/fee-structures/${structure.id}/bill`).expect(200);
    const p = (await pay(m, { studentId: s1, amountMinor: 1000 }).expect(201)).body.data;
    const other = await invoiceOf(s2);
    await expect(
      prisma.paymentAllocation.create({ data: { schoolId: f.oakwood.id, paymentId: p.id, invoiceId: other.id, studentId: s1, amountMinor: 1 } }),
    ).rejects.toThrow();
  });
});
