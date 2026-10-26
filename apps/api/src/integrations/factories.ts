import {
  buildInstagramConnectUrl,
  completeInstagramConnect,
  createAppleLinkResolver,
  createInstagramPostsSource,
  createInstagramStoriesSource,
  createPodcastSource,
  createSpotifyLinkResolver,
  createXSource,
  resolveEpisodeLinks,
  resolveXUser,
} from '@fant/integrations';

/**
 * Every @fant/integrations entry point the API uses, injectable so tests swap in fakes
 * (`buildApp({ integrations: { createPodcastSource: fake } })`).
 */
export interface IntegrationFactories {
  createPodcastSource: typeof createPodcastSource;
  createAppleLinkResolver: typeof createAppleLinkResolver;
  createSpotifyLinkResolver: typeof createSpotifyLinkResolver;
  resolveEpisodeLinks: typeof resolveEpisodeLinks;
  createInstagramPostsSource: typeof createInstagramPostsSource;
  createInstagramStoriesSource: typeof createInstagramStoriesSource;
  buildInstagramConnectUrl: typeof buildInstagramConnectUrl;
  completeInstagramConnect: typeof completeInstagramConnect;
  createXSource: typeof createXSource;
  resolveXUser: typeof resolveXUser;
}

export const realIntegrations: IntegrationFactories = {
  createPodcastSource,
  createAppleLinkResolver,
  createSpotifyLinkResolver,
  resolveEpisodeLinks,
  createInstagramPostsSource,
  createInstagramStoriesSource,
  buildInstagramConnectUrl,
  completeInstagramConnect,
  createXSource,
  resolveXUser,
};
