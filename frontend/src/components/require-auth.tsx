'use client';

/**
 * The route guard, applied.
 *
 * All the deciding is in `@/lib/route-guard`, which is a pure function with its
 * own suite. What is left here is the part that cannot be tested without a
 * router, and it is deliberately small: read the session, ask, and do the one
 * thing the answer says.
 *
 * Mounted from `src/app/(app)/layout.tsx`, so every page in the group is covered
 * by one guard rather than each page repeating it — and so a page added later
 * cannot forget. `/login` sits outside the group and is guarded by
 * `loginDecision` instead, because its answer is the opposite: signed in means
 * leave.
 */

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { useAuth } from '@/hooks/use-auth';
import { LANDING_HREF } from '@/lib/navigation';
import { guardDecision } from '@/lib/route-guard';

/**
 * The whole-screen notice used while waiting and while redirecting.
 *
 * Not a spinner overlaid on the page. Rendering `children` underneath a spinner
 * would let the page's effects fire and its API calls go out with no token,
 * which the client classifies as unauthenticated and answers by ending a session
 * that was never started.
 */
function FullPageNotice({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface-50 px-6">
      {children}
    </main>
  );
}

function Spinner() {
  // A border rather than an image or a font icon, so there is nothing to fetch
  // and nothing that can fail to load on a tablet over a slow link.
  return (
    <span
      aria-hidden="true"
      className="h-8 w-8 animate-spin rounded-full border-4 border-surface-300 border-t-primary-500"
    />
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, permissions } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const decision = guardDecision({ status, permissions, pathname });

  // The target rather than the decision object, because `decision` is a fresh
  // object every render and an effect depending on it would re-run forever,
  // calling `router.replace` in a loop.
  const redirectTo = decision.action === 'redirect' ? decision.to : null;

  useEffect(() => {
    if (redirectTo !== null) {
      router.replace(redirectTo);
    }
  }, [redirectTo, router]);

  if (decision.action === 'wait') {
    return (
      <FullPageNotice>
        <Spinner />
        <p className="text-sm text-neutral-600">Checking your session…</p>
      </FullPageNotice>
    );
  }

  if (decision.action === 'redirect') {
    return (
      <FullPageNotice>
        <Spinner />
        <p className="text-sm text-neutral-600">Taking you to sign in…</p>
      </FullPageNotice>
    );
  }

  if (decision.action === 'refuse') {
    return (
      <FullPageNotice>
        <div className="w-full max-w-md rounded-lg border border-surface-200 bg-white p-6">
          <h1 className="text-lg font-semibold text-neutral-900">{decision.message}</h1>
          <p className="mt-2 text-sm text-neutral-600">{decision.detail}</p>
          {/* A link and not a redirect. Redirecting to `LANDING_HREF` from here
              would be safe today, because every role holds `sales:create`, but
              it would be a loop the day the landing page gains a gate — and a
              person who has just been refused something should be the one who
              decides where to go next. */}
          <Link
            href={LANDING_HREF}
            className="mt-6 inline-flex min-h-touch items-center rounded-md bg-primary-500 px-4 text-sm font-semibold text-white hover:bg-primary-600"
          >
            Back to the till
          </Link>
        </div>
      </FullPageNotice>
    );
  }

  return <>{children}</>;
}
