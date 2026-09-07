import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SessionBootstrap } from '../components/session-bootstrap';
import { ServiceWorkerRegistrar } from '../components/service-worker-registrar';
import './globals.css';

/**
 * Root layout.
 *
 * No `next/font` here. It fetches at build time, which makes a successful build
 * depend on a network call to a font CDN — and a build that fails because it
 * could not download Inter is a build that failed for no reason that matters to
 * a pharmacy. The Tailwind font stack asks for Inter and falls back to the
 * platform's own UI font, which is what the till will actually be read on.
 */

export const metadata: Metadata = {
  applicationName: 'A&B Chemist',
  title: {
    default: 'A&B Chemist',
    template: '%s · A&B Chemist',
  },
  description: 'Stock, dispensing and the till for A&B Chemist.',
  manifest: '/manifest.json',
  // Not the access control — the login is. But this app holds patient records,
  // and there is no version of it that should appear in a search result.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#008753',
  width: 'device-width',
  initialScale: 1,
  // Zoom is deliberately left enabled. Pinch-zoom is an accessibility feature,
  // and disabling it to keep a layout stable trades something a person needs for
  // something a stylesheet should have handled.
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {/* Ahead of the page, so its effect runs before a route guard's. The
            order is a convenience rather than a requirement — the store already
            reports 'restoring' when a token is persisted, so a guard that ran
            first would still wait instead of redirecting. */}
        <SessionBootstrap />
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
