import {
  buildInstagramConnectUrl,
  completeInstagramConnect,
  createAppleLinkResolver,
  createInstagramPostsSource,
  createInstagramStoriesSource,
  createPodcastSource,
  createSpotifyLinkResolver,
  createXPublisher,
  createXSource,
  createYouTubeLinkResolver,
  createYouTubeSource,
  fetchSpotifyEpisodeThumbnail,
  resolveEpisodeLinks,
  resolveXUser,
  resolveYouTubeChannel,
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
  createXPublisher: typeof createXPublisher;
  fetchSpotifyEpisodeThumbnail: typeof fetchSpotifyEpisodeThumbnail;
  resolveYouTubeChannel: typeof resolveYouTubeChannel;
  createYouTubeSource: typeof createYouTubeSource;
  createYouTubeLinkResolver: typeof createYouTubeLinkResolver;
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
  createXPublisher,
  fetchSpotifyEpisodeThumbnail,
  resolveYouTubeChannel,
  createYouTubeSource,
  createYouTubeLinkResolver,
};
