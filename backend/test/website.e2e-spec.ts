import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
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
const visitor = (host = HOSTS.oakwood) => client(app, host);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

async function liveSite(m: Client) {
  await m.put('/website/settings').send({ siteEnabled: true, siteTagline: 'Learning with purpose' }).expect(200);
}

describe('public site', () => {
  it('is hidden until switched on, and shows only published pages', async () => {
    const m = await as(HOSTS.oakwood, 'maya@example.test');
    await visitor().get('/public/site').expect(404);
    await liveSite(m);

    const about = (await m.post('/website/pages').send({ title: 'About us', body: '## Our story\nFounded in 1998.' }).expect(201)).body.data;
    expect(about.slug).toBe('about-us');
    const home = (await m.post('/website/pages').send({ title: 'Welcome', slug: 'home', body: 'Welcome to Oakwood.', showInNav: false }).expect(201)).body.data;
    await visitor().get('/public/pages/about-us').expect(404); // still a draft

    await m.put(`/website/pages/${about.id}/status`).send({ status: 'PUBLISHED' }).expect(200);
    await m.put(`/website/pages/${home.id}/status`).send({ status: 'PUBLISHED' }).expect(200);
    const site = (await visitor().get('/public/site').expect(200)).body.data;
    expect(site.school).toMatchObject({ name: 'Oakwood Academy', siteTagline: 'Learning with purpose' });
    expect(site.nav).toEqual([{ slug: 'about-us', title: 'About us' }]);
    expect(site.home).toMatchObject({ body: 'Welcome to Oakwood.' });
    await visitor().get('/public/pages/about-us').expect(200);

    await m.put(`/website/pages/${about.id}/status`).send({ status: 'DRAFT' }).expect(200);
    await visitor().get('/public/pages/about-us').expect(404);
    expect((await m.post('/website/pages').send({ title: 'News', slug: 'news', body: 'x' }).expect(400)).body.error.code).toBe('SLUG_RESERVED');
  });

  it('lists published news newest first and upcoming events soonest first', async () => {
    const m = await as(HOSTS.oakwood, 'maya@example.test');
    await liveSite(m);
    const publish = async (body: Record<string, unknown>) => {
      const p = (await m.post('/website/posts').send(body).expect(201)).body.data;
      await m.put(`/website/posts/${p.id}/status`).send({ status: 'PUBLISHED' }).expect(200);
      return p;
    };
    await publish({ kind: 'NEWS', title: 'First news', body: 'a' });
    await new Promise((r) => setTimeout(r, 10));
    await publish({ kind: 'NEWS', title: 'Second news', body: 'b' });
    await m.post('/website/posts').send({ kind: 'NEWS', title: 'Draft news', body: 'c' }).expect(201);
    await publish({ kind: 'EVENT', title: 'Later event', body: 'x', eventStartsAt: '2099-06-01T09:00:00Z' });
    await publish({ kind: 'EVENT', title: 'Sooner event', body: 'x', eventStartsAt: '2099-03-01T09:00:00Z' });
    await publish({ kind: 'EVENT', title: 'Past event', body: 'x', eventStartsAt: '2000-01-01T09:00:00Z' });
    await m.post('/website/posts').send({ kind: 'EVENT', title: 'No date', body: 'x' }).expect(400);

    const news = (await visitor().get('/public/posts?kind=NEWS').expect(200)).body.data.map((p: { title: string }) => p.title);
    expect(news).toEqual(['Second news', 'First news']);
    const events = (await visitor().get('/public/posts?kind=EVENT').expect(200)).body.data.map((p: { title: string }) => p.title);
    expect(events).toEqual(['Sooner event', 'Later event']);
    await visitor().get('/public/posts/draft-news').expect(404);
  });

  it('serves uploaded images and refuses anything that isn’t one', async () => {
    const m = await as(HOSTS.oakwood, 'maya@example.test');
    await liveSite(m);
    const img = (await m.post('/website/media').field('altText', 'Our school gate').attach('file', png, { filename: 'gate.png', contentType: 'image/png' }).expect(201)).body.data;
    const res = await visitor().get(`/public/media/${img.id}`).expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toContain('public');
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(50, 32)]);
    expect((await m.post('/website/media').field('altText', 'x').attach('file', pdf, { filename: 'x.png', contentType: 'image/png' }).expect(400)).body.error.code).toBe('UNSUPPORTED_FILE');
  });
});

describe('contact form', () => {
  it('stores real messages, quietly drops bots, and needs a same-site form', async () => {
    const m = await as(HOSTS.oakwood, 'maya@example.test');
    await liveSite(m);
    const started = Date.now() - 10_000;
    const ok = { name: 'Kwame Owusu', email: 'kwame@example.test', subject: 'Admissions', message: 'Do you have places in P3?', startedAt: started };

    await visitor().post('/public/contact').send(ok).expect(202);
    await visitor().post('/public/contact').send({ ...ok, website: 'http://spam.example' }).expect(202);
    await visitor().post('/public/contact').send({ ...ok, startedAt: Date.now() }).expect(202);
    await request(app.getHttpServer()).post('/api/v1/public/contact').set('Host', HOSTS.oakwood).send(ok).expect(403);
    expect(await prisma.contactMessage.count()).toBe(1);

    const inbox = (await m.get('/website/messages?handled=false').expect(200)).body;
    expect(inbox.data).toEqual([expect.objectContaining({ name: 'Kwame Owusu', subject: 'Admissions' })]);
    expect((await m.get('/notifications').expect(200)).body.data[0]).toMatchObject({ kind: 'contact' });
    await m.post(`/website/messages/${inbox.data[0].id}/handled`).expect(200);
    expect((await m.get('/website/settings').expect(200)).body.data.unhandledMessages).toBe(0);

    const tom = await as(HOSTS.oakwood, 'tom@example.test');
    await tom.get('/website/messages').expect(403);
  });
});

describe('isolation and privacy', () => {
  it('never shows one school’s content on another school’s site, and contains no private records', async () => {
    const m = await as(HOSTS.oakwood, 'maya@example.test');
    await liveSite(m);
    const page = (await m.post('/website/pages').send({ title: 'Admissions', body: 'Apply now.' }).expect(201)).body.data;
    await m.put(`/website/pages/${page.id}/status`).send({ status: 'PUBLISHED' }).expect(200);

    const mo = await as(HOSTS.maple, 'mo@example.test');
    await mo.put('/website/settings').send({ siteEnabled: true }).expect(200);
    await visitor(HOSTS.maple).get('/public/pages/admissions').expect(404);
    await mo.patch(`/website/pages/${page.id}`).send({ title: 'Hijacked' }).expect(404);
    await mo.put(`/website/pages/${page.id}/status`).send({ status: 'DRAFT' }).expect(404);

    const everything = JSON.stringify((await visitor().get('/public/site').expect(200)).body);
    for (const secret of [f.oakStudent.firstName, f.oakStudent.admissionNumber, 'maya@example.test', 'tom@example.test']) {
      expect(everything).not.toContain(secret);
    }
  });
});
