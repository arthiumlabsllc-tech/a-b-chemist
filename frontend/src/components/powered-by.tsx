/**
 * The "Powered by Arthium Labs" attribution.
 *
 * Shown on the sign-in page and in the app frame, so it is present whether or
 * not anybody is signed in.
 *
 * ## A plain anchor, not `next/link`
 *
 * This leaves the app for an external site. `next/link` is for in-app navigation
 * and would try to route the click client-side; an `<a>` with `target="_blank"`
 * opens Arthium Labs in its own tab and leaves the till exactly as it was. The
 * `rel="noopener noreferrer"` is the security half of that: without `noopener` a
 * page opened in a new tab can reach back to `window.opener` and navigate the
 * tab that linked to it.
 *
 * ## Colour is inherited, not fixed
 *
 * The link is used on the light sign-in page and on the dark sidebar rail, so it
 * takes its colour from the wrapping `<p>` (`currentColor`) rather than naming
 * one. The underline is what marks it as a link in both places.
 */

const ARTHIUM_ABOUT_URL = 'https://www.arthiumlabs.live/about';

export function PoweredByArthium({ className }: { className?: string }) {
  return (
    <p className={className}>
      Powered by{' '}
      <a
        href={ARTHIUM_ABOUT_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium underline underline-offset-2 hover:opacity-80"
      >
        Arthium Labs
      </a>
    </p>
  );
}
