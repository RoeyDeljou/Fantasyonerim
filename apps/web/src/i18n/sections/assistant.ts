import { defineSection } from '../section';

/**
 * "Ask Alfie" — FPL Lad's AI assistant: the floating launcher on the tabs and the in-app panel. Lazy (only the
 * assistant chunk imports it), so nothing here is in he.ts / en.ts. "Ask Alfie" is the partner's brand name, so it
 * reads the same in both languages.
 */
export const assistant = defineSection(
  {
    launcher: 'Ask Alfie',
    launcherLabel: 'Ask Alfie – עוזר ה-AI של FPL Lad',
    opening: 'פותחים את Alfie…',
    panelTitle: 'Alfie',
    by: 'מבית FPL Lad',
    dialogLabel: 'Alfie – עוזר ה-AI של FPL Lad',
    frameTitle: 'Alfie, עוזר ה-AI של FPL Lad',
    openInTab: 'פתיחה בלשונית חדשה',
    close: 'סגירה',
    loading: 'טוענים את Alfie…',
    notLoading: 'לא נטען?',
    openSite: 'פתחו באתר \u2066fpl-lad.com\u2069',
  },
  {
    launcher: 'Ask Alfie',
    launcherLabel: "Ask Alfie – FPL Lad's AI assistant",
    opening: 'Opening Alfie…',
    panelTitle: 'Alfie',
    by: 'by FPL Lad',
    dialogLabel: "Alfie – FPL Lad's AI assistant",
    frameTitle: "Alfie, FPL Lad's AI assistant",
    openInTab: 'Open in a new tab',
    close: 'Close',
    loading: 'Loading Alfie…',
    notLoading: 'Not loading?',
    openSite: 'Open in fpl-lad.com',
  },
);
