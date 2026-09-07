import fs from 'node:fs';
import path from 'node:path';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Sql } from '../database/pool';
import {
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
  raiseNotification,
  type NewNotification,
  type NotificationFilters,
} from '../repositories/notifications.repository';

/**
 * The SQL the notifications repository emits.
 *
 * `alerts.service.ts` decides *which* alerts are worth raising and builds the
 * dedupe keys; `engagement.service.ts` does the same for patient reminders. This
 * module decides three things none of them can: whether a notification is new,
 * who is allowed to see it, and when it was read.
 *
 * Four of the failures pinned here are invisible in any service test, because a
 * service test mocks this module and so never sees a statement at all:
 *
 *   - An `on conflict` target that does not exactly match a real unique index is
 *     refused by Postgres at runtime, not at compile time. Every scan would 500
 *     and the panel would go quiet — which looks like "no alerts", which is also
 *     what a working scan looks like on a day when stock is fine.
 *   - An empty `types` array pushed as a parameter becomes `= any('{}')`, which
 *     is valid SQL matching no row. Again no error, again an empty panel.
 *   - A nullable filter parameter compared directly (`$4 = true`) yields NULL
 *     when the caller supplied no filter, and NULL is not false. The row is
 *     dropped by a filter nobody applied, and the bell renders empty.
 *   - `count(*)` without `::int` arrives from node-postgres as a string, because
 *     the server types it bigint. `unread === 0` is then false for `"0"`, so a
 *     bell with nothing in it reads as a bell with something in it.
 *
 * The harness proves all four against a real server: 11h executes the wrong
 * conflict target and requires SQLSTATE 42P10, 11e executes the empty array,
 * 11k binds every filter parameter to NULL and requires the rows back, 11i and
 * 11m prove the visibility clause on a read and on a write, 11j proves
 * `coalesce` keeps the first reader's instant, and 11l proves mark-all-read
 * counts only the rows it actually touched. The last describe block here is the
 * tie between those statements and these.
 *
 * This file was `alerts.repository.test.ts` until Phase 8, when it asserted nine
 * bound values with a note that making `user_id` a parameter later would mean
 * renumbering eight placeholders and that this assertion would point at it.
 * Phase 8 made it a parameter, because a refill reminder belongs to one
 * pharmacist and a stock alert belongs to the pharmacy, and one statement has to
 * serve both. It did point at it.
 */

interface Call {
  text: string;
  params: unknown[];
}

/** Collapses whitespace, so a reformat is not a failure but a rewrite is. */
function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

const STAMP = new Date('2026-03-15T09:00:00.000Z');
const STAMP_ISO = '2026-03-15T09:00:00.000Z';

function fakeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a0000000-0000-4000-8000-000000000030',
    pharmacy_id: 'a0000000-0000-4000-8000-000000000001',
    user_id: null,
    type: 'stock_reorder',
    status: 'not_sent',
    title: 'Paracetamol 500mg is at or below its reorder level',
    body: '4 units left, reorder level 20.',
    related_type: 'inventory',
    related_id: 'a0000000-0000-4000-8000-000000000010',
    dedupe_key: 'stock_reorder:a0000000-0000-4000-8000-000000000010:2026-03-15',
    not_sent_reason: 'Shown in the app only — no SMS provider is configured.',
    sent_at: null,
    read_at: null,
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  };
}

type Outcome = { rows: Record<string, unknown>[] } | { error: unknown };

interface Recorder {
  sql: Sql;
  calls: Call[];
  queueRows: (rows: Record<string, unknown>[]) => void;
  queueError: (error: unknown) => void;
}

/**
 * Records every call and then decides what to answer.
 *
 * One implementation rather than `mockResolvedValueOnce` replacing it: a
 * replacement would skip the recording, and half of what is asserted here is how
 * many statements were issued, not what they said.
 */
function recorder(): Recorder {
  const calls: Call[] = [];
  const scripted: Outcome[] = [];
  const fallback: Record<string, unknown>[] = [fakeRow()];

  const sql: Sql = {
    query<T extends QueryResultRow>(
      text: string,
      values?: readonly unknown[]
    ): Promise<QueryResult<T>> {
      calls.push({ text: normalise(text), params: [...(values ?? [])] });

      const outcome = scripted.shift();
      if (outcome !== undefined && 'error' in outcome) {
        return Promise.reject(outcome.error);
      }
      const rows = outcome !== undefined ? outcome.rows : fallback;
      return Promise.resolve({
        rows: rows as unknown as T[],
        rowCount: rows.length,
        oid: 0,
        fields: [],
        command: '',
      });
    },
  };

  return {
    sql,
    calls,
    queueRows: (rows) => scripted.push({ rows }),
    queueError: (error) => scripted.push({ error }),
  };
}

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const PRODUCT = 'a0000000-0000-4000-8000-000000000010';
const PATIENT = 'a0000000-0000-4000-8000-000000000040';
const OWNER = 'a0000000-0000-4000-8000-000000000002';
const OTHER_USER = 'a0000000-0000-4000-8000-000000000003';
const NOTIFICATION = 'a0000000-0000-4000-8000-000000000030';

const NOT_SENT_REASON = 'Shown in the app only — no SMS provider is configured.';

/** A broadcast: a stock alert belongs to the pharmacy, not to whoever looked first. */
const REORDER_ALERT: NewNotification = {
  pharmacyId: PHARMACY,
  type: 'stock_reorder',
  title: 'Paracetamol 500mg is at or below its reorder level',
  body: '4 units left, reorder level 20.',
  relatedType: 'inventory',
  relatedId: PRODUCT,
  dedupeKey: `stock_reorder:${PRODUCT}:2026-03-15`,
  status: 'not_sent',
  notSentReason: NOT_SENT_REASON,
};

/** A targeted row: a refill reminder is one pharmacist's to chase. */
const REFILL_REMINDER: NewNotification = {
  pharmacyId: PHARMACY,
  userId: OWNER,
  type: 'refill_reminder',
  title: 'Mrs. Mensah is due a refill',
  body: 'Amlodipine 5mg, due 2026-03-18.',
  relatedType: 'patient',
  relatedId: PATIENT,
  dedupeKey: `refill:${PATIENT}`,
  status: 'not_sent',
  notSentReason: NOT_SENT_REASON,
};

/**
 * The visibility clause, spelled exactly as the repository spells it.
 *
 * Asserted as one string against four statements rather than four times against
 * one each: the point is that the rule has a single spelling, so a future edit
 * cannot tighten the list and leave the count behind.
 */
const VISIBILITY = '($2::uuid is null or user_id is null or user_id = $2::uuid)';

function onlyCall(calls: Call[]): Call {
  if (calls.length !== 1) {
    throw new Error(`expected exactly one query, saw ${calls.length}: ${JSON.stringify(calls)}`);
  }
  const first = calls[0];
  if (first === undefined) throw new Error('unreachable: the length was checked above');
  return first;
}

/**
 * Every statement shape this repository can emit, driven exactly once each.
 *
 * Shared by the drift guard in both directions, so the two halves of the
 * comparison cannot be driven by different lists and quietly stop covering the
 * same statements. `inventory.repository.test.ts` had two such lists and they
 * drifted; this one starts as one.
 *
 * `listNotifications` appears once although it accepts eight filter
 * combinations, because it now emits one statement for all of them — a
 * combination-specific drive would be re-asserting a shape that no longer
 * exists. The invariance itself is proven in its own describe block.
 */
async function everyStatementShape(): Promise<Call[]> {
  const { sql, calls } = recorder();

  await raiseNotification(sql, REORDER_ALERT);
  await listNotifications(sql, PHARMACY, { limit: 50, offset: 0 });
  await countUnread(sql, PHARMACY, OWNER);
  await markRead(sql, PHARMACY, OWNER, NOTIFICATION, STAMP_ISO);
  await markAllRead(sql, PHARMACY, OWNER, STAMP_ISO);

  return calls;
}

describe('raiseNotification', () => {
  it('is one statement, so the database decides the duplicate rather than a prior read', async () => {
    const { sql, calls } = recorder();

    await raiseNotification(sql, REORDER_ALERT);

    // The shape this test exists for. Selecting first and inserting if absent is
    // a race with a window exactly as wide as the two round trips between the
    // read and the write, and the failure is a duplicate reminder — the thing the
    // unique index exists to prevent, and the thing Phase 8's acceptance line
    // asks to see proven. One statement means there is no window.
    expect(calls).toHaveLength(1);
    expect(onlyCall(calls).text).toContain(
      'on conflict (pharmacy_id, dedupe_key) do nothing returning'
    );
  });

  it('names the composite unique index exactly, because a target that matches nothing is refused at runtime', async () => {
    const { sql, calls } = recorder();

    await raiseNotification(sql, REORDER_ALERT);

    // `unique (pharmacy_id, dedupe_key)` is declared on the notifications table.
    // ON CONFLICT infers its target from a matching index, and if none matches
    // Postgres raises "there is no unique or exclusion constraint matching the ON
    // CONFLICT specification" when the statement runs — not when it compiles, and
    // not in any test that mocks the pool. Naming `dedupe_key` alone here would
    // pass every suite in this repository and 500 every scan in production.
    const text = onlyCall(calls).text;
    expect(text).toContain('on conflict (pharmacy_id, dedupe_key) do nothing');
    expect(text).not.toContain('on conflict (dedupe_key)');
    expect(text).not.toContain('on conflict do nothing');
  });

  it('casts both enum parameters, and returns the row it inserted', async () => {
    const { sql, calls } = recorder();

    await raiseNotification(sql, REORDER_ALERT);

    const text = onlyCall(calls).text;
    expect(text).toContain('$3::notification_type');
    expect(text).toContain('$4::notification_status');
    // Without `returning` there is no row to look at, `rows[0]` is always
    // undefined, and every alert reports `raised: false` — a scan that appears to
    // work while telling the caller it never raised anything.
    expect(text).toContain('returning');
  });

  it('binds ten values for ten columns, with the broadcast written as a null user', async () => {
    const { sql, calls } = recorder();

    await raiseNotification(sql, REORDER_ALERT);

    const call = onlyCall(calls);
    expect(call.text).toContain('values ($1, $2, $3::notification_type');
    expect(call.params).toEqual([
      PHARMACY,
      null,
      'stock_reorder',
      'not_sent',
      'Paracetamol 500mg is at or below its reorder level',
      '4 units left, reorder level 20.',
      'inventory',
      PRODUCT,
      `stock_reorder:${PRODUCT}:2026-03-15`,
      NOT_SENT_REASON,
      null,
    ]);
    // An omitted `userId` is a broadcast, and that is a decision rather than a
    // default: a stock alert belongs to the pharmacy, so targeting it at whoever
    // ran the scan would mean the first person to look owns it and nobody else is
    // told. The null is written through `$2` rather than into the statement text
    // so that the same shape serves a targeted reminder below.
    // The trailing null is `sent_at`, folded from an omitted `sentAt`: a stock
    // alert is never delivered anywhere, and the eleventh parameter exists so that
    // a reminder which *was* delivered can say when without a second statement.
    expect(call.params).toHaveLength(11);
  });

  it('targets one user when the notification is aimed at one, through the same statement', async () => {
    const { sql, calls } = recorder();

    await raiseNotification(sql, REORDER_ALERT);
    const broadcast = onlyCall(calls);

    calls.length = 0;
    await raiseNotification(sql, REFILL_REMINDER);
    const targeted = onlyCall(calls);

    // Same text, different second parameter. That is the whole point of making
    // `user_id` a parameter instead of a literal: one shape serves both, so the
    // harness has one PREPARE for it and section 11 parses it once.
    expect(targeted.text).toBe(broadcast.text);
    expect(targeted.params[1]).toBe(OWNER);
    expect(targeted.params[2]).toBe('refill_reminder');
    expect(targeted.params[8]).toBe(`refill:${PATIENT}`);
    expect(targeted.params).toHaveLength(11);
  });

  it('writes the instant a message went out, so `sent` is a claim with evidence beside it', async () => {
    const { sql, calls } = recorder();

    await raiseNotification(sql, {
      ...REFILL_REMINDER,
      status: 'sent',
      notSentReason: null,
      sentAt: '2026-03-15T09:05:00.000Z',
    });

    // The mirror image of `not_sent_reason`, and the reason the eleventh parameter
    // exists. A bell entry saying `sent` with `sent_at` null is a claim nobody can
    // check, so "I never got it" becomes an argument instead of a lookup. The column
    // was always in the schema; what was missing was a way to write it, which meant
    // the first caller to raise a delivered notification would have produced exactly
    // that row.
    const sent = onlyCall(calls);
    expect(sent.text).toContain('dedupe_key, not_sent_reason, sent_at)');
    expect(sent.text).toContain('$9, $10, $11)');
    expect(sent.params[3]).toBe('sent');
    expect(sent.params[9]).toBe(null);
    expect(sent.params[10]).toBe('2026-03-15T09:05:00.000Z');

    // And it is still one statement: the same text serves a delivered and an
    // undelivered notification, so section 11 parses it once and the harness has one
    // PREPARE for both.
    calls.length = 0;
    await raiseNotification(sql, REORDER_ALERT);
    expect(onlyCall(calls).text).toBe(sent.text);
  });

  it('reports raised, with the new row, when the insert landed', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow()]);

    const result = await raiseNotification(sql, REORDER_ALERT);

    expect(result.raised).toBe(true);
    expect(result.notification?.dedupeKey).toBe(`stock_reorder:${PRODUCT}:2026-03-15`);
  });

  it('reports not raised, with no row and no second query, when the key was already held', async () => {
    const { sql, calls, queueRows } = recorder();
    // `on conflict do nothing` with `returning` yields zero rows. That is not an
    // error and not an empty result to be retried: it is the answer.
    queueRows([]);

    const result = await raiseNotification(sql, REORDER_ALERT);

    expect(result).toEqual({ raised: false, notification: null });
    // And it does not go and fetch the existing row. A scan reports a count of
    // what it raised, so a second round trip per suppressed reminder would be
    // paid on every refresh for a value nobody reads.
    expect(calls).toHaveLength(1);
  });

  it('lets a unique violation on some other index surface, rather than reading it as a dedupe', async () => {
    const { sql, queueError } = recorder();
    const other = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'some_future_index',
    });
    queueError(other);

    // The conflict clause absorbs one specific index. If another unique index is
    // added to notifications later, a violation on it arrives here as a thrown
    // 23505, and a bare `catch` that answered `raised: false` would report a
    // constraint failure as an ordinary duplicate — the reminder would be
    // silently lost and the log would say nothing.
    await expect(raiseNotification(sql, REORDER_ALERT)).rejects.toBe(other);
  });
});

describe('listNotifications', () => {
  /**
   * Every combination the filters can be asked for, including the two that used
   * to produce a different statement each and the three that produce a null.
   */
  const COMBINATIONS: NotificationFilters[] = [
    { limit: 50, offset: 0 },
    { types: [], limit: 50, offset: 0 },
    { types: ['stock_reorder'], limit: 50, offset: 0 },
    { types: ['stock_reorder', 'stock_expiry', 'product_recall'], limit: 20, offset: 40 },
    { visibleTo: OWNER, limit: 50, offset: 0 },
    { visibleTo: null, limit: 50, offset: 0 },
    { unreadOnly: true, limit: 50, offset: 0 },
    { unreadOnly: false, limit: 50, offset: 0 },
    { types: ['refill_reminder'], visibleTo: OWNER, unreadOnly: true, limit: 20, offset: 0 },
  ];

  it('is one statement for every filter combination, so no shape reaches production unparsed', async () => {
    const { sql, calls } = recorder();

    for (const filters of COMBINATIONS) {
      await listNotifications(sql, PHARMACY, filters);
    }

    expect(calls).toHaveLength(COMBINATIONS.length);
    // The whole reason the builder went. With a `where` clause spliced together
    // per combination, a combination no test happened to drive was a statement
    // no test had ever produced and section 11 of the harness had never parsed —
    // and the missing one is always the one a new page asks for first.
    expect([...new Set(calls.map((call) => call.text))]).toHaveLength(1);
    for (const [index, call] of calls.entries()) {
      expect({ index, placeholders: call.params.length }).toEqual({ index, placeholders: 6 });
    }
  });

  it('scopes to the pharmacy, orders newest first, and breaks a created_at tie on id', async () => {
    const { sql, calls } = recorder();

    await listNotifications(sql, PHARMACY, { limit: 50, offset: 0 });

    const text = onlyCall(calls).text;
    expect(text).toContain('from notifications where pharmacy_id = $1');
    // `id desc` matters because two reminders raised in the same scan land in the
    // same transaction and can share a `created_at` to the microsecond. Without a
    // tie-break the bell can reorder between two refreshes of the same data,
    // which reads as a reminder disappearing.
    expect(text).toContain('order by created_at desc, id desc');
    expect(text).toContain('limit $5 offset $6');
    expect(onlyCall(calls).params).toEqual([PHARMACY, null, null, null, 50, 0]);
  });

  it('binds an empty type list as null, because an empty array matches nothing', async () => {
    const { sql, calls } = recorder();

    await listNotifications(sql, PHARMACY, { types: [], limit: 50, offset: 0 });

    // The trap. Pushing an empty array gives `type = any($3::notification_type[])`
    // bound to `'{}'`, which is valid SQL and matches no row. The bell renders
    // empty, no error is logged, and the only visible difference from a quiet day
    // is that reminders never appear again. Section 11e of the harness executes
    // exactly that and requires zero rows back.
    const call = onlyCall(calls);
    expect(call.text).toContain('any($3::notification_type[])');
    expect(call.params[2]).toBeNull();
  });

  it('passes the types as one array parameter, so the shape cannot depend on how many were asked for', async () => {
    const { sql, calls } = recorder();

    await listNotifications(sql, PHARMACY, { types: ['stock_reorder'], limit: 50, offset: 0 });
    const one = onlyCall(calls);

    calls.length = 0;
    await listNotifications(sql, PHARMACY, {
      types: ['stock_reorder', 'stock_expiry', 'product_recall'],
      limit: 50,
      offset: 0,
    });
    const three = onlyCall(calls);

    // An IN list built by concatenation would make the placeholder count a
    // function of the caller's input, and would put a value into the statement as
    // SQL text. One array parameter means the statement is identical either way
    // and nothing a caller typed is ever parsed.
    expect(one.text).toBe(three.text);
    expect(Array.isArray(three.params[2])).toBe(true);
    expect(three.params[2]).toEqual(['stock_reorder', 'stock_expiry', 'product_recall']);
  });

  it('binds the asking user at $2, and null when nobody was named', async () => {
    const { sql, calls } = recorder();

    await listNotifications(sql, PHARMACY, { visibleTo: OTHER_USER, limit: 50, offset: 0 });
    expect(onlyCall(calls).params[1]).toBe(OTHER_USER);

    calls.length = 0;
    await listNotifications(sql, PHARMACY, { limit: 50, offset: 0 });
    // Null here is not "show me nothing". The leading `is null` branch of the
    // visibility clause is what makes it "show me everything", which is what the
    // stock alert panel asks for. `TRUE OR NULL` is TRUE, and without that branch
    // the disjunction would evaluate `user_id = NULL` — NULL, not false — and the
    // panel would be empty. Section 11i executes both sides.
    expect(onlyCall(calls).text).toContain(VISIBILITY);
    expect(onlyCall(calls).params[1]).toBeNull();
  });

  it('folds an explicit false unread-only into the same null as an omitted one', async () => {
    const { sql, calls } = recorder();

    await listNotifications(sql, PHARMACY, { unreadOnly: false, limit: 50, offset: 0 });
    const off = onlyCall(calls).params[3];

    calls.length = 0;
    await listNotifications(sql, PHARMACY, { limit: 50, offset: 0 });
    const omitted = onlyCall(calls).params[3];

    // `false` and "not asked" are the same request, and binding `false` would
    // still be safe — but binding one value for one meaning keeps the parameter's
    // domain at two states rather than three, which is what 11k asserts against.
    expect(off).toBeNull();
    expect(omitted).toBeNull();

    calls.length = 0;
    await listNotifications(sql, PHARMACY, { unreadOnly: true, limit: 50, offset: 0 });
    expect(onlyCall(calls).params[3]).toBe(true);
    expect(onlyCall(calls).text).toContain('(coalesce($4::boolean, false) = false or read_at is null)');
  });

  it('numbers placeholders contiguously in every statement this repository emits', async () => {
    const calls = await everyStatementShape();

    // A gap or a repeat means a parameter was bound that the statement does not
    // read, or read that was not bound. node-postgres throws on the second and
    // silently ignores the first, and the first is how `markRead`'s `$4` would
    // end up carrying the notification id after a careless renumber.
    for (const [index, call] of calls.entries()) {
      const used = [...call.text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      expect({ index, distinct: [...new Set(used)].sort((left, right) => left - right) }).toEqual({
        index,
        distinct: call.params.map((_value, position) => position + 1),
      });
    }
  });

  it('spells the visibility rule identically in every statement that touches an existing row', async () => {
    const calls = await everyStatementShape();

    // Four of the five: the list, the badge and both updates. The insert is the
    // exception and should be, because it writes `user_id` rather than filtering
    // on it. A fifth statement appearing here without the clause would be a read
    // or a write that forgot who is allowed to see the row.
    const withVisibility = calls.filter((call) => call.text.includes(VISIBILITY));
    expect(withVisibility).toHaveLength(4);
    expect(calls[0]?.text).not.toContain(VISIBILITY);
  });
});

describe('countUnread', () => {
  it('casts the count to int, because pg hands a bigint back as a string', async () => {
    const { sql, calls } = recorder();

    await countUnread(sql, PHARMACY, OWNER);

    const text = onlyCall(calls).text;
    expect(text).toContain('count(*)::int as n');
    expect(text).toContain('read_at is null');
    expect(text).toContain(VISIBILITY);
    expect(onlyCall(calls).params).toEqual([PHARMACY, OWNER]);
  });

  it('returns a number, so a badge of zero compares equal to zero', async () => {
    const { sql, queueRows } = recorder();
    queueRows([{ n: 0 }]);

    const unread = await countUnread(sql, PHARMACY, OWNER);

    // Without the cast this is the string `'0'`, and `unread === 0` is false for
    // it. A bell holding nothing would then render as a bell holding something,
    // which is the one failure a badge cannot survive: staff stop trusting it and
    // stop looking.
    expect(unread).toBe(0);
    expect(typeof unread).toBe('number');
  });

  it('counts rather than reading the list, so the badge does not move while paging', async () => {
    const { sql, calls } = recorder();

    await countUnread(sql, PHARMACY, OWNER);

    // One statement, and not `select ...` over the paginated list. A badge
    // derived from the page in hand would change as the user paged through it, so
    // the number beside the bell would disagree with the number they counted.
    expect(calls).toHaveLength(1);
    expect(onlyCall(calls).text).not.toContain('limit');
  });

  it('answers zero when the server returns no row at all', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    // An aggregate always returns one row, so this is belt and braces — but a
    // `rows[0].n` that threw on an empty result would turn a quiet pharmacy into
    // a 500 on the dashboard's first load.
    await expect(countUnread(sql, PHARMACY, OWNER)).resolves.toBe(0);
  });
});

describe('markRead', () => {
  it('keeps the first read_at with coalesce, and puts the timestamp at $4', async () => {
    const { sql, calls } = recorder();

    await markRead(sql, PHARMACY, OWNER, NOTIFICATION, STAMP_ISO);

    const call = onlyCall(calls);
    expect(call.text).toContain('set read_at = coalesce(read_at, $4)');
    expect(call.text).toContain('and id = $3');
    expect(call.params).toEqual([PHARMACY, OWNER, NOTIFICATION, STAMP_ISO]);
    // A broadcast has one `read_at` for the whole pharmacy, so a second click an
    // hour later must not move it: the useful fact is when somebody first saw it.
    // Plain `set read_at = $4` would pass every test here and quietly rewrite
    // that fact on every click. Section 11j executes both and compares.
    expect(call.text).not.toContain('set read_at = $4');
  });

  it('carries the visibility clause, so refusing somebody else\'s reminder is the database\'s job', async () => {
    const { sql, calls } = recorder();

    await markRead(sql, PHARMACY, OWNER, NOTIFICATION, STAMP_ISO);

    expect(onlyCall(calls).text).toContain(VISIBILITY);
  });

  it('returns null when nothing matched, which is how a reminder aimed at somebody else is refused', async () => {
    const { sql, queueRows } = recorder();
    queueRows([]);

    // The same null answers three different questions — no such notification,
    // another pharmacy's, another user's — and that is deliberate. Distinguishing
    // them would tell a caller which ids exist, which is the enumeration
    // `utils/http.ts`'s `notFound` is written to avoid. Section 11m executes the
    // cross-user case against a real row and requires nothing back.
    await expect(markRead(sql, PHARMACY, OTHER_USER, NOTIFICATION, STAMP_ISO)).resolves.toBeNull();
  });

  it('returns the mapped row when it did match', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow({ read_at: STAMP })]);

    const row = await markRead(sql, PHARMACY, OWNER, NOTIFICATION, STAMP_ISO);

    expect(row?.readAt).toBe(STAMP_ISO);
    expect(row?.id).toBe(NOTIFICATION);
  });
});

describe('markAllRead', () => {
  it('scopes to rows nobody has read, so the count is what this call changed', async () => {
    const { sql, calls } = recorder();
    await markAllRead(sql, PHARMACY, OWNER, STAMP_ISO);

    const text = onlyCall(calls).text;
    expect(text).toContain('and read_at is null');
    expect(text).toContain(VISIBILITY);
    expect(text).toContain('set read_at = $3');
    expect(onlyCall(calls).params).toEqual([PHARMACY, OWNER, STAMP_ISO]);
  });

  it('returns only the ids, because counting does not need fifteen columns each', async () => {
    const { sql, calls } = recorder();

    await markAllRead(sql, PHARMACY, OWNER, STAMP_ISO);

    // A pharmacy with a year of unread alerts would otherwise haul every column
    // of every row across the wire to arrive at a number.
    expect(onlyCall(calls).text).toContain('returning id');
    expect(onlyCall(calls).text).not.toContain('returning id, pharmacy_id');
  });

  it('counts the rows it moved, and reports zero the second time round', async () => {
    const { sql, queueRows } = recorder();
    queueRows([{ id: 'a' }, { id: 'b' }]);
    await expect(markAllRead(sql, PHARMACY, OWNER, STAMP_ISO)).resolves.toBe(2);

    queueRows([]);
    // Clearing the bell twice in a row is a normal thing for a person to do, and
    // the second press reporting "3 cleared" again would be a lie about work the
    // first press already did. Section 11l executes both presses.
    await expect(markAllRead(sql, PHARMACY, OWNER, STAMP_ISO)).resolves.toBe(0);
  });
});

describe('the mapped row', () => {
  it('maps every column, turning timestamps into ISO strings and leaving nulls null', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow({ sent_at: new Date('2026-03-15T09:05:00.000Z'), read_at: null })]);

    const [row] = await listNotifications(sql, PHARMACY, { limit: 50, offset: 0 });

    expect(row).toEqual({
      id: NOTIFICATION,
      pharmacyId: PHARMACY,
      userId: null,
      type: 'stock_reorder',
      status: 'not_sent',
      title: 'Paracetamol 500mg is at or below its reorder level',
      body: '4 units left, reorder level 20.',
      relatedType: 'inventory',
      relatedId: PRODUCT,
      dedupeKey: `stock_reorder:${PRODUCT}:2026-03-15`,
      notSentReason: NOT_SENT_REASON,
      sentAt: '2026-03-15T09:05:00.000Z',
      readAt: null,
      createdAt: '2026-03-15T09:00:00.000Z',
      updatedAt: '2026-03-15T09:00:00.000Z',
    });
  });

  it('keeps a targeted row\'s user, because the bell has to say who a reminder was aimed at', async () => {
    const { sql, queueRows } = recorder();
    queueRows([
      fakeRow({
        user_id: OWNER,
        type: 'refill_reminder',
        related_type: 'patient',
        related_id: PATIENT,
        dedupe_key: `refill:${PATIENT}`,
      }),
    ]);

    const [row] = await listNotifications(sql, PHARMACY, { limit: 50, offset: 0 });

    expect(row?.userId).toBe(OWNER);
    expect(row?.relatedType).toBe('patient');
    expect(row?.relatedId).toBe(PATIENT);
  });

  it('keeps the reason beside a not_sent row, because that status is a true statement rather than a silent one', async () => {
    const { sql, queueRows } = recorder();
    queueRows([fakeRow()]);

    const [row] = await listNotifications(sql, PHARMACY, { limit: 50, offset: 0 });

    // Nothing was attempted, because no SMS provider is configured. Dropping
    // `notSentReason` on the way out would leave the UI showing a status that
    // reads like a failure with nothing beside it to say otherwise — and the
    // honest version is the one the plan asks for.
    expect(row?.status).toBe('not_sent');
    expect(row?.notSentReason).toBe(NOT_SENT_REASON);
    expect(row?.sentAt).toBeNull();
  });
});

describe('the Postgres harness carries these same statements', () => {
  // Pinning SQL as text proves the repository builds what we intend and nothing
  // more. In particular it cannot tell us that `on conflict (pharmacy_id,
  // dedupe_key)` matches a real unique index, nor that a NULL filter parameter
  // really does mean "no filter" rather than "match nothing".
  //
  // Neither can the harness's PREPARE, which is worth recording because it is the
  // obvious thing to assume: with the target reduced to `(dedupe_key)`, matching
  // no index on notifications, every PREPARE in section 11 still succeeded and
  // the harness still exited 0. Arbiter index inference is resolved by the
  // planner, so a parse never reaches it.
  //
  // What proves it is the executed half — 11b-11d dedupe through the right
  // target, 11h requires 42P10 from the wrong one, 11i-11m execute the
  // visibility clause and the coalesce. The chain is: this guard ties the
  // repository's text to the harness's copy, and the harness runs that shape.
  const harnessPath = path.resolve(
    __dirname, '..', '..', '..', 'database', 'tests', 'assertions.sql'
  );

  function harnessStatements(): Set<string> {
    const source = fs.readFileSync(harnessPath, 'utf8');
    // Scoped to this repository's prefix. Sections 6, 9, 10 and 13 prepare other
    // repositories' statements; counting those as ours would let a stale
    // notification statement hide among them.
    const bodies = [...source.matchAll(/prepare\s+notifications_repo_\w+\s+as\s+([\s\S]*?);/g)].map(
      (match) => match[1]
    );
    if (bodies.length === 0) {
      throw new Error(
        `no \`prepare notifications_repo_* as\` statements found in ${harnessPath}; section 11 ` +
          'of the harness is what executes these shapes, refuses a non-matching ON CONFLICT ' +
          'target and binds every filter parameter to NULL, so restore it rather than deleting ' +
          'this test'
      );
    }
    return new Set(bodies.map((body) => normalise(body ?? '')));
  }

  it('proves each of them against the harness, and fails naming any it has lost', async () => {
    const statements = (await everyStatementShape()).map((call) => call.text);
    const harness = harnessStatements();

    // Guarding the guard: if the drive stopped issuing statements the comparison
    // below would pass against nothing. Five functions, five statements.
    expect([...new Set(statements)]).toHaveLength(5);

    const missing = [...new Set(statements)].filter((statement) => !harness.has(statement));
    expect(missing).toEqual([]);
  });

  it('has no prepared statement in the harness that the repository no longer emits', async () => {
    const statements = new Set((await everyStatementShape()).map((call) => call.text));
    const harness = harnessStatements();

    // The other direction: a prepared statement left behind after the repository
    // changed would keep the harness green for a shape nothing produces, while the
    // real shape went unproven. This is the direction that caught the collapse of
    // two list statements into one.
    const stale = [...harness].filter((statement) => !statements.has(statement));
    expect(stale).toEqual([]);
  });
});
