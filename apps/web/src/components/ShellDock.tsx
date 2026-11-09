'use client';

import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * The strip of the tab shell right above the tab bar (components/AppShell.tsx). Bottom-anchored UI — the Thread's
 * reply bar, the tables' floating "My team" / "Join" button — is portalled here instead of being
 * `position: fixed`, so it is laid out by the non-scrolling shell and can never drift while the content scrolls
 * (iOS 26 WebKit). In-flow children take space above the bar (the scroller shrinks, nothing hides behind them);
 * floating ones use `absolute bottom-full` and hover over the end of the content.
 */
const DockContext = createContext<HTMLElement | null>(null);

export const ShellDockProvider = DockContext.Provider;

/** Renders `children` into the shell's dock; nothing until the shell has mounted it (or outside the shell). */
export function ShellDock({ children }: { children: ReactNode }) {
  const el = useContext(DockContext);
  return el ? createPortal(children, el) : null;
}
