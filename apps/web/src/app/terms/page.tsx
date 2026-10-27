import type { Metadata } from 'next';
import { TermsScreen } from '@/screens/Terms';

export const metadata: Metadata = { title: 'כללי הקהילה ופרטיות · Community rules & privacy' };

export default function Page() {
  return <TermsScreen />;
}
