/**
 * Browser-chrome colours for <meta name="theme-color">. Mirrors `--theme-color` in theme.css (the only other
 * place colours live); meta tags are read before any CSS loads, so they need literal values.
 */
export const THEME_META_COLORS = { light: '#c7efd5', dark: '#150a1f' } as const;
