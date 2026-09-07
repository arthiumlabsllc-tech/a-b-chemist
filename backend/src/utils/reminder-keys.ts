/**
 * The shapes of `reminders.dedupe_key`.
 *
 * One module, because the key is written in two places that have to agree and
 * neither can see the other fail. `scheduleReminder` inserts a whole key.
 * `supersedeAppointmentReminders` matches a *prefix* of one, in SQL, because
 * rescheduling an appointment has to find every reminder raised for it and the
 * `reminders` table has no `consultation_id` to find them by. If the two
 * spellings drifted, superseding would silently stop matching: the stale reminder
 * would stay `pending`, stay in `reminders_pharmacy_due_idx`, and fire for a slot
 * that no longer exists — telling a patient to come in on a day nobody is
 * expecting them. Nothing would error.
 *
 * Deriving the prefix from the same literal that builds the key is what makes the
 * drift impossible rather than merely unlikely, and the supersede statement
 * carries no copy of it: the prefix reaches SQL as a bound parameter and only the
 * trailing wildcard is written into the statement. `reminders.repository.test.ts`
 * pins both halves against each other, so a change to one without the other is a
 * red test rather than a patient standing outside a locked pharmacy.
 *
 * ## Why a refill is keyed to the prescription alone
 *
 * A refill reminder is raised once and never again, because a prescription is one
 * supply. When the patient collects it, the dispensing is recorded against a sale
 * and the next reminder belongs to whatever authorises the supply after that. A
 * key that included the month would re-raise on a script already collected, which
 * is a text message telling somebody to come in for medicine they are holding.
 *
 * ## Why an appointment is keyed to the consultation *and its time*
 *
 * So that moving the appointment raises a fresh reminder for the new slot instead
 * of leaving the patient with one about the old one. The timestamp is the part that
 * makes rescheduling work: without it the new slot's key would collide with the
 * old, `on conflict do nothing` would swallow it, and the patient would keep the
 * reminder for the time that was cancelled.
 *
 * Because the prefix and the key are built here, from the same id string, they
 * agree byte for byte — no casing or rendering step sits between them. That is
 * worth saying only because the alternative was to spell `'appointment:'` into the
 * supersede statement beside a `$n::uuid::text` cast, which would have agreed with
 * this module by coincidence and for as long as nobody changed either.
 */

const REFILL_PREFIX = 'refill:';
const APPOINTMENT_PREFIX = 'appointment:';

/** A refill reminder's key: one prescription, one reminder, ever. */
export function refillReminderKey(prescriptionId: string): string {
  return `${REFILL_PREFIX}${prescriptionId}`;
}

/**
 * An appointment reminder's key: one consultation *and one slot*.
 *
 * `scheduledAtIso` is the consultation's `scheduled_at` as the repository mapped
 * it — an ISO 8601 string, so it is stable across a read and a rewrite and
 * contains no character that means anything in a `like` pattern.
 */
export function appointmentReminderKey(
  consultationId: string,
  scheduledAtIso: string
): string {
  return `${APPOINTMENT_PREFIX}${consultationId}:${scheduledAtIso}`;
}

/**
 * The prefix every reminder for one consultation shares, whatever slot it was
 * raised for.
 *
 * Deliberately without a trailing `%`. The wildcard belongs in the statement that
 * uses it, so the only part of the pattern a caller can influence is an id, and a
 * `like` pattern assembled entirely from caller text would need `likePattern`
 * escaping to be safe. This way it does not.
 */
export function appointmentReminderPrefix(consultationId: string): string {
  return `${APPOINTMENT_PREFIX}${consultationId}:`;
}
