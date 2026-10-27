import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPost, makeImage, upload } from './communityFixtures.js';
import { MemoryMediaStore } from './fakes.js';
import type { FakeFplService } from './fakeFpl.js';
import {
  adminToken,
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
} from './helpers.js';

const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;
let media: MemoryMediaStore;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  media = new MemoryMediaStore();
  ({ app, fpl } = await buildTestApp(prisma, { media }));
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function photoPost(token: string) {
  const up = await upload(app, token, await makeImage('jpeg', 40, 30));
  const post = await createPost(app, token, { text: 'my transfers', uploadId: up.uploadId });
  const key = [...media.objects.keys()].find((k) => k.endsWith(`${up.uploadId}.webp`));
  if (key === undefined) throw new Error('upload not stored');
  return { post, key, uploadId: up.uploadId };
}

describe('deleted posts take their photo offline', () => {
  it('author deleting a post removes the stored file and the upload row', async () => {
    const fan = await registerUser(app, fpl, 2001);
    const { post, key, uploadId } = await photoPost(fan.token);
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/community/posts/${post.id}`,
      headers: bearer(fan.token),
    });
    expect(del.statusCode).toBe(204);
    expect(media.objects.has(key)).toBe(false);
    expect(media.deleted).toContain(key);
    expect(await prisma.upload.findUnique({ where: { id: uploadId } })).toBeNull();
  });

  it('an admin removing a reported post removes its photo too', async () => {
    const fan = await registerUser(app, fpl, 2002);
    const other = await registerUser(app, fpl, 2003);
    const admin = await adminToken(app, prisma);
    const { post, key } = await photoPost(fan.token);
    const rep = await app.inject({
      method: 'POST',
      url: `/v1/community/posts/${post.id}/report`,
      headers: bearer(other.token),
      payload: { reason: 'sexual' },
    });
    expect(rep.statusCode).toBe(204);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/reports/${encodeURIComponent(`post:${post.id}`)}/resolve`,
      headers: bearer(admin),
      payload: { action: 'remove' },
    });
    expect(res.statusCode).toBe(204);
    expect(media.objects.has(key)).toBe(false);
  });

  it('the hourly cleanup purges images of deleted posts that the immediate purge missed', async () => {
    const fan = await registerUser(app, fpl, 2004);
    const { post, key } = await photoPost(fan.token);
    // Simulate a storage outage during the delete: mark deleted directly, file still there.
    await prisma.communityPost.update({ where: { id: post.id }, data: { deletedAt: new Date() } });
    expect(media.objects.has(key)).toBe(true);
    expect(await app.jobs.run('cleanup', { force: true })).toBe('ok');
    expect(media.objects.has(key)).toBe(false);
  });

  it('live posts keep their photo', async () => {
    const fan = await registerUser(app, fpl, 2005);
    const { key } = await photoPost(fan.token);
    expect(await app.jobs.run('cleanup', { force: true })).toBe('ok');
    expect(media.objects.has(key)).toBe(true);
  });
});

describe('legacy names', () => {
  it('a name stored before the direction-control rule still serializes on /v1/me', async () => {
    const fan = await registerUser(app, fpl, 2101);
    await prisma.user.update({ where: { id: fan.user.id }, data: { name: 'Legacy \u202Ename' } });
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(fan.token) });
    expect(me.statusCode).toBe(200);
  });
});
