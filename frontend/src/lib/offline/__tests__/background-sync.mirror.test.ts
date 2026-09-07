/**
 * `public/sw.js`, read as source rather than run.
 *
 * The worker is plain JavaScript in `public/`: not type-checked, not linted, not
 * bundled, and not reachable from any other suite. That is deliberate — it has to
 * be servable byte-for-byte at a fixed URL — but it leaves the caching rules and
 * the background-sync handshake with no net under them at all. This suite is that
 * net, in the same spirit as `api-types.mirror.test.ts`: it reads the file the
 * other half of the contract lives in and fails when the two disagree.
 *
 * Source assertions are brittle by nature and that is the right trade here, because
 * every one of them names a rule the BRIEF states and a regression in any of them
 * is invisible at runtime. A mismatched sync tag does not throw; the wake-up simply
 * never comes, and the till looks like it is working until the end of the day.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BACKGROUND_SYNC_TAG } from '../background-sync';

// Four levels up from `frontend/src/lib/offline/__tests__` is the frontend root,
// the same derivation `api-types.mirror.test.ts` uses to reach the backend.
const WORKER_PATH = join(__dirname, '..', '..', '..', '..', 'public', 'sw.js');

function worker(): string {
  return readFileSync(WORKER_PATH, 'utf8');
}

describe('the tag, which two files hold separately', () => {
  it('is the one the worker matches its sync event against', () => {
    const match = /const SYNC_TAG = '([^']+)'/.exec(worker());

    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(BACKGROUND_SYNC_TAG);
  });

  it('is the one the worker posts back to the page', () => {
    // `offline-sync.tsx` matches an incoming message on this same constant. A
    // worker that posted anything else would fire on every sync and wake nothing.
    expect(worker()).toMatch(/postMessage\(\s*\{\s*type:\s*SYNC_TAG\s*\}/);
  });

  it('is the one the page registers', () => {
    // The third reader, and the one with no reason to be checked against the
    // others except that nothing else does: `offline-sync.tsx` imports the constant
    // rather than restating it, so this is really a test that it still does.
    const page = readFileSync(
      join(__dirname, '..', '..', '..', 'components', 'offline-sync.tsx'),
      'utf8',
    );

    expect(page).toContain('BACKGROUND_SYNC_TAG');
    expect(page).not.toContain("'ab-chemist-sync'");
  });
});

describe('what the worker is not allowed to do', () => {
  it('never touches a write', () => {
    // Sales, stock movements and patient records. The worker caches reads and
    // announces a moment to sync; it replays nothing, because the tokens that
    // authorise a write live in the page and a second writer with its own idea of
    // what had been sent is the duplicate sale `clientSaleId` exists to prevent.
    expect(worker()).toMatch(/request\.method\s*!==\s*'GET'/);
  });

  it('never caches the API', () => {
    // A different origin, carrying personal health data under Act 843 and payment
    // data. Same-origin only is the rule that keeps it out, in every phase.
    expect(worker()).toMatch(/url\.origin\s*!==\s*self\.location\.origin/);
  });

  it('never stores a response that was not a good one', () => {
    // Both halves, because each fails differently: a cached 404 is served back as
    // content offline and indefinitely, and a cached redirect is filed under a URL
    // that never produced those bytes. This is the rule the previous build broke.
    expect(worker()).toMatch(/response\.ok\s*&&\s*!response\.redirected/);
  });
});

describe('the offline answer for a page that was never fetched', () => {
  it('says the connection is the problem and that nothing was lost', () => {
    const source = worker();

    // Generated, not fetched: a fallback that has to be downloaded is not a
    // fallback. The two sentences that matter are the ones a browser error page
    // cannot say.
    expect(source).toMatch(/function offlinePage\(\)/);
    expect(source).toContain('The app is not broken and nothing has been lost');
    expect(source).toContain('still on this device');
  });

  it('answers 503 and not 200', () => {
    // A stored page rendered as though it were fresh is indistinguishable from the
    // real thing, and the whole rule this worker runs on is that a failure is never
    // served as content.
    expect(worker()).toMatch(/status:\s*503/);
  });
});
