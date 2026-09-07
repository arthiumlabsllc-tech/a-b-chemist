/**
 * Ghana telephone numbers, in the one shape an SMS provider can be handed.
 *
 * Patient records hold a phone number typed by whoever was at the counter, and
 * the same handset gets written down five ways in a week: `024 123 4567`,
 * `0241234567`, `+233241234567`, `233241234567` and `24 123 4567`. A provider
 * accepts exactly one of those and rejects or misroutes the rest, so the
 * normalisation happens here rather than being left to whichever caller happens
 * to remember.
 *
 * ## What this checks and what it deliberately does not
 *
 * It checks *shape*, against Ghana's numbering plan: nine national digits,
 * beginning 2, 3 or 5 — 2X and 5X being mobile and 3X being fixed-line. It does
 * not check whether a prefix is currently allocated to an operator in service.
 *
 * That is a decision rather than an omission. A table of live prefixes is a fact
 * that changes whenever the National Communications Authority allocates a new
 * one, and the failure mode of a stale table is the worst available: a real
 * customer's number is refused, their reminder is written `not_sent` with a
 * reason that says the number is not a Ghana number, and nobody at the pharmacy
 * has any way to tell that from a genuine typo. Refusing too little costs a
 * provider a message that never arrives; refusing too much costs a patient their
 * reminder and costs the pharmacy a fact it cannot see.
 *
 * ## Refusing rather than sending
 *
 * A number that does not have the right shape is returned as null and never
 * passed on. Sending it anyway would be worse than failing: most providers
 * accept a malformed destination, bill for the attempt, and report success at
 * the HTTP level, so the record would say a reminder was delivered to somebody
 * who was never told. `services/sms.ts` turns a null here into a `not_sent` with
 * a reason the pharmacist can act on — go and ask the patient for their number
 * again — rather than a silent one.
 *
 * ## Why nothing here formats a number for display
 *
 * There is a tempting second function — take a stored number, return it
 * prettily grouped — and it is a bug. A patient visiting from Togo, or a
 * landline reached through an extension, has a number on their record that is
 * not a Ghana mobile, and a formatter built on the normaliser above would
 * return null for it. The screen would then show an empty phone field for a
 * patient who gave one, which is the record lying by omission.
 *
 * So `patients.phone` is stored exactly as it was typed and displayed exactly as
 * it was stored. Normalisation is for two jobs that are not display: handing a
 * destination to a provider, and comparing two records to ask whether they are
 * the same patient written down twice.
 */

const COUNTRY_CODE = '233';
const NATIONAL_LENGTH = 9;

/**
 * Grouping punctuation rather than a general cleanup. Only characters that are
 * plausibly formatting are removed: a letter in a phone number is a wrong value,
 * not a formatted one, and dropping it would turn a typo into a plausible number
 * that belongs to somebody else.
 */
const FORMATTING = /[\s\-().]/g;

/**
 * A Ghana number in international form (`+233NNNNNNNNN`), or null.
 *
 * `unknown` rather than `string` because the callers are a JSON body and a
 * database column that may hold null, and a signature that demanded a string
 * would push the same three checks into every one of them.
 */
export function normaliseGhanaPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const text = value.trim().replace(FORMATTING, '');
  if (text === '') return null;

  // `+233…` and `00233…` are the same number written two ways: the plus is the
  // international prefix, `00` is how it is dialled from a handset that has no
  // plus key. Stripping either before the length arithmetic means one rule
  // below rather than four.
  const withoutPrefix = text.startsWith('+')
    ? text.slice(1)
    : text.startsWith('00')
      ? text.slice(2)
      : text;

  if (!/^\d+$/.test(withoutPrefix)) return null;

  let national: string;
  if (
    withoutPrefix.startsWith(COUNTRY_CODE) &&
    withoutPrefix.length === COUNTRY_CODE.length + NATIONAL_LENGTH
  ) {
    national = withoutPrefix.slice(COUNTRY_CODE.length);
  } else if (withoutPrefix.startsWith('0') && withoutPrefix.length === NATIONAL_LENGTH + 1) {
    national = withoutPrefix.slice(1);
  } else if (withoutPrefix.length === NATIONAL_LENGTH) {
    national = withoutPrefix;
  } else {
    return null;
  }

  if (!/^[235]/.test(national)) return null;
  return `+${COUNTRY_CODE}${national}`;
}
