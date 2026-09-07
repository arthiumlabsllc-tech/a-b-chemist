import { redirect } from 'next/navigation';

import { LANDING_HREF } from '@/lib/navigation';

/**
 * The root route, which is a redirect and nothing else.
 *
 * There is no dashboard. The person walking up to this tablet is at a counter
 * with a customer, and the page they want is the till — so `/` goes there, and
 * `RequireAuth` sends anybody not signed in on to `/login` from there. Two hops
 * rather than one, which costs nothing a person can see and keeps the auth
 * decision in the one place that makes it.
 *
 * The scaffold page this replaces named the API origin it was compiled against,
 * which was the right thing for a build with no pages in it. That check has
 * moved to `/login`, where it is seen by somebody who is about to be told their
 * password is wrong by a server that may not be the one they think they are
 * talking to.
 */
export default function Home() {
  redirect(LANDING_HREF);
}
