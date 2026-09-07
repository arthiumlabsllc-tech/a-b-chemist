jest.mock('../database/pool', () => ({
  query: jest.fn(),
  poolSql: { query: jest.fn() },
  withTransaction: jest.fn(),
  probeDatabase: jest.fn().mockResolvedValue({ ok: false, error: 'unused in this suite' }),
  closePool: jest.fn().mockResolvedValue(undefined),
  getPool: jest.fn(),
}));

import { query } from '../database/pool';
import { listPharmacyIds } from '../repositories/pharmacies.repository';

/**
 * The read the reminder scheduler takes its tenant from.
 *
 * One function and one statement, which is why this suite is short — but it is
 * not a suite about SQL style. `runReminders` has nobody signed in and therefore
 * no token to take a `pharmacy_id` from, so this query is the only thing deciding
 * whose patients get told their script is due. A filter added here, or an `order
 * by` dropped, or a `where` clause someone thought was harmless, changes which
 * pharmacies the scheduler serves and does so without anything else in the system
 * noticing: the run would log a clean summary and exit zero.
 *
 * The statements are pinned here and executed for real by `database/tests/
 * assertions.sql` section 19, which is the half that proves the read finds the
 * seeded pharmacy rather than merely that it parses.
 */

const queryMock = query as jest.Mock;

interface Call {
  text: string;
  params: unknown[];
}

let calls: Call[] = [];

/** Collapses whitespace so a reformat is not a failure but a rewrite is. */
function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

const SEEDED = 'a0000000-0000-4000-8000-000000000001';
const SECOND = 'a0000000-0000-4000-8000-000000000002';

function onlyCall(recorded: Call[]): Call {
  if (recorded.length !== 1) {
    throw new Error(`expected exactly one query, saw ${recorded.length}`);
  }
  const call = recorded[0];
  if (call === undefined) throw new Error('the one call was undefined');
  return call;
}

beforeEach(() => {
  calls = [];
  queryMock.mockReset();
  queryMock.mockImplementation((text: string, params: unknown[]) => {
    calls.push({ text, params });
    return Promise.resolve({ rows: [{ id: SEEDED }], rowCount: 1 });
  });
});

describe('listPharmacyIds', () => {
  it('asks the table, in the statement section 19 of the harness prepares', async () => {
    await listPharmacyIds();

    // Pinned whole rather than in fragments: this is the drift guard against the
    // PREPARE in `database/tests/assertions.sql`, and a fragment match would let
    // the two disagree about the part nobody thought to assert.
    expect(normalise(onlyCall(calls).text)).toBe('select id from pharmacies order by id');
  });

  it('takes no parameters, because which pharmacies exist is not a question the caller gets to narrow', async () => {
    await listPharmacyIds();

    // A parameter here would be a filter, and a filter is how a pharmacy gets
    // quietly left out of the scheduler. The one legitimate narrowing this build
    // could want is per-pharmacy, and there is one pharmacy.
    expect(onlyCall(calls).params).toEqual([]);
  });

  it('has no where clause, so nothing can be excluded without the statement changing shape', async () => {
    await listPharmacyIds();

    const text = normalise(onlyCall(calls).text);
    expect(text).not.toContain('where');
    expect(text).not.toContain('limit');
    expect(text).not.toContain('join');
  });

  it('reads the id and nothing else off a row that also holds the tax rates and the pharmacy contact details', async () => {
    await listPharmacyIds();

    // `select *` would compile and would pass every assertion above except this
    // one. It would also haul VAT, NHIL and GETFund rates plus the pharmacy's
    // phone and email into a cron job that needs an id, which is data in a process
    // whose log is aggregated for no reason at all.
    const text = normalise(onlyCall(calls).text);
    expect(text).toContain('select id from');
    expect(text).not.toContain('*');
    expect(text).not.toContain('vat_rate');
  });

  it('orders, so two runs that did the same work print their lines in the same order', async () => {
    await listPharmacyIds();

    expect(normalise(onlyCall(calls).text)).toContain('order by id');
  });

  it('returns the ids in the order the table gave them', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: SECOND }, { id: SEEDED }], rowCount: 2 });

    await expect(listPharmacyIds()).resolves.toEqual([SECOND, SEEDED]);
  });

  it('returns an empty array for an unseeded database rather than throwing', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(listPharmacyIds()).resolves.toEqual([]);

    // The caller decides what an empty list means, and `runReminders` decides it
    // is an error worth a nonzero exit. Throwing here instead would turn "this
    // database has not been seeded" into a stack trace in a cron log, which reads
    // like a crash and is not one.
  });

  it('hands back strings, since a uuid arrives from pg as text and the scheduler passes it straight on', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: SEEDED }], rowCount: 1 });

    const ids = await listPharmacyIds();

    expect(ids).toHaveLength(1);
    expect(typeof ids[0]).toBe('string');
    expect(ids[0]).toBe(SEEDED);
  });
});

describe('the module surface', () => {
  it('exports one read, so a second tenant question is a decision rather than an addition', async () => {
    const mod = await import('../repositories/pharmacies.repository');

    expect(Object.keys(mod).sort()).toEqual(['listPharmacyIds']);
  });
});
