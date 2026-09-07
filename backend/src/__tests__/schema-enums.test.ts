import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { USER_ROLES } from '../utils/permissions';
import {
  CONSULTATION_STATUSES,
  CONSULTATION_TYPES,
  GENDERS,
  MOVEMENT_TYPES,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  PRESCRIPTION_STATUSES,
  REMINDER_KINDS,
  RISK_LEVELS,
  SALE_PAYMENT_METHODS,
  SALE_PAYMENT_STATUSES,
  SALE_STATUSES,
  SCREENING_TYPES,
  SELL_UNITS,
  VAT_TREATMENTS,
} from '../utils/schema-enums';

/**
 * The Postgres enums and the TypeScript lists that mirror them.
 *
 * A drift here is not a compile error and not a test failure at the time it is
 * introduced. It is a 22P02 (`invalid input value for enum`) at the counter, on
 * the day somebody sells with the new value for the first time — which is the
 * worst possible moment to discover that the API accepted a word the database
 * has never heard. This suite reads the schema instead of repeating it, so the
 * two sides cannot drift without a red build.
 *
 * It reads the SQL rather than trusting a hand-written copy of it for the same
 * reason `route-protection.test.ts` walks the real router: a test that restates
 * the thing it checks agrees with itself forever.
 */

const DATABASE_DIR = path.resolve(__dirname, '..', '..', '..', 'database');
const MIGRATIONS_DIR = path.join(DATABASE_DIR, 'migrations');

/**
 * Drops `--` line comments.
 *
 * Necessary rather than cosmetic: init.sql explains the enum-shrinking problem
 * in a comment that literally contains the words `ALTER TYPE ... ADD VALUE`, and
 * a migration scan that read comments would act on prose. Nothing here parses
 * dollar-quoted function bodies — no trigger body in this schema defines an enum
 * type — and the pinned type count below is what makes that assumption fail
 * loudly rather than quietly if it ever stops being true.
 */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/**
 * Every `create type X as enum (...)` in the file, values in declared order.
 *
 * `[^)]*` spans newlines, which is what lets the multi-line declarations parse
 * without a second pattern; it is safe because an enum value list cannot contain
 * a closing parenthesis.
 */
function parseEnumTypes(sql: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const pattern = /create type (\w+) as enum \(([^)]*)\)/gi;

  for (const match of sql.matchAll(pattern)) {
    const name = match[1];
    const body = match[2];
    if (name === undefined || body === undefined) continue;
    const values = [...body.matchAll(/'([^']*)'/g)].map((value) => value[1] as string);
    found.set(name.toLowerCase(), values);
  }

  return found;
}

/**
 * Applies `alter type ... add value` from a migration, in place.
 *
 * Postgres appends by default and inserts before or after a named neighbour
 * otherwise, so the position is part of the statement and has to be honoured —
 * the TS lists are compared in order, and a migration that inserts a value
 * second would otherwise look identical to one that appends it.
 */
function applyAddedValues(sql: string, types: Map<string, string[]>): void {
  const pattern =
    /alter type (\w+) add value (?:if not exists )?'([^']*)'(?:\s+(before|after)\s+'([^']*)')?/gi;

  for (const match of sql.matchAll(pattern)) {
    const [name, value, position, neighbour] = [match[1], match[2], match[3], match[4]] as [
      string | undefined,
      string | undefined,
      string | undefined,
      string | undefined
    ];
    if (name === undefined || value === undefined) continue;

    const list = types.get(name.toLowerCase());
    if (list === undefined) {
      throw new Error(
        `Migration adds a value to enum type "${name}", which init.sql does not define. ` +
          'Update this suite rather than working around it: an enum grown in a migration ' +
          'and never declared in init.sql means a fresh database and a migrated one disagree.'
      );
    }
    if (list.includes(value)) continue; // `if not exists`, and re-runnable migrations.

    if (position === undefined || neighbour === undefined) {
      list.push(value);
      continue;
    }
    const index = list.indexOf(neighbour);
    if (index === -1) {
      throw new Error(
        `Migration adds "${value}" ${position} "${neighbour}" in enum type "${name}", ` +
          'but that neighbour is not a value of the type. Postgres would refuse this too.'
      );
    }
    list.splice(position.toLowerCase() === 'before' ? index : index + 1, 0, value);
  }
}

/**
 * The vocabulary the database actually has: init.sql, then every migration in
 * filename order.
 *
 * Reading only init.sql would be right today and wrong the day a migration grows
 * an enum — and that day is exactly the day the TS side is most likely to be
 * missed, because the person adding the value is editing SQL.
 */
function sqlEnumVocabulary(): Map<string, string[]> {
  const initSql = stripComments(readFileSync(path.join(DATABASE_DIR, 'init.sql'), 'utf8'));
  const types = parseEnumTypes(initSql);

  // `.sql` but not `.verify.sql`: the verifies assert, they do not change the
  // schema, and reading them too would count a value twice and could pick up a
  // deliberately-broken expectation written to prove a verify fails.
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.verify.sql'))
    .sort();

  for (const file of migrations) {
    applyAddedValues(stripComments(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')), types);
  }

  return types;
}

/**
 * The TS side, keyed by the Postgres type name it mirrors.
 *
 * `user_role` is included from `utils/permissions.ts` rather than
 * `utils/schema-enums.ts`, closing a gap left in Phase 3: `USER_ROLES` was
 * written beside the permission map it indexes and never tied to the
 * `create type user_role` that defines it. A role renamed in SQL and not in TS
 * would have surfaced as a login that authenticated successfully and then failed
 * every authorisation check — a 403 with no obvious cause.
 */
const TS_MIRRORS: Readonly<Record<string, readonly string[]>> = {
  user_role: USER_ROLES,
  sale_status: SALE_STATUSES,
  sale_payment_method: SALE_PAYMENT_METHODS,
  sale_payment_status: SALE_PAYMENT_STATUSES,
  vat_treatment: VAT_TREATMENTS,
  notification_type: NOTIFICATION_TYPES,
  notification_status: NOTIFICATION_STATUSES,
  stock_movement_type: MOVEMENT_TYPES,
  sell_unit: SELL_UNITS,
  gender: GENDERS,
  prescription_status: PRESCRIPTION_STATUSES,
  consultation_type: CONSULTATION_TYPES,
  consultation_status: CONSULTATION_STATUSES,
  screening_type: SCREENING_TYPES,
  risk_level: RISK_LEVELS,
  reminder_kind: REMINDER_KINDS,
};

/**
 * The types deliberately not mirrored yet, with the phase that will need them.
 *
 * Pinned as data rather than left implicit. Without this list, an unmirrored
 * enum is simply absent from the comparison above and the suite says nothing
 * about it; with it, adding a mirror is a two-line change here and adding an
 * enum to the schema without deciding where it lands in TypeScript fails.
 *
 * Empty as of Phase 8, which mirrored the last seven. The mechanism stays:
 * `SQL_TYPES` is compared against the union of both maps, so an enum added to
 * the schema later has to be accounted for here or the suite goes red — and the
 * empty record is what makes "every enum the database defines is mirrored in
 * TypeScript" a claim this suite currently proves rather than aspires to.
 */
const NOT_YET_MIRRORED: Readonly<Record<string, string>> = {};

const SQL_TYPES = sqlEnumVocabulary();

describe('schema enums', () => {
  it('parsed the enum declarations, so the comparisons below are not against nothing', () => {
    // The vacuous-pass guard. If the parse silently returns an empty map —
    // because the file moved, the regex stopped matching, or the schema was
    // rewritten — every `toEqual` below would be comparing a list to `undefined`
    // and failing, but this names the real problem instead.
    expect(SQL_TYPES.size).toBeGreaterThan(0);
    expect([...SQL_TYPES.keys()].sort()).toEqual(
      [...Object.keys(TS_MIRRORS), ...Object.keys(NOT_YET_MIRRORED)].sort()
    );
  });

  it('mirrors each TypeScript list exactly, in declared order', () => {
    // Accumulated across every type and asserted once at the end, rather than
    // failing inside the loop. Seen red for real: with two drifts in the schema
    // at once, the first `expect` threw and the second was never reported, which
    // turns one run into two. A drift guard should show the whole picture — the
    // person fixing it is already context-switching into SQL.
    const drift: string[] = [];

    for (const [typeName, values] of Object.entries(TS_MIRRORS)) {
      const declared = SQL_TYPES.get(typeName);

      if (declared === undefined) {
        // Named as itself rather than left to compare against `undefined`, which
        // prints the whole TS list against nothing and leaves the reader to guess
        // which side moved.
        drift.push(`${typeName}: the schema no longer defines this enum type`);
        continue;
      }

      const missingInTs = declared.filter((value) => !values.includes(value));
      const missingInSql = values.filter((value) => !declared.includes(value));
      if (missingInTs.length > 0) {
        drift.push(`${typeName}: in the schema but not in TypeScript — ${missingInTs.join(', ')}`);
      }
      if (missingInSql.length > 0) {
        drift.push(`${typeName}: in TypeScript but not in the schema — ${missingInSql.join(', ')}`);
      }
      // Checked last and separately: the two lists can hold the same values and
      // still disagree about order, and order is what `enum_range` and any
      // positional `ADD VALUE` in a later migration depend on.
      if (missingInTs.length === 0 && missingInSql.length === 0 && String(values) !== String(declared)) {
        drift.push(
          `${typeName}: same values, different order — TypeScript has [${values.join(', ')}], ` +
            `the schema has [${declared.join(', ')}]`
        );
      }
    }

    expect(drift).toEqual([]);
  });

  it('has decided where every unmirrored enum lands', () => {
    // Not "every enum is mirrored" — that would be false until Phase 8 and would
    // get switched off. Every enum is *accounted for*: either it has a TS list,
    // or it is named here with the phase that will add one.
    //
    // The deferral list is now empty, so this asserts the stronger claim: every
    // enum the schema defines is mirrored. It is kept as the two-map check rather
    // than collapsed into `TS_MIRRORS`, because the day a migration adds an enum
    // the author should be pushed to decide here, not left to discover that a
    // suite somewhere is comparing against nothing.
    const unaccounted: string[] = [];
    for (const typeName of SQL_TYPES.keys()) {
      // Index lookups rather than `Object.hasOwn`, which is ES2022 and this
      // package compiles against lib ES2020. `noUncheckedIndexedAccess` makes
      // the lookup `T | undefined`, so `!== undefined` is a real membership test
      // and not a truthiness guess.
      if (TS_MIRRORS[typeName] === undefined && NOT_YET_MIRRORED[typeName] === undefined) {
        unaccounted.push(typeName);
      }
    }
    expect(unaccounted).toEqual([]);
  });

  it('mirrors every enum the schema defines, now that nothing is deferred', () => {
    // The claim above, stated as a count rather than as an absence of leftovers,
    // so that emptying `NOT_YET_MIRRORED` is proved to be a strengthening and not
    // a way of turning the check off. Pinned to the sixteen types init.sql
    // declares: adding one to the schema without a mirror fails here by name.
    expect(Object.keys(NOT_YET_MIRRORED)).toEqual([]);
    expect(Object.keys(TS_MIRRORS).sort()).toEqual([...SQL_TYPES.keys()].sort());
  });

  it('does not carry a TS list for a type the schema does not define', () => {
    const orphans = [...Object.keys(TS_MIRRORS), ...Object.keys(NOT_YET_MIRRORED)].filter(
      (typeName) => !SQL_TYPES.has(typeName)
    );
    expect(orphans).toEqual([]);
  });

  it('mirrors the two tenders the client asked for, and no others', () => {
    // Pinned here rather than in a Phase 6 suite, because it is a schema fact and
    // it is the one enum whose shape was changed by an explicit instruction after
    // the plan was approved. Postgres cannot drop an enum value, so the list
    // growing is a migration and a decision — not an edit.
    expect(SQL_TYPES.get('sale_payment_method')).toEqual(['cash', 'momo']);
  });

  it('mirrors the movement vocabulary the ledger is written with', () => {
    // `void_restore` is the movement a voided sale writes when it puts stock
    // back. It has no code path until Phase 6, and it is here so that the Phase 6
    // author finds the value already agreed rather than inventing a second word
    // for restoring stock.
    expect(MOVEMENT_TYPES).toContain('void_restore');
    expect(SQL_TYPES.get('stock_movement_type')).toEqual([
      'opening',
      'receive',
      'adjust',
      'write_off',
      'sale',
      'void_restore',
    ]);
  });
});
