import { Router } from 'express';
import { body, query } from 'express-validator';
import { authorize } from '../middleware/authorize';
import { requireAuth } from '../middleware/authenticate';
import {
  latestScreeningView,
  listScreeningPage,
  recordScreening,
  type ScreeningInput,
} from '../services/screenings.service';
import { asyncHandler } from '../utils/async-handler';
import { toDateOnlyOrNull, toEnumMember } from '../utils/coerce';
import { sendOk } from '../utils/http';
import { SCREENING_TYPES } from '../utils/schema-enums';
import type { ScreeningValues } from '../utils/screening';
import { runValidation } from '../utils/validate';
import { actorOf, enumListFilter, OPTIONAL_QUERY, pageOf, pagination } from './shared';

/**
 * Counter screenings: recording a reading, the history, and the last one of a type.
 *
 * Mounted behind `authenticate` alone, with `authorize` naming the permission on
 * each route. Recording a reading is `screenings:write`; reading the history is
 * `patients:read`, because the history is part of the record the counter is
 * already allowed to open and a separate `screenings:read` would be a second
 * permission granting the same view.
 *
 * ## There is no `/:id` route, so there is no route-order hazard here
 *
 * `inventory.routes.ts` and `sales.routes.ts` both have to declare their literal
 * paths before their parameterised ones. This router declares `/latest` first
 * anyway, and the reason is that the day somebody adds a `GET /screenings/:id`
 * they will add it at the bottom of the file — where it belongs, next to the
 * other single-record routes — and `/latest` would silently start arriving there
 * with `id = "latest"`. Declaring it first costs nothing now and makes the
 * ordering correct by construction rather than by memory.
 *
 * ## What this file deliberately does not check
 *
 * No `riskLevel`, and no format check on a reading's *value*. Both decisions are
 * `services/screenings.service.ts`'s and `utils/screening.ts`'s, and repeating
 * either here would create a second copy of a clinical rule. What this file does
 * check is the *type* of each field — that a reading arrived as a number or as
 * numeric text rather than as an object — because that is a boundary question and
 * because `utils/screening.ts`'s `toNumberOrNull` is typed `string | number |
 * null` and would throw on anything else. A thrown `TypeError` on a malformed
 * body is a 500 that names nothing useful.
 */
export const screeningsRoutes = Router();

/** A remark beside a reading, not the reading itself — short, and capped here. */
const MAX_NOTES_LENGTH = 500;

/**
 * The seven reading columns, with the name each is called on the form.
 *
 * Written as one map and iterated, rather than as seven chains, for the reason
 * `patients.routes.ts` gives for its three clinical lists: the copies would agree
 * today, and the day one was edited nothing would fail.
 *
 * The `satisfies` clause is the load-bearing part. It makes this map a
 * compile-time claim that it names **every** key of `ScreeningValues`, so the day
 * a column is added to the screening table this line stops compiling — rather
 * than quietly leaving the new reading with no validator and no entry in the
 * object `readingsFrom` builds, which would be a column that silently stores
 * null. `satisfies` and not `: Record<...>` because the annotation would widen
 * the type and throw away the literal keys `Object.keys` is about to rely on.
 */
const READING_FIELDS = {
  systolicBp: 'the top blood pressure number',
  diastolicBp: 'the bottom blood pressure number',
  bloodGlucoseMmol: 'the blood sugar reading in mmol/L',
  bmi: 'the BMI',
  weightKg: 'the weight in kg',
  temperatureC: 'the temperature in °C',
  heartRateBpm: 'the pulse in beats per minute',
} as const satisfies Record<keyof ScreeningValues, string>;

/**
 * The type filter as a set of strings, not of `ScreeningType`.
 *
 * Typed against `string` on purpose. The validator is looking at whatever a URL
 * carried, which is by definition not yet known to be a member of the enum, and
 * `SCREENING_TYPES.includes(value)` would need a cast to compile — a cast that
 * asserts the very thing the check exists to establish. `toEnumMember` does the
 * narrowing afterwards, where narrowing is what it is for.
 */
const SCREENING_TYPE_SET: ReadonlySet<string> = new Set(SCREENING_TYPES);

/**
 * One reading field: present as a number or as text, or not present at all.
 *
 * `optional({ values: 'null' })` rather than plain `optional()` because a form
 * that cleared a field sends `null` for it, and `null` here means the same thing
 * as absent — nothing was typed. `utils/screening.ts` distinguishes "nothing
 * typed" from "typed 0" and produces a different sentence for each, which only
 * works if a blank field arrives as nothing rather than as zero.
 *
 * No `.isFloat()` and no `.isNumeric()`. Both reject a JSON number and both
 * duplicate a rule `utils/screening.ts` already owns, which is exactly the
 * mistake `inventory.routes.ts` records declining to make on its money fields.
 */
function readingField(path: string, label: string) {
  return body(path, `Enter ${label} as a number`)
    .optional({ values: 'null' })
    .custom((value: unknown) => typeof value === 'number' || typeof value === 'string');
}

/**
 * The readings block, built in full.
 *
 * Every one of the seven keys is written out rather than spread from the body,
 * because `ScreeningValues` requires all seven and `toNumberOrNull` is typed
 * `string | number | null` — an absent key would arrive as `undefined` and throw
 * inside the service. Building the object here is what lets the client send only
 * the readings it took: a blood pressure form posts two numbers and the other
 * five come through as null, which is what the columns hold anyway.
 *
 * Anything that is not a number or a string becomes null, including the object or
 * array a malformed body might carry. `readingField` has already refused those and
 * answered 400, so this branch is unreachable through this router — it is here
 * because the alternative to a defensive read is a cast, and a cast would assert
 * the validator ran rather than checking what arrived.
 *
 * The seven keys are written out rather than looped over, and there is no cast
 * anywhere in this function as a result. Two independent compiler checks hold the
 * two lists together: `ScreeningValues` requires all seven keys here, and
 * `READING_FIELDS`'s `satisfies` clause requires it to name all seven there.
 * Neither list can lose a reading without the build failing, which is a stronger
 * guarantee than one loop with an `as` on the way out.
 */
function readingsFrom(raw: unknown): ScreeningValues {
  const source: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const reading = (key: keyof ScreeningValues): string | number | null => {
    const entry = source[key];
    return typeof entry === 'number' || typeof entry === 'string' ? entry : null;
  };

  return {
    systolicBp: reading('systolicBp'),
    diastolicBp: reading('diastolicBp'),
    bloodGlucoseMmol: reading('bloodGlucoseMmol'),
    bmi: reading('bmi'),
    weightKg: reading('weightKg'),
    temperatureC: reading('temperatureC'),
    heartRateBpm: reading('heartRateBpm'),
  };
}

// --- The last reading of one type: declared before any parameterised path -----

screeningsRoutes.get(
  '/latest',
  authorize('patients:read'),
  query('patientId', 'That is not a valid patient id').isUUID(),
  query('type', `Type must be one of ${SCREENING_TYPES.join(', ')}`).isIn(SCREENING_TYPES),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const raw = req.query as Record<string, unknown>;

    const screening = await latestScreeningView(
      auth.pharmacyId,
      String(raw.patientId),
      toEnumMember(raw.type, SCREENING_TYPES, 'the screening type')
    );
    // `null` is an answer, not an absence. A patient with no previous reading of
    // this type is the ordinary case the first time anybody takes one, and a 404
    // would make the patient page treat "nothing recorded yet" as "record not
    // found" — two states that look the same on a screen and mean opposite things.
    sendOk(res, { screening });
  })
);

// --- The history --------------------------------------------------------------

screeningsRoutes.get(
  '/',
  authorize('patients:read'),
  ...pagination,
  query('patientId', 'That is not a valid patient id').optional(OPTIONAL_QUERY).isUUID(),
  // Accepted repeated (`?type=bmi&type=weight`) as well as once. A history chart
  // that can only show one type at a time is a chart the pharmacist will work
  // around by making two requests and merging them in the browser.
  query('type', `Type must be one of ${SCREENING_TYPES.join(', ')}`)
    .optional(OPTIONAL_QUERY)
    .custom((value: unknown) =>
      enumListFilter(value).every(
        (entry) => typeof entry === 'string' && SCREENING_TYPE_SET.has(entry)
      )
    ),
  query('from', 'Enter the start date as YYYY-MM-DD')
    .optional(OPTIONAL_QUERY)
    .isDate({ format: 'YYYY-MM-DD', strictMode: true }),
  query('to', 'Enter the end date as YYYY-MM-DD')
    .optional(OPTIONAL_QUERY)
    .isDate({ format: 'YYYY-MM-DD', strictMode: true }),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const auth = requireAuth(req);
    const raw = req.query as Record<string, unknown>;
    const { limit, offset } = pageOf(raw);

    const requested = enumListFilter(raw.type);

    const page = await listScreeningPage(auth.pharmacyId, {
      patientId:
        raw.patientId === undefined || raw.patientId === '' ? null : String(raw.patientId),
      // `toEnumMember` on every entry rather than a cast over the array, for the
      // reason `sales.routes.ts` gives: these go into a `::screening_type`
      // comparison, where being wrong is a 500 on every request and not a message.
      types: requested.map((entry) => toEnumMember(entry, SCREENING_TYPES, 'the type filter')),
      from: toDateOnlyOrNull(raw.from, 'the start date'),
      to: toDateOnlyOrNull(raw.to, 'the end date'),
      limit,
      offset,
    });

    sendOk(res, { ...page, limit, offset, types: SCREENING_TYPES });
  })
);

// --- Recording one reading ----------------------------------------------------

screeningsRoutes.post(
  '/',
  authorize('screenings:write'),
  body('patientId', 'That is not a valid patient id').isUUID(),
  body('type', `Type must be one of ${SCREENING_TYPES.join(', ')}`).isIn(SCREENING_TYPES),
  // Optional rather than required, and not only for tidiness: a BMI screening
  // may arrive as a weight and a height with no ratio typed, and the form that
  // collects those posts an empty readings block. Requiring a non-empty object
  // here would refuse the case `services/screenings.service.ts` exists to serve.
  body('values', 'Enter the readings as an object').optional({ values: 'null' }).isObject(),
  ...Object.entries(READING_FIELDS).map(([key, label]) => readingField(`values.${key}`, label)),
  readingField('weightKg', 'the weight in kg'),
  readingField('heightCm', 'the height in cm'),
  // `{ values: 'null' }` here, where every filter on the two routes above says
  // `OPTIONAL_QUERY`. That asymmetry is the decision rather than an oversight, and
  // it is stated here because this is the chain a reader would otherwise "tidy".
  //
  // `OPTIONAL_QUERY` widens to `{ values: 'falsy' }`. On a query string that
  // skips one thing, `''`, because every value in one is a string. On a JSON body
  // it would also skip `0`, `false` and `NaN`, and this handler passes whatever
  // survives straight into `services/screenings.service.ts` — which calls `.trim()`
  // on a `measuredAt` and hands a reading to `toNumberOrNull`, typed
  // `string | number | null`. A skipped `0` is therefore a `TypeError` inside a
  // transaction and a 500 naming no field, where the client's mistake was one
  // wrong type in one named key.
  //
  // In a query string an empty cell is a spelling of absence, because that is what
  // a browser sends for a cleared form field. In a body it is a value a client
  // chose to send. `OPTIONAL_QUERY`'s doc comment records the same rule from the
  // other side, and `measuredAt: ''` answering 400 is pinned by
  // `__tests__/screenings.routes.test.ts` so the distinction cannot drift.
  body('measuredAt', 'Enter the date and time the reading was taken')
    .optional({ values: 'null' })
    .isISO8601(),
  body('notes', 'Enter the notes as text')
    .optional({ values: 'null' })
    .isString()
    .trim()
    .isLength({ max: MAX_NOTES_LENGTH })
    .withMessage(`Notes must be ${MAX_NOTES_LENGTH} characters or fewer`),
  asyncHandler(async (req, res) => {
    runValidation(req);
    const raw = req.body as {
      patientId: string;
      type: string;
      values?: unknown;
      weightKg?: string | number | null;
      heightCm?: string | number | null;
      measuredAt?: string | null;
      notes?: string | null;
    };

    const input: ScreeningInput = {
      patientId: raw.patientId,
      // `isIn` has just checked this, and `toEnumMember` narrows it rather than
      // the `as ScreeningType` a cast would need — the same belt-and-braces shape
      // `sales.routes.ts` uses, because the value goes into a `::screening_type`
      // column and into `measurementFrom`'s switch.
      type: toEnumMember(raw.type, SCREENING_TYPES, 'the screening type'),
      values: readingsFrom(raw.values),
      weightKg: raw.weightKg ?? null,
      heightCm: raw.heightCm ?? null,
      measuredAt: raw.measuredAt ?? null,
      notes: raw.notes ?? null,
    };

    // 201: the reading did not exist before this request. `recordedBy` is not
    // read from the body — the service signs it from the token.
    sendOk(res, { screening: await recordScreening(actorOf(req), input) }, 201);
  })
);
