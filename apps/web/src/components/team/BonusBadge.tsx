'use client';

import { useI18n } from '@/i18n';
import { Badge, cx } from '../ui';

/** "+3 bonus" — dashed/amber while provisional (bonus not final until every fixture is finished). */
export function BonusBadge({ n, confirmed }: { n: number; confirmed: boolean }) {
  const { t } = useI18n();
  if (n <= 0) return null;
  return (
    <Badge
      tone={confirmed ? 'success' : 'warning'}
      className={cx(!confirmed && 'border border-dashed border-warning')}
    >
      <bdi dir="ltr">+{n}</bdi> {confirmed ? t.live.bonusLabel : t.live.bonusProvLabel}
    </Badge>
  );
}
