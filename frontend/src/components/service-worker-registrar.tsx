'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker.
 *
 * Production only. In development the worker would sit between the developer
 * and Next's hot reload, caching the very bundle that just changed, which turns
 * every "I fixed it, why is it still broken" into a cache archaeology session.
 * The caching rules are exercised in production, where they matter.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Deliberately silent. The app is fully functional without the worker —
      // only offline reads stop working — so a failed registration is not an
      // error the pharmacist can act on, and must not become a toast.
    });
  }, []);

  return null;
}
