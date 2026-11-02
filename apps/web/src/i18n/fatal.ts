/**
 * The few strings the last-resort error screen (app/global-error.tsx) needs, in both languages. They live here,
 * not only in he.ts / en.ts, so that screen doesn't pull both full dictionaries into every page's first load —
 * he.ts and en.ts reuse these values, so each string is still written once.
 */
export const fatal = {
  he: {
    title: 'משהו השתבש',
    generic: 'קרתה שגיאה לא צפויה. נסו שוב.',
    staleTitle: 'האפליקציה התעדכנה',
    staleBody: 'יצאה גרסה חדשה של האפליקציה בזמן שהיא הייתה פתוחה. רענון יטען אותה.',
    reload: 'רענון האפליקציה',
  },
  en: {
    title: 'Something went wrong',
    generic: 'Something unexpected happened. Please try again.',
    staleTitle: 'The app was updated',
    staleBody: 'A new version came out while the app was open. Refreshing loads it.',
    reload: 'Refresh the app',
  },
} as const;
