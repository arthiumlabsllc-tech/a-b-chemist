import type { Express } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { PAYSTACK_WEBHOOK_PATH } from '../services/paystack.service';
import { publicAuthRoutes, sessionAuthRoutes } from './auth.routes';
import { consultationsRoutes } from './consultations.routes';
import { healthRoutes } from './health.routes';
import { inventoryRoutes } from './inventory.routes';
import { notificationsRoutes } from './notifications.routes';
import { patientsRoutes } from './patients.routes';
import { prescriptionsRoutes } from './prescriptions.routes';
import { reportsRoutes } from './reports.routes';
import { salesRoutes } from './sales.routes';
import { screeningsRoutes } from './screenings.routes';
import { staffRoutes } from './staff.routes';
import { taxRoutes } from './tax.routes';
import { paystackWebhookRoutes } from './webhooks.routes';

/**
 * The whole mount table, in one place.
 *
 * Everything below `PUBLIC_ROUTE_PREFIXES` requires a token, and the list is
 * checked against the real router stack by `route-protection.test.ts` — a route
 * added in a later phase that forgets `authenticate` fails that suite instead of
 * quietly answering to anyone who finds it.
 */

/**
 * The paths that answer without a token. This is the complete list and it is
 * short on purpose.
 *
 * `/health` must be public because the platform deciding whether to route
 * traffic here cannot present a staff token. `/auth/login` and `/auth/refresh`
 * must be public because they are how a token comes to exist.
 *
 * The Paystack webhook is the third kind: unauthenticated at the HTTP level but
 * authenticated by its HMAC signature, which is stronger than a token because it
 * also proves the body was not edited in transit. It is listed by the same
 * constant `app.ts` uses to keep the raw body aside and to exempt the path from
 * rate limiting, so the three cannot drift apart — a webhook that is public but
 * rate-limited is a paid sale left pending, because Paystack retries a 429 and
 * eventually stops.
 *
 * There is no `/register` and no `/auth/forgot-password` here or anywhere else.
 */
export const PUBLIC_ROUTE_PREFIXES: readonly string[] = [
  '/health',
  '/auth/login',
  '/auth/refresh',
  PAYSTACK_WEBHOOK_PATH,
];

export function mountRoutes(app: Express): void {
  app.use('/health', healthRoutes);

  app.use('/auth', publicAuthRoutes);

  // Mounted before the authenticated half of the table and with no middleware in
  // front of it, because the signature check inside the router is the
  // authentication. Adding `authenticate` here would answer 401 to Paystack, who
  // has no staff token and will retry a charge that has already been paid.
  app.use(PAYSTACK_WEBHOOK_PATH, paystackWebhookRoutes);

  // From here down, every mount names `authenticate` first. Not a bare
  // `app.use(authenticate)`: that would also catch unmatched paths and answer
  // 401 to a mistyped URL, which the offline queue reads as "your session
  // expired" and would sign the cashier out over a typo in the frontend.
  app.use('/auth', authenticate, sessionAuthRoutes);

  // Staff management is the owner's. A pharmacist running the dispensary in the
  // owner's absence can do everything except hand out accounts — including to
  // themselves.
  app.use('/staff', authenticate, authorize('staff:manage'), staffRoutes);

  // Inventory authenticates at the mount and authorises per route, because
  // reading stock and correcting it are different permissions: a till operator
  // needs `inventory:read` at the counter and must not have `inventory:adjust`.
  // One `authorize` here would have to pick the weakest permission and would
  // then be the only thing standing between a cashier and a write-off.
  app.use('/inventory', authenticate, inventoryRoutes);

  // Tax settings authorise per route for the same reason inventory does, and the
  // two halves are further apart than inventory's: every role that can sell can
  // read the rates, because a till cannot price a basket without them, while
  // changing them is one of the five things the brief makes owner-only.
  app.use('/tax', authenticate, taxRoutes);

  // The till. Authorised per route, like inventory and tax, because reading the
  // catalogue, ringing a sale, taking a payment and voiding one are four
  // permissions held by three roles. `sales:void` is one of the five things the
  // brief makes owner-only, and a mount-level `authorize` weak enough to let a
  // cashier sell would let the same cashier void.
  app.use('/sales', authenticate, salesRoutes);

  // Reports authorise at the mount, which is the other half of the shape inventory
  // and sales use. One permission covers the whole router: a report is the business
  // in one response, so there is no weaker reading of it that a cashier could be
  // given and no stronger one that has to be withheld per route. It is read-only and
  // stays that way — a report that could be edited would be a second set of books.
  app.use('/reports', authenticate, authorize('reports:read'), reportsRoutes);

  // The clinical record and everything hanging off it. All five authorise per
  // route, and all five for the same reason: each one has a read held by counter
  // staff beside a write they do not hold.
  //
  // Patients and notifications are `patients:read`/`patients:write` and
  // `notifications:read`/`notifications:refresh`. Screenings split
  // `patients:read` from `screenings:write`, because the history is part of the
  // record the counter may already open while taking a reading is a clinical act.
  // Consultations split the same way. Prescriptions split three ways — reading,
  // writing one down, and approving — and the third is the one that matters: the
  // person who noted a script at the counter cannot be the person who approved it
  // unless they are a pharmacist or the owner.
  //
  // They are five routers rather than one `/patients` tree, and
  // `patients.routes.ts` records why: every one of these repositories already
  // takes `patientId` as a filter, so a nested path would be a second route to the
  // same statement, a second place to authorise, and a second way for the id in
  // the path and the id in the filter to disagree.
  app.use('/patients', authenticate, patientsRoutes);
  app.use('/screenings', authenticate, screeningsRoutes);
  app.use('/consultations', authenticate, consultationsRoutes);
  app.use('/prescriptions', authenticate, prescriptionsRoutes);
  app.use('/notifications', authenticate, notificationsRoutes);
}
