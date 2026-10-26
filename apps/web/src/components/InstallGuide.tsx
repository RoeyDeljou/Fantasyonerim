'use client';

import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { AddSquareIcon, CheckIcon, ShareIcon } from './icons';

/**
 * The iPhone "Add to Home Screen" steps (Safari). Used by Profile → Install, the push prompt and Notifications.
 * The closing "notifications need install" note is skipped where the caller already says exactly that.
 */
export function IosInstallSteps({ showNote = true }: { showNote?: boolean }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3">
      <p className="text-sm font-bold text-ink">{t.profile.iosStepsTitle}</p>
      <ol className="flex flex-col gap-2 text-sm text-ink">
        <IosStep n={1} icon={<ShareIcon size={18} />}>
          {t.profile.iosStep1}
        </IosStep>
        <IosStep n={2} icon={<AddSquareIcon size={18} />}>
          {t.profile.iosStep2}
        </IosStep>
        <IosStep n={3} icon={<CheckIcon size={18} />}>
          {t.profile.iosStep3}
        </IosStep>
      </ol>
      {showNote && <p className="text-xs text-muted">{t.profile.iosNote}</p>}
    </div>
  );
}

function IosStep({ n, icon, children }: { n: number; icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-on-primary">
        {n}
      </span>
      <span className="flex-1">{children}</span>
      <span className="text-primary">{icon}</span>
    </li>
  );
}
