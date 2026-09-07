import type { ReactNode } from 'react';

import { AppShell } from '@/components/app-shell';
import { RequireAuth } from '@/components/require-auth';

/**
 * The layout for everything behind the sign-in.
 *
 * A route group — `(app)` contributes nothing to the URL — so `/pos` is `/pos`
 * and not `/app/pos`, while every page inside still shares one guard and one
 * shell. `/login` lives outside the group precisely because its guard answers
 * the opposite way.
 *
 * This is a server component that renders two client components. It holds no
 * state of its own, so there is nothing here to hydrate incorrectly.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
}
