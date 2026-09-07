import type { Sql } from '../database/pool';
import type { NotificationStatus, NotificationType } from '../utils/schema-enums';

/**
 * The notifications table, and nothing else.
 *
 * Phase 4 wrote this as `alerts.repository.ts`, because stock alerts were the
 * only thing raising notifications and the file was named for the feature that
 * introduced it. Phase 8 makes notifications a domain in their own right — the
 * bell, patient reminders, appointment reminders — and a second file writing to
 * the same table would have meant two column lists and two mappers that have to
 * agree. So the table moved here and the alerts half stayed a service.
 * `services/alerts.service.ts` still decides *which* stock alerts are worth
 * raising; this file only decides whether one is new.
 *
 * ## One list statement, not a builder
 *
 * `listNotifications` used to splice its `where` clause together from whichever
 * filters the caller supplied, which produced a different statement per
 * combination. That is now one statement with nullable parameters, and the change
 * is not cosmetic:
 *
 *   - The placeholder count no longer depends on the caller's input, so the
 *     Postgres harness needs one PREPARE for it instead of one per combination
 *     and the two sides cannot drift on a shape only some callers produce.
 *   - A filter combination nobody happened to exercise in a test was a statement
 *     nobody had ever parsed. Every combination is now the same statement, which
 *     section 11 of `database/tests/assertions.sql` parses against the real
 *     schema.
 *
 * The cost is that `$3::notification_type[] is null or ...` gives the planner a
 * disjunction it cannot always use an index for. At one pharmacy's notification
 * volume that is a few hundred rows either way, and `utils/fefo.ts`'s sibling
 * reasoning in `services/alerts.service.ts` already accepts the same trade.
 *
 * ## Who can see a row
 *
 * `user_id is null` broadcasts to every staff member; a set value targets one.
 * The clause spelling that is `VISIBILITY` below, written once and used by all
 * four readers and writers here, so the rule has one home.
 *
 * `read_at` is on the row rather than in a per-user join table, which means a
 * broadcast has **one** read state for the whole pharmacy: when anybody marks it
 * read, it is read for everyone. That is a decision rather than an oversight. A
 * `notification_reads` table would give each member their own badge, and at a
 * counter with three people on a shift it would also give each of them a bell
 * that stays lit over an alert a colleague dealt with an hour ago. "Somebody has
 * seen this" is the more useful fact for a small team, and the shared row is what
 * makes it available. The UI says so where it matters.
 */

const NOTIFICATION_COLUMNS = `id, pharmacy_id, user_id, type, status, title, body,
  related_type, related_id, dedupe_key, not_sent_reason, sent_at, read_at,
  created_at, updated_at`;

/**
 * The visibility rule, spelled once.
 *
 * `$2` is always the asking user. The leading `is null` branch exists for the
 * readers that look at everything — the stock alert panel asks for all alerts
 * rather than "the ones aimed at me", and a broadcast passes either way. The
 * three functions that require a user by their TypeScript signature never send
 * null here, so for them the branch is unreachable: which user may see a row is
 * enforced by the type as well as by the SQL, and not by the SQL alone.
 */
const VISIBILITY = `($2::uuid is null or user_id is null or user_id = $2::uuid)`;

export interface NotificationRow {
  id: string;
  pharmacyId: string;
  /** NULL means every staff member sees it; a set value targets one user. */
  userId: string | null;
  type: NotificationType;
  status: NotificationStatus;
  title: string;
  body: string | null;
  relatedType: string | null;
  relatedId: string | null;
  dedupeKey: string;
  /**
   * Present whenever nothing was attempted. This is not an error field: an
   * alert shown in the app with no SMS provider configured is `not_sent` with
   * the reason beside it, which is a true statement rather than a silent one.
   */
  notSentReason: string | null;
  sentAt: string | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewNotification {
  pharmacyId: string;
  /**
   * Omitted or null broadcasts to every staff member, which is what a stock
   * alert and a patient reminder both are: neither belongs to whoever happened
   * to open the panel first.
   */
  userId?: string | null;
  type: NotificationType;
  title: string;
  body: string | null;
  /**
   * What `relatedId` points at: `'inventory'`, `'inventory_batch'`, `'patient'`,
   * `'prescription'`, `'consultation'` or `'reminder'`. Free text in the schema
   * and free text here, because it is a hint for building a link rather than a
   * foreign key — a notification outliving the row it points at must not stop
   * the bell from rendering.
   */
  relatedType: string | null;
  relatedId: string | null;
  dedupeKey: string;
  status: NotificationStatus;
  notSentReason: string | null;
  /**
   * When the message went out, as the provider reported it. Required beside a
   * `sent` status in every caller that writes one, and null otherwise.
   *
   * This is the mirror image of `notSentReason` and it is here for the same
   * reason: a bell entry saying `sent` with nothing beside it is a claim with no
   * evidence, and "I never got it" becomes an argument instead of a lookup. The
   * instant is the provider's rather than a local clock read, because this process
   * only handed the message over and cannot know when a handset received it —
   * `services/sms.ts` records that reasoning and returns the provider's own.
   *
   * Optional and defaulted to null so the callers that never send anything — a
   * stock alert, a reminder with no provider configured — do not each have to
   * spell out an absence.
   */
  sentAt?: string | null;
}

export interface RaiseResult {
  /** True when this call created the row; false when one already held the key. */
  raised: boolean;
  /** The new row, or null when the alert already existed. */
  notification: NotificationRow | null;
}

export interface NotificationFilters {
  /**
   * Restrict to these types. Omitted or empty means every type.
   *
   * Empty is folded into "every type" here rather than sent as an empty array,
   * and the reason is a Postgres fact section 11e of the harness executes:
   * `type = any('{}')` is valid SQL that matches no row. A panel that silently
   * renders nothing looks exactly like a panel on a day when nothing is wrong.
   */
  types?: readonly NotificationType[];
  /** When set, only notifications broadcast or aimed at this user. */
  visibleTo?: string | null;
  /** When true, only rows nobody has read yet. */
  unreadOnly?: boolean;
  limit: number;
  offset: number;
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function mapNotification(row: Record<string, unknown>): NotificationRow {
  return {
    id: row.id as string,
    pharmacyId: row.pharmacy_id as string,
    userId: textOrNull(row.user_id),
    type: row.type as NotificationType,
    status: row.status as NotificationStatus,
    title: row.title as string,
    body: textOrNull(row.body),
    relatedType: textOrNull(row.related_type),
    relatedId: textOrNull(row.related_id),
    dedupeKey: row.dedupe_key as string,
    notSentReason: textOrNull(row.not_sent_reason),
    sentAt: toIsoOrNull(row.sent_at as Date | null),
    readAt: toIsoOrNull(row.read_at as Date | null),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/**
 * Raises a notification unless one already holds its dedupe key.
 *
 * Both enum parameters are cast. Assignment alone would deduce them, but a
 * cast makes the statement's intent legible at the point where a future edit
 * might reuse the same parameter in a comparison — which is the shape that
 * fails at parse time rather than at the counter.
 *
 * `on conflict do nothing` with `returning` is the whole mechanism, and deciding
 * in the application instead — select, then insert if absent — is a race with a
 * window exactly as wide as the two round trips between the read and the write.
 * The failure mode is a duplicate reminder, which is the thing the unique index
 * exists to prevent and the thing Phase 8's acceptance line asks to see proven.
 */
export async function raiseNotification(
  sql: Sql,
  input: NewNotification
): Promise<RaiseResult> {
  const result = await sql.query(
    `insert into notifications
       (pharmacy_id, user_id, type, status, title, body, related_type, related_id,
        dedupe_key, not_sent_reason, sent_at)
     values ($1, $2, $3::notification_type, $4::notification_status, $5, $6, $7, $8,
             $9, $10, $11)
     on conflict (pharmacy_id, dedupe_key) do nothing
     returning ${NOTIFICATION_COLUMNS}`,
    [
      input.pharmacyId,
      input.userId ?? null,
      input.type,
      input.status,
      input.title,
      input.body,
      input.relatedType,
      input.relatedId,
      input.dedupeKey,
      input.notSentReason,
      input.sentAt ?? null,
    ]
  );
  const inserted = result.rows[0];
  // `rowCount === 0` and no returned row are the same fact seen twice: the
  // unique index already held this key. Not an error, and not worth a second
  // query to fetch the existing row — a scan reports a count, not a list.
  return inserted === undefined
    ? { raised: false, notification: null }
    : { raised: true, notification: mapNotification(inserted) };
}

/**
 * The notification list, newest first.
 *
 * `any($3::notification_type[])` rather than an IN list built by string
 * concatenation: the array is one parameter, so the number of types cannot
 * change the number of placeholders and nothing about a caller's input reaches
 * the statement as SQL text.
 *
 * `coalesce($4::boolean, false) = false` reads as "either unread-only was not
 * asked for, or the row is unread". Written that way round rather than
 * `$4 = true and read_at is null` because the parameter is nullable and a
 * comparison against null is null, which is not false — the row would be
 * dropped by a filter nobody applied.
 */
export async function listNotifications(
  sql: Sql,
  pharmacyId: string,
  filters: NotificationFilters
): Promise<NotificationRow[]> {
  const types = filters.types !== undefined && filters.types.length > 0 ? [...filters.types] : null;
  const unreadOnly = filters.unreadOnly === true ? true : null;

  const result = await sql.query(
    `select ${NOTIFICATION_COLUMNS} from notifications
      where pharmacy_id = $1
        and ${VISIBILITY}
        and ($3::notification_type[] is null or type = any($3::notification_type[]))
        and (coalesce($4::boolean, false) = false or read_at is null)
      order by created_at desc, id desc
      limit $5 offset $6`,
    [pharmacyId, filters.visibleTo ?? null, types, unreadOnly, filters.limit, filters.offset]
  );
  return result.rows.map(mapNotification);
}

/**
 * How many notifications this user has not read. The bell's badge.
 *
 * Counted rather than derived from the list: the list is paginated, so a caller
 * paging through twenty would otherwise see a badge that changed as they paged.
 */
export async function countUnread(
  sql: Sql,
  pharmacyId: string,
  userId: string
): Promise<number> {
  const result = await sql.query(
    `select count(*)::int as n from notifications
      where pharmacy_id = $1
        and read_at is null
        and ${VISIBILITY}`,
    [pharmacyId, userId]
  );
  const first = result.rows[0];
  return first === undefined ? 0 : (first.n as number);
}

/**
 * Marks one notification read, and returns null if it is not this user's to read.
 *
 * `coalesce(read_at, $4)` keeps the first reader's timestamp. A broadcast read
 * by two people an hour apart has one `read_at` and the useful fact is when
 * somebody first saw it, not when the most recent person clicked the same row —
 * which without the coalesce would also move on every click and make the bell's
 * ordering jitter.
 *
 * `at` is a parameter rather than `now()` so the caller's clock and the row's
 * timestamp agree with everything else written in the same request.
 */
export async function markRead(
  sql: Sql,
  pharmacyId: string,
  userId: string,
  notificationId: string,
  at: string
): Promise<NotificationRow | null> {
  const result = await sql.query(
    `update notifications
        set read_at = coalesce(read_at, $4)
      where pharmacy_id = $1
        and id = $3
        and ${VISIBILITY}
      returning ${NOTIFICATION_COLUMNS}`,
    [pharmacyId, userId, notificationId, at]
  );
  const updated = result.rows[0];
  return updated === undefined ? null : mapNotification(updated);
}

/**
 * Marks everything this user can see as read, and says how many that was.
 *
 * Scoped to `read_at is null`, so the count is "how many I just read" rather
 * than "how many rows matched" — and so a bell cleared twice in a row reports
 * zero the second time instead of re-touching rows nobody had opened since.
 *
 * Only `id` comes back. Counting rows does not need fifteen columns each, and a
 * pharmacy with a year of unread alerts would otherwise haul the lot across the
 * wire to arrive at a number.
 */
export async function markAllRead(
  sql: Sql,
  pharmacyId: string,
  userId: string,
  at: string
): Promise<number> {
  const result = await sql.query(
    `update notifications
        set read_at = $3
      where pharmacy_id = $1
        and read_at is null
        and ${VISIBILITY}
      returning id`,
    [pharmacyId, userId, at]
  );
  return result.rows.length;
}
