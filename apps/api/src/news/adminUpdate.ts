import { randomUUID } from 'node:crypto';
import type { NewsLinks } from '@fant/shared';
import type { PrismaClient, Upload } from '@prisma/client';
import type { Clock } from '../context.js';
import { EMPTY_LINKS, type NewsItemWithMedia } from './serialize.js';

export interface AdminUpdateInput {
  title: string | null;
  text: string;
  links?: { [K in keyof NewsLinks]?: NewsLinks[K] | undefined } | undefined;
  /** A claimed upload shown as the card's image. */
  image?: Pick<Upload, 'url' | 'width' | 'height'> | null;
}

/**
 * Creates an `admin_update` News item (the manual fallback post and the live broadcast's News target).
 * Does NOT notify anyone: the caller decides which push (if any) announces it.
 */
export async function createAdminUpdate(
  deps: { prisma: PrismaClient; clock: Clock },
  input: AdminUpdateInput,
): Promise<NewsItemWithMedia> {
  const image = input.image ?? null;
  return deps.prisma.newsItem.create({
    data: {
      dedupeKey: `admin_update:${randomUUID()}`,
      source: 'admin_update',
      title: input.title,
      text: input.text,
      links: { ...EMPTY_LINKS, ...input.links },
      publishedAt: deps.clock.now(),
      ...(image === null
        ? {}
        : {
            media: {
              create: [
                {
                  order: 0,
                  kind: 'image',
                  url: image.url,
                  posterUrl: null,
                  width: image.width,
                  height: image.height,
                  sourceUrl: image.url,
                },
              ],
            },
          }),
    },
    include: { media: { orderBy: { order: 'asc' } } },
  });
}
