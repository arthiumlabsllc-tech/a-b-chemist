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
import { useRouter } from 'next/navigation';

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
    <main className="flex min-h-screen flex-col items-center justify-center bg-surface-50 px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-neutral-900">{frontendConfig.appName}</h1>
          <p className="mt-1 text-sm text-neutral-600">Sign in to open the till</p>
        </div>

        {frontendConfigProblems.length > 0 && (
          <div className="mb-4 rounded border border-accent-300 bg-accent-50 p-3">
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

        <form
          onSubmit={(event) => void onSubmit(event)}
          className="rounded-lg border border-surface-200 bg-white p-5"
          noValidate
        >
          {notice !== null && (
            <p
              role="status"
              className="mb-4 rounded border border-surface-200 bg-surface-50 p-3 text-sm text-neutral-700"
            >
              {notice}
            </p>
          )}

          {formError !== null && (
            <p
              role="alert"
              className="mb-4 rounded border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
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
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 block min-h-touch-lg w-full rounded-md border border-surface-300 px-3 text-base text-neutral-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
          />

          <label className="mt-4 block text-sm font-medium text-neutral-700" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 block min-h-touch-lg w-full rounded-md border border-surface-300 px-3 text-base text-neutral-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
          />

          <button
            type="submit"
            disabled={signingIn}
            className="mt-6 flex min-h-touch-lg w-full items-center justify-center rounded-md bg-primary-500 px-4 text-base font-semibold text-white hover:bg-primary-600 disabled:opacity-60"
          >
            {signingIn ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-center text-2xs text-neutral-500">
          {frontendConfig.environment === 'production' ? 'Live' : frontendConfig.environment} ·{' '}
          <span className="font-mono">{frontendConfig.apiBaseUrl}</span>
        </p>
      </div>
    </main>
  );
}
