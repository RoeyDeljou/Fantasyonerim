/** FPL / PL image CDNs (public, CORS-free <img> loads). The browser never calls the FPL *API*. */
export const fplImage = {
  shirt: (teamCode: number, goalkeeper: boolean) =>
    `https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_${teamCode}${goalkeeper ? '_1' : ''}-66.png`,
  /** An SVG since the PL's 2025 CDN move (`premierleague25/`); `object-contain` in ImageWithFallback sizes it. */
  badge: (teamCode: number) => `https://resources.premierleague.com/premierleague25/badges/${teamCode}.svg`,
  /** No `p` prefix on the new CDN path. */
  photo: (photoCode: string) =>
    `https://resources.premierleague.com/premierleague25/photos/players/110x140/${photoCode.replace(/\.(png|jpg)$/i, '')}.png`,
};
