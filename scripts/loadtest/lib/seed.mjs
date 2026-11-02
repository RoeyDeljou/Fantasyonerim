// Seeds the load-test database: ~150 registered users (each with a real session token and an FPL Team ID in
// the scaled demo league), the league + captain battle settings, ~200 news items with media, live stories,
// community posts with likes/comments, and push subscriptions (so live_alerts does its full per-user work).
import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { LT_FIRST_ENTRY_ID } from './fpl.mjs';

const DAY = 24 * 60 * 60 * 1000;
const MEDIA = 'https://fantasyonerim.vercel.app/media';

const hashToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * @param {string} databaseUrl
 * @param {{ users?: number, news?: number, posts?: number, leagueId: number, captainPlayerId: number }} options
 * @returns {Promise<{ users: { id: string, token: string, entryId: number }[], postIds: string[], newsIds: string[] }>}
 */
export async function seed(databaseUrl, options) {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const userCount = options.users ?? 150;
  const newsCount = options.news ?? 200;
  const postCount = options.posts ?? 120;
  const now = Date.now();
  try {
    await prisma.appSettings.upsert({
      where: { id: 1 },
      update: { leagueId: options.leagueId, leagueName: 'Fantasyonerim League' },
      create: { id: 1, leagueId: options.leagueId, leagueName: 'Fantasyonerim League' },
    });

    // ---- users + sessions ----
    const users = [];
    const userRows = [];
    const sessionRows = [];
    const subRows = [];
    for (let i = 0; i < userCount; i += 1) {
      const id = `ltuser${String(i).padStart(4, '0')}`;
      const token = randomBytes(32).toString('base64url');
      const entryId = LT_FIRST_ENTRY_ID + i;
      users.push({ id, token, entryId });
      userRows.push({
        id,
        name: `Fan ${i + 1}`,
        entryId,
        teamName: `Team ${i + 1}`,
        locale: i % 5 === 0 ? 'en' : 'he',
        createdAt: new Date(now - (i + 1) * DAY),
      });
      sessionRows.push({
        userId: id,
        tokenHash: hashToken(token),
        createdAt: new Date(now - DAY),
        lastUsedAt: new Date(now - 10 * 60 * 1000),
        expiresAt: new Date(now + 300 * DAY),
        userAgent: 'loadtest',
      });
      // Two of three users have notifications on.
      if (i % 3 !== 2) {
        subRows.push({
          endpoint: `https://push.example.invalid/sub/${id}`,
          p256dh: randomBytes(65).toString('base64url'),
          auth: randomBytes(16).toString('base64url'),
          userId: id,
        });
      }
    }
    await prisma.user.createMany({ data: userRows });
    await prisma.session.createMany({ data: sessionRows });
    await prisma.pushSubscription.createMany({ data: subRows });

    // ---- captain battle: the hosts' teams + the community pick ----
    await prisma.captainBattle.create({
      data: {
        event: 9,
        entries: {
          create: [
            { order: 0, label: 'Dor', kind: 'CUSTOM', source: 'ENTRY', entryId: LT_FIRST_ENTRY_ID },
            { order: 1, label: 'Itay', kind: 'CUSTOM', source: 'ENTRY', entryId: LT_FIRST_ENTRY_ID + 1 },
            {
              order: 2,
              label: 'Community',
              kind: 'COMMUNITY',
              source: 'PLAYER',
              playerId: options.captainPlayerId,
            },
          ],
        },
      },
    });

    // ---- news: episodes, Instagram posts (1–3 images), X posts, YouTube; plus live stories ----
    const newsIds = [];
    const sources = [
      'podcast',
      'instagram_post',
      'instagram_post',
      'x_post',
      'youtube_video',
      'youtube_short',
    ];
    const caption = 'מה עושים עם הקפטן השבוע? ⚽️ '.repeat(8);
    for (let i = 0; i < newsCount + 6; i += 1) {
      const story = i >= newsCount;
      const source = story ? 'instagram_story' : (sources[i % sources.length] ?? 'x_post');
      const publishedAt = story
        ? new Date(now - (i - newsCount + 1) * 60 * 60 * 1000)
        : new Date(now - i * 9 * 60 * 60 * 1000);
      const mediaCount = source === 'instagram_post' ? 1 + (i % 3) : source === 'instagram_story' ? 1 : 0;
      const item = await prisma.newsItem.create({
        data: {
          dedupeKey: `lt:${source}:${i}`,
          source,
          title: source === 'podcast' ? `פרק ${200 - i}: תחזית למחזור` : null,
          text: source === 'podcast' ? `${caption}\n${caption}` : caption,
          links:
            source === 'podcast'
              ? {
                  spotify: `https://open.spotify.com/episode/ep${i}`,
                  apple: `https://podcasts.apple.com/podcast/id1?i=${i}`,
                  audio: `https://anchor.fm/s/105778688/podcast/play/${i}.m4a`,
                  youtube: `https://www.youtube.com/watch?v=lt${i}`,
                }
              : { instagram: `https://www.instagram.com/p/lt${i}/` },
          podcast:
            source === 'podcast'
              ? { episodeNumber: 200 - i, seasonNumber: 2, durationSec: 3600 + i }
              : undefined,
          publishedAt,
          expiresAt: story ? new Date(publishedAt.getTime() + DAY) : null,
          media: {
            create: Array.from({ length: mediaCount }, (_, m) => ({
              order: m,
              kind: 'image',
              url: `${MEDIA}/instagram/lt${i}/${m}.jpg`,
              width: 1080,
              height: 1350,
              sourceUrl: `https://scontent.cdninstagram.com/lt${i}/${m}.jpg`,
              storageKey: `instagram/lt${i}/${m}.jpg`,
            })),
          },
        },
        select: { id: true },
      });
      newsIds.push(item.id);
    }

    // ---- community ----
    const postIds = [];
    for (let i = 0; i < postCount; i += 1) {
      const author = users[(i * 7) % users.length];
      const post = await prisma.communityPost.create({
        data: {
          authorId: author.id,
          text: `פוסט ${i}: ${caption.slice(0, 120)}`,
          createdAt: new Date(now - i * 47 * 60 * 1000),
          likeCount: 0,
          commentCount: 0,
        },
        select: { id: true },
      });
      postIds.push(post.id);
    }
    const likes = [];
    const comments = [];
    for (let i = 0; i < postIds.length; i += 1) {
      for (let k = 0; k < (i % 9) + 1; k += 1) {
        likes.push({ postId: postIds[i], userId: users[(i + k * 11) % users.length].id });
      }
      for (let k = 0; k < i % 4; k += 1) {
        comments.push({
          postId: postIds[i],
          authorId: users[(i + k * 5) % users.length].id,
          text: `תגובה ${k}`,
          createdAt: new Date(now - i * 47 * 60 * 1000 + (k + 1) * 60_000),
        });
      }
    }
    await prisma.postLike.createMany({ data: likes, skipDuplicates: true });
    await prisma.comment.createMany({ data: comments });
    await prisma.$executeRawUnsafe(`
      UPDATE "CommunityPost" p SET
        "likeCount" = (SELECT count(*) FROM "PostLike" l WHERE l."postId" = p.id),
        "commentCount" = (SELECT count(*) FROM "Comment" c WHERE c."postId" = p.id)`);
    // A few blocks, so the feed takes the notIn path for those viewers.
    await prisma.userBlock.createMany({
      data: [
        { blockerId: users[3].id, blockedId: users[10].id },
        { blockerId: users[4].id, blockedId: users[11].id },
      ],
    });

    // Content jobs have run recently (their state is "done"); FPL jobs are due — as on a live Saturday.
    return { users, postIds, newsIds };
  } finally {
    await prisma.$disconnect();
  }
}
