import { query } from '../database/pool';
import { HttpError } from '../utils/http';

/**
 * The four tax columns on the one `pharmacies` row.
 *
 * Tax settings live on `pharmacies` rather than in their own table because they
 * are per-pharmacy and there is one pharmacy: a second table would be a join and
 * a foreign key to protect a row that the seed already guarantees exists. The
 * cost of that choice is stated here rather than discovered later — there is no
 * history. A sale snapshots the rates it used, so every receipt still says what
 * it charged, but nothing records who changed the rates or when they last
 * differed from what GRA publishes. That is a real gap for an owner-only setting
 * and Phase 7's settings page is where it becomes visible.
 */

const TAX_COLUMNS =
  'id, tax_inclusive_pricing, vat_rate, nhil_rate, getfund_rate, updated_at';

export interface TaxSettingsRow {
  pharmacyId: string;
  taxInclusivePricing: boolean;
  /**
   * `numeric(5, 4)` as `pg` returns it: a string, four decimal places.
   *
   * `backend/src/database/pg-types.ts` overrides only `date`, deliberately —
   * letting `pg` hand back a JS number for a money or rate column would put the
   * value through a double on its way into the one part of the system that must
   * not. The string is parsed by the shared engine's `parseRate`, which is the
   * single door rates enter by and is tested against all 10,001 values the
   * column can hold.
   */
  vatRate: string;
  nhilRate: string;
  getfundRate: string;
  /** Maintained by the `pharmacies_set_updated_at` trigger, never set here. */
  updatedAt: string;
}

/** The write, already in the form the column stores. See `writeTaxSettings`. */
export interface TaxSettingsWrite {
  taxInclusivePricing: boolean;
  vatRate: string;
  nhilRate: string;
  getfundRate: string;
}

function mapRow(row: Record<string, unknown>): TaxSettingsRow {
  return {
    pharmacyId: row.id as string,
    taxInclusivePricing: row.tax_inclusive_pricing as boolean,
    vatRate: row.vat_rate as string,
    nhilRate: row.nhil_rate as string,
    getfundRate: row.getfund_rate as string,
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export async function readTaxSettings(pharmacyId: string): Promise<TaxSettingsRow> {
  const result = await query(
    `select ${TAX_COLUMNS} from pharmacies where id = $1 limit 1`,
    [pharmacyId]
  );
  const row = result.rows[0];
  if (row === undefined) {
    // 404 rather than a thrown invariant: the message is the same one the staff
    // routes use, so a caller cannot tell a missing pharmacy from somebody
    // else's, and this build having one tenant is not a reason to start
    // answering differently about it.
    throw new HttpError(404, 'No pharmacy matches that id', { code: 'not_found' });
  }
  return mapRow(row);
}

/**
 * Saves all four settings in one statement and returns the row as stored.
 *
 * All four, always. A partial update would let a stale frontend send one field
 * and keep three it had read before somebody else changed them, and the setting
 * that decides every tax figure in the pharmacy is the wrong place for a
 * read-modify-write across two round trips. The form shows all four; the form
 * saves all four.
 *
 * The rates arrive as decimal strings rather than as the engine's
 * ten-thousandths, so nothing here divides by 10,000. `$3::numeric / 10000`
 * would be a third statement of the conversion — the column is one, `parseRate`
 * is another — and a conversion that lives in SQL is one no test in either
 * package can see. `rateDecimalString` in the shared engine produces the string
 * and `money.test.ts` proves it round-trips the whole range back through
 * `parseRate`, so the value written is the value the caller validated.
 *
 * `returning` rather than a second read: the row that comes back is the row the
 * statement wrote, including the `updated_at` the trigger set on the way past.
 */
export async function writeTaxSettings(
  pharmacyId: string,
  write: TaxSettingsWrite
): Promise<TaxSettingsRow> {
  const result = await query(
    `update pharmacies
        set tax_inclusive_pricing = $2,
            vat_rate = $3::numeric,
            nhil_rate = $4::numeric,
            getfund_rate = $5::numeric
      where id = $1
      returning ${TAX_COLUMNS}`,
    [
      pharmacyId,
      write.taxInclusivePricing,
      write.vatRate,
      write.nhilRate,
      write.getfundRate,
    ]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new HttpError(404, 'No pharmacy matches that id', { code: 'not_found' });
  }
  return mapRow(row);
}
