'use client';

/**
 * The frame every page in the app group sits inside.
 *
 * ## Two layouts, one table
 *
 * A rail from `lg` up and a scrolling tab bar below it, both built from
 * `navFor(permissions)`. The alternative — a second list of links for the small
 * screen — is a copy of the table, and the two disagree the first time a page is
 * added to one. Everything here reads `NAV_ITEMS`, which `navigation.test.ts`
 * ties to the filesystem.
 *
 * ## Touch
 *
 * Every link is at least `min-h-touch` (44px). The config calls this a product
 * decision rather than taste, and it is: this is operated standing up, on a
 * touchscreen, in a hurry, sometimes in gloves. A 32px nav item is a mis-tap,
 * and on a till a mis-tap is not an annoyance — it is a screen the cashier did
 * not mean to open in front of a queue.
 *
 * ## Hiding links is not authorisation
 *
 * `navFor` only decides what is offered. `backend/src/utils/permissions.ts` says
 * plainly that hiding a button in the UI is not authorisation, and every route
 * here is checked again by the API. What the filtering buys is that a cashier is
 * never shown a link that answers 403.
 *
 * ## The bell is in the header, not the table
 *
 * `NotificationBell` sits in both headers rather than being a nav item because it
 * is not a destination: it is a live unread count that has to be readable from
 * every page, including the ones the nav does not list. It gates itself on
 * `notifications:read` and renders nothing without it, so the shell never shows a
 * bell the API would answer 403 — the same rule the nav links follow.
 *
 * ## The offline queue is reconciled and shown here, not per page
 *
 * `OfflineSync` hydrates the persisted sale queue once and replays it when the
 * connection returns; `OfflineIndicator` shows how many sales are still waiting.
 * Both live in the frame because the queue is a fact about the device rather than
 * about whichever screen is up: a cashier who rings up a sale during an outage and
 * then walks to Stock still has to be told it has not reached the server. The
 * count is the queue's real depth, never `navigator.onLine` alone — see
 * `offline-indicator.tsx`.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { NotificationBell } from '@/components/notifications/notification-bell';
import { OfflineIndicator } from '@/components/offline-indicator';
import { OfflineSync } from '@/components/offline-sync';
import { useAuth } from '@/hooks/use-auth';
import { ROLE_LABELS, navFor } from '@/lib/navigation';
import type { NavItem } from '@/lib/navigation';
import { LOGIN_HREF, sectionHref } from '@/lib/route-guard';
import { frontendConfig } from '@/lib/frontend-config';

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={[
        'flex min-h-touch items-center rounded-md px-3 text-sm font-medium transition-colors',
        active
          ? 'bg-primary-600 text-white'
          : 'text-primary-50 hover:bg-primary-700 hover:text-white',
      ].join(' ')}
    >
      {item.label}
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, permissions, signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const sections = navFor(permissions);
  const section = sectionHref(pathname);
  const role = user === null ? null : ROLE_LABELS[user.role];

  async function onSignOut() {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    try {
      // Written to clear locally even when the server cannot be reached, so a
      // cashier walking out of range at closing time still gets a signed-out
      // tablet rather than one that stays open and cannot be closed.
      await signOut();
    } finally {
      router.replace(LOGIN_HREF);
    }
  }

  return (
    <div className="flex min-h-screen bg-surface-50">
      {/* Reconciles the offline sale queue once, for every page in the frame. */}
      <OfflineSync />
      {/* The rail. Hidden below `lg`, where the tab bar in the header takes over. */}
      <aside className="hidden w-56 shrink-0 flex-col bg-primary-800 lg:flex">
        <div className="px-4 py-5">
          <p className="text-base font-semibold text-white">{frontendConfig.appName}</p>
          <p className="mt-0.5 text-2xs uppercase tracking-wide text-primary-200">
            {frontendConfig.environment === 'production' ? 'Live' : frontendConfig.environment}
          </p>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
          {sections.map((group) => (
            <div key={group.group}>
              <p className="px-3 pb-1.5 text-2xs font-semibold uppercase tracking-wide text-primary-300">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.map((item) => (
                  <NavLink key={item.href} item={item} active={item.href === section} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-primary-700 px-4 py-4">
          <p className="truncate text-sm font-medium text-white">{user?.fullName ?? '—'}</p>
          <p className="mt-0.5 text-2xs text-primary-200">{role ?? ''}</p>
          <button
            type="button"
            onClick={() => void onSignOut()}
            disabled={signingOut}
            className="mt-3 flex min-h-touch w-full items-center justify-center rounded-md border border-primary-600 px-3 text-sm font-medium text-primary-100 hover:bg-primary-700 disabled:opacity-60"
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Below `lg` the brand and the nav move up here, and the nav scrolls
            sideways rather than wrapping: a wrapped tab bar on a phone pushes
            the till off the screen. */}
        <header className="border-b border-surface-200 bg-white lg:hidden">
          <div className="flex min-h-touch items-center justify-between gap-3 px-4">
            <p className="text-sm font-semibold text-neutral-900">{frontendConfig.appName}</p>
            <div className="flex items-center gap-1">
              <NotificationBell />
              <button
                type="button"
                onClick={() => void onSignOut()}
                disabled={signingOut}
                className="min-h-touch rounded-md px-3 text-sm font-medium text-neutral-600 hover:bg-surface-100 disabled:opacity-60"
              >
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2">
            {sections.flatMap((group) => group.items).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={item.href === section ? 'page' : undefined}
                className={[
                  'flex min-h-touch shrink-0 items-center rounded-md px-3 text-sm font-medium',
                  item.href === section
                    ? 'bg-primary-500 text-white'
                    : 'bg-surface-100 text-neutral-700',
                ].join(' ')}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </header>

        {/* The rail's own header, repeated here on large screens so the page has
            a consistent top edge whether or not the rail is showing. */}
        <header className="hidden items-center justify-between border-b border-surface-200 bg-white px-6 lg:flex lg:min-h-[60px]">
          <p className="text-sm text-neutral-600">
            {user === null ? '' : `${user.fullName} · ${role ?? ''}`}
          </p>
          <NotificationBell />
        </header>

        <main className="min-w-0 flex-1">
          <OfflineIndicator />
          {children}
        </main>
      </div>
    </div>
  );
}
