'use client';

/**
 * The sign-in page.
 *
 * ## Why it says why there is nobody signed in
 *
 * `signedOutReason` exists because the remedies are different, and a form that
 * shows the same blank pair of fields for all of them sends people down the
 * wrong one. A cashier who was deactivated types their password again, and
 * again, until the rate limiter locks the counter — which, behind one router, is
 * every tablet in the shop. Telling them to find the owner costs one line.
 *
 * ## Why the server's own wording is shown
 *
 * `backend/src/routes/auth.routes.ts` picks a message per failure and says why
 * they are not all the same: `invalid_credentials` is deliberately vague so
 * sign-in cannot be used to discover which addresses are on the staff list,
 * while a deactivated account and an account with no password set are not
 * secrets and need the person to go and find the owner. Rewriting those here
 * would either undo the vagueness or undo the direction, and the frontend has no
 * way to know which it had done.
 */

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';

import { PoweredByArthium } from '@/components/powered-by';
import { useAuth } from '@/hooks/use-auth';
import { ApiError } from '@/lib/api-client';
import { frontendConfig, frontendConfigProblems } from '@/lib/frontend-config';
import { loginDecision } from '@/lib/route-guard';
import type { SignedOutReason } from '@/lib/auth-session';

/**
 * What the sign-in page says when it opens with nobody signed in.
 *
 * `'never'` and `'signed-out'` get nothing: there is no news to give, and a
 * banner explaining that you are not signed in on the page where you sign in is
 * noise.
 */
const SIGNED_OUT_NOTICES: Partial<Record<SignedOutReason, string>> = {
  'session-ended': 'Your session ended. Sign in again.',
  'account-disabled': 'This account has been deactivated. Speak to the owner.',
  // The refresh token is deliberately kept in this case, so retrying is the
  // remedy rather than signing in from scratch.
  unreachable:
    'The server could not be reached. Your session is still on this device — try again when the connection is back.',
};

/**
 * The three things the counter actually does, shown beside the sign-in card.
 * They mirror the signage in the background photograph — prescriptions,
 * consultation, payment — so the page describes the shop it is for rather than
 * making generic claims.
 */
const HIGHLIGHTS = [
  'Prescriptions dispensed against stock that respects expiry dates',
  'Consultations and screenings recorded at the counter, not after',
  'Cash and mobile-money payments settled in one place',
];

function describeSignInError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isOffline) {
      // Our wording rather than the client's, because a fetch failure message
      // describes the browser and the person at the counter needs the remedy.
      return 'Cannot reach the server. Check the connection and try again.';
    }
    return error.message;
  }
  // Anything else is a bug, and saying "try again" about a bug sends somebody
  // retrying forever. Naming it as unexpected is the honest version.
  return 'Sign-in failed unexpectedly. Tell the owner what you were doing.';
}

export default function LoginPage() {
  const { status, signedOutReason, signingIn, signIn } = useAuth();
  const router = useRouter();
  const decision = loginDecision(status);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const redirectTo = decision.action === 'redirect' ? decision.to : null;

  useEffect(() => {
    if (redirectTo !== null) {
      router.replace(redirectTo);
    }
  }, [redirectTo, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (signingIn) {
      return;
    }
    setFormError(null);
    try {
      // Rejects with the `ApiError`; it does not swallow. On success the store
      // reports 'signed-in', `loginDecision` answers `redirect`, and the effect
      // above does the navigating — so this handler does not have to.
      await signIn(email.trim(), password);
    } catch (error) {
      setFormError(describeSignInError(error));
    }
  }

  if (decision.action === 'wait' || decision.action === 'redirect') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface-50 px-6">
        <span
          aria-hidden="true"
          className="h-8 w-8 animate-spin rounded-full border-4 border-surface-300 border-t-primary-500"
        />
        <p className="text-sm text-neutral-600">
          {decision.action === 'wait' ? 'Checking your session…' : 'Signing you in…'}
        </p>
      </main>
    );
  }

  const notice = SIGNED_OUT_NOTICES[signedOutReason] ?? null;

  return (
    <main className="relative min-h-screen overflow-hidden">
      {/* The pharmacy photograph is the page background. The scrim over it keeps
          the white brand text legible and tints the scene to the house green, so
          the photo reads as the shop rather than as wallpaper. */}
      <Image
        src="/login-bg.jpg"
        alt=""
        fill
        priority
        sizes="100vw"
        className="object-cover"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-br from-primary-900/95 via-primary-800/80 to-primary-900/60"
      />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-center gap-10 px-6 py-12 lg:flex-row lg:items-center lg:justify-between lg:gap-16">
        {/* Brand column, over the photograph and therefore white. Below `lg` the
            card carries the brand instead, so this stays out of the way. */}
        <div className="hidden max-w-md text-white lg:block">
          <div className="inline-flex rounded-lg bg-white px-3 py-2 shadow-lg">
            <Image
              src="/logo.png"
              alt={frontendConfig.appName}
              width={1094}
              height={386}
              className="h-10 w-auto"
            />
          </div>

          <h2 className="mt-8 text-4xl font-bold leading-tight tracking-tight">
            Care at the counter, counted correctly.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-primary-100">
            Stock, dispensing and the till for {frontendConfig.appName} — one place,
            from shelf to sale.
          </p>

          <ul className="mt-8 space-y-3">
            {HIGHLIGHTS.map((highlight) => (
              <li key={highlight} className="flex items-start gap-3 text-sm text-primary-50">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-500 text-primary-900">
                  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-3 w-3">
                    <path
                      fillRule="evenodd"
                      d="M16.704 5.29a1 1 0 0 1 .006 1.414l-7.2 7.3a1 1 0 0 1-1.42.004L3.29 9.2a1 1 0 1 1 1.42-1.408l2.086 2.1 6.494-6.586a1 1 0 0 1 1.414-.006Z"
                      clipRule="evenodd"
                    />
                  </svg>
                </span>
                {highlight}
              </li>
            ))}
          </ul>
        </div>

        {/* The sign-in card. Frosted rather than flat so the shop stays visible
            behind it without competing with the fields. */}
        <div className="w-full max-w-md">
          <div className="rounded-2xl bg-white/95 p-6 shadow-2xl backdrop-blur-sm sm:p-8">
            <div className="mb-6 text-center lg:text-left">
              <div className="flex justify-center lg:hidden">
                <Image
                  src="/logo.png"
                  alt={frontendConfig.appName}
                  width={1094}
                  height={386}
                  priority
                  className="h-14 w-auto"
                />
              </div>
              <h1 className="mt-4 text-2xl font-bold tracking-tight text-neutral-900 lg:mt-0">
                Sign in to open the till
              </h1>
              <p className="mt-1 text-sm text-neutral-600">
                Welcome back — use your staff email and password.
              </p>
            </div>

            {frontendConfigProblems.length > 0 && (
              <div className="mb-4 rounded-lg border border-accent-300 bg-accent-50 p-3">
                <p className="text-sm font-semibold text-accent-900">
                  This build is not deployable as configured
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-accent-900">
                  {frontendConfigProblems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            )}

            <form onSubmit={(event) => void onSubmit(event)} noValidate>
              {notice !== null && (
                <p
                  role="status"
                  className="mb-4 rounded-lg border border-surface-200 bg-surface-50 p-3 text-sm text-neutral-700"
                >
                  {notice}
                </p>
              )}

              {formError !== null && (
                <p
                  role="alert"
                  className="mb-4 rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
                >
                  {formError}
                </p>
              )}

              <label className="block text-sm font-medium text-neutral-700" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                // A tablet's keyboard capitalises the first letter of an email by
                // default, and `Owner@Shop.com` does not match `owner@shop.com`.
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="username"
                placeholder="name@pharmacy.com"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-1 block min-h-touch-lg w-full rounded-lg border border-surface-300 bg-white px-3 text-base text-neutral-900 placeholder:text-neutral-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
              />

              <label className="mt-4 block text-sm font-medium text-neutral-700" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="Enter your password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-1 block min-h-touch-lg w-full rounded-lg border border-surface-300 bg-white px-3 text-base text-neutral-900 placeholder:text-neutral-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
              />

              <button
                type="submit"
                disabled={signingIn}
                className="mt-6 flex min-h-touch-lg w-full items-center justify-center rounded-lg bg-primary-500 px-4 text-base font-semibold text-white shadow-sm transition-colors hover:bg-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:opacity-60"
              >
                {signingIn ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </div>

          {/* Outside the card, over the scrim, so these read light-on-dark. */}
          <p className="mt-4 text-center text-2xs text-primary-100">
            {frontendConfig.environment === 'production' ? 'Live' : frontendConfig.environment} ·{' '}
            <span className="font-mono">{frontendConfig.apiBaseUrl}</span>
          </p>

          <PoweredByArthium className="mt-2 text-center text-2xs text-primary-100" />
        </div>
      </div>
    </main>
  );
}
