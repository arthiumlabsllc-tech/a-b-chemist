import { Router } from 'express';
import { body } from 'express-validator';
import { requireAuth } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import {
  changeTaxSettings,
  readTaxSettingsView,
} from '../services/tax-settings.service';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/http';
import { TAX_RATE_FIELDS } from '../utils/tax-errors';
import { runValidation } from '../utils/validate';

/**
 * Tax settings: what the pharmacy charges, and who may change it.
 *
 * Two routes and two permissions, which is why the mount authorises per route
 * rather than once. A till operator needs `tax:read` to price a sale and Phase
 * 9's offline till needs it to cache the rates; only the owner has
 * `tax:change`, because that half decides what every sale in the pharmacy
 * charges.
 *
 * There is no DELETE and no POST. The settings are four columns on the one
 * pharmacy row, so they always exist and are never created — the seed row
 * carries Act 1151's rates and the defaults in `init.sql` say the same thing.
 *
 * The three rates are deliberately not shape-checked here. A regex for
 * `numeric(5, 4)` on the route would be a second statement of a rule the engine
 * already owns, in a second language, with no shared test — and the way the two
 * disagree is a value the route accepts and the engine then refuses, which is a
 * 500 on a field the owner can see nothing wrong with. Presence is checked
 * because that is not a rule about rates; everything past it belongs to
 * `parseRate`.
 */
export const taxRoutes = Router();

taxRoutes.get(
  '/settings',
  authorize('tax:read'),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendOk(res, { taxSettings: await readTaxSettingsView(auth.pharmacyId) });
  })
);

taxRoutes.put(
  '/settings',
  authorize('tax:change'),
  body('taxInclusivePricing')
    .isBoolean()
    .withMessage('Say whether shelf prices already include the tax'),
  ...TAX_RATE_FIELDS.map(({ key, label }) =>
    body(key)
      .exists()
      // The label is the engine's own wording for the field, so a missing rate
      // and a malformed one are refused in the same words by two different
      // layers rather than by one of them inventing a name.
      .withMessage(`Enter ${label}`)
  ),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const input = req.body as {
      taxInclusivePricing: boolean;
      vatRate: string | number;
      nhilRate: string | number;
      getfundRate: string | number;
    };

    // The saved settings come back rather than an acknowledgement, for the same
    // reason `PATCH /staff/:id` returns the staff member: the owner sees the
    // rates as stored, in both spellings, and whether they still match Act 1151.
    // A response that says only `{ saved: true }` asks them to reload to find out
    // what they just did.
    sendOk(res, { taxSettings: await changeTaxSettings(auth.pharmacyId, input) });
  })
);
