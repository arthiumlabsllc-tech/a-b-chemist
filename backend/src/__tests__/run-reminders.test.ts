import type { RefreshSummary } from '../services/reminders.service';

/**
 * The reminder scheduler's own logic: how many passes it takes, when it stops,
 * and what it says when it stops.
 *
 * `services/reminders.service.ts` is mocked here and deliberately so. That
 * service's batch — the dedupe, the guarded outcome, the six dispositions — is
 * proven by `reminders.service.test.ts` against the real thing. What is left, and
 * what only this file can reach, is the loop around it: a cron job that runs
 * forever, or that reports twelve reminders handled when twelve reminders were
 * merely looked at, is a defect in *this* module and no amount of service testing
 * would show it.
 *
 * ## The honesty test is the one that matters
 *
 * No SMS provider is configured in this environment, so in production today every
 * reminder the batch deals with is dealt with as `not sent`. A summary line
 * reading "processed 12 reminders" would be a lie an operator would believe. So
 * `summarise` is asserted to carry `0 sent` as a visible, separate count — the
 * first test below, and the reason this suite exists.
 */

// The logger is captured rather than silenced, because what the script *says* is
// part of what it does: it is the only output a cron job has.
jest.mock('../utils/logger', () => {
  const sinks = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { scoped: () => sinks, sinks };
});

// The batch itself is replaced, but the real batch limit is kept. Expressing "a
// full batch" as `DEFAULT_REMINDER_BATCH_LIMIT` rather than as the literal 50 is
// what makes `stops at a short batch` a test about the limit rather than about a
// number that happens to equal it today.
jest.mock('../services/reminders.service', () => {
  const actual = jest.requireActual<typeof import('../services/reminders.service')>(
    '../services/reminders.service'
  );
  return {
    DEFAULT_REMINDER_BATCH_LIMIT: actual.DEFAULT_REMINDER_BATCH_LIMIT,
    refreshReminders: jest.fn(),
  };
});

jest.mock('../repositories/pharmacies.repository', () => ({
  listPharmacyIds: jest.fn(),
}));

jest.mock('../utils/clock', () => ({ nowIso: jest.fn() }));

// Imported so that loading the script under test does not construct a pool. The
// `require.main` guard means `closePool` is never actually called in a suite,
// which is itself asserted at the bottom.
jest.mock('../database/pool', () => ({ closePool: jest.fn() }));

import { closePool } from '../database/pool';
import { listPharmacyIds } from '../repositories/pharmacies.repository';
import {
  DEFAULT_REMINDER_BATCH_LIMIT,
  refreshReminders,
} from '../services/reminders.service';
import { nowIso } from '../utils/clock';
import { drain, MAX_PASSES, runReminders, summarise } from '../scripts/run-reminders';

interface LogSinks {
  info: jest.Mock<void, [string, unknown?]>;
  warn: jest.Mock<void, [string, unknown?]>;
  error: jest.Mock<void, [string, unknown?]>;
  debug: jest.Mock<void, [string, unknown?]>;
}

const sinks = (jest.requireMock('../utils/logger') as { sinks: LogSinks }).sinks;

const mockRefresh = refreshReminders as jest.MockedFunction<typeof refreshReminders>;
const mockPharmacies = listPharmacyIds as jest.MockedFunction<typeof listPharmacyIds>;
const mockNow = nowIso as jest.MockedFunction<typeof nowIso>;
const mockClosePool = closePool as jest.MockedFunction<typeof closePool>;

const PHARMACY = 'a0000000-0000-4000-8000-000000000001';
const SECOND = 'a0000000-0000-4000-8000-000000000002';
const INSTANT = '2026-04-20T09:00:00.000Z';

/** A complete summary, so a test says which field it is varying. */
function summary(overrides: Partial<RefreshSummary> = {}): RefreshSummary {
  return {
    now: INSTANT,
    due: 0,
    sent: 0,
    notSent: 0,
    failed: 0,
    alreadyDealt: 0,
    ...overrides,
  };
}

/** A batch as full as the service will hand back, which is what asks for another pass. */
function fullBatch(overrides: Partial<RefreshSummary> = {}): RefreshSummary {
  return summary({ due: DEFAULT_REMINDER_BATCH_LIMIT, ...overrides });
}

/** Every message logged at one level, in order. */
function logged(level: keyof LogSinks): string[] {
  return sinks[level].mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNow.mockReturnValue(INSTANT);
  mockPharmacies.mockResolvedValue([PHARMACY]);
  mockRefresh.mockResolvedValue(summary());
});

describe('summarise', () => {
  it('carries a zero sent count as a count, so a run that texted nobody cannot read as a run that texted everybody', () => {
    const line = summarise(PHARMACY, summary({ due: 12, notSent: 12 }));

    // The load-bearing assertion of this file. In this environment no provider is
    // configured, so `sent: 0` is the normal outcome and not an edge case, and a
    // summary that omitted a zero would let an operator read "12 due, 12 handled"
    // as twelve patients texted.
    expect(line).toContain('0 sent');
    expect(line).toContain('12 not sent');
    expect(line).toContain('12 due');
    expect(line).toContain('0 failed');
  });

  it('keeps a delivery failure separate from a reminder nothing was attempted for', () => {
    const line = summarise(PHARMACY, summary({ due: 5, sent: 1, notSent: 2, failed: 2 }));

    // `failed` means a provider was reached and did not complete; `not sent` means
    // nothing was attempted. Folding them would hide the difference between "no
    // provider configured" and "the provider is down", which is the difference
    // between nothing to do and something to phone about.
    expect(line).toContain('1 sent');
    expect(line).toContain('2 not sent');
    expect(line).toContain('2 failed');
  });

  it('says when another run got there first, and says nothing about it when none did', () => {
    expect(summarise(PHARMACY, summary({ due: 3, notSent: 3 }))).not.toContain('already dealt');
    expect(summarise(PHARMACY, summary({ due: 3, notSent: 1, alreadyDealt: 2 }))).toContain(
      '2 already dealt with'
    );
  });

  it('names the pharmacy the line is about, so a two-pharmacy log can be read', () => {
    expect(summarise(PHARMACY, summary())).toBe(`${PHARMACY}: 0 due, 0 sent, 0 not sent, 0 failed`);
  });
});

describe('drain', () => {
  it('takes one pass and stays quiet when nothing is due', async () => {
    await drain(PHARMACY, INSTANT);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    // An empty run is the common case for a quarter-hourly cron job, and logging
    // it at info would bury the run that actually did something under ninety-five
    // lines a day saying nothing happened.
    expect(logged('debug')).toHaveLength(1);
    expect(logged('info')).toHaveLength(0);
    expect(logged('warn')).toHaveLength(0);
  });

  it('stops at a short batch instead of asking for one more pass it already knows is empty', async () => {
    mockRefresh.mockResolvedValue(fullBatch({ due: DEFAULT_REMINDER_BATCH_LIMIT - 1 }));

    await drain(PHARMACY, INSTANT);

    // A batch shorter than the limit means the queue was drained: `listDueReminders`
    // asked for the limit and the database had fewer. Taking another pass would be
    // one more transaction per run to confirm what the short batch already said.
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(logged('warn')).toHaveLength(0);
  });

  it('takes a second pass when the first came back full', async () => {
    mockRefresh
      .mockResolvedValueOnce(fullBatch({ notSent: DEFAULT_REMINDER_BATCH_LIMIT }))
      .mockResolvedValueOnce(summary());

    await drain(PHARMACY, INSTANT);

    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(logged('info').join('\n')).toContain('drained in 1 pass');
  });

  it('judges every pass against the one instant the run was given', async () => {
    mockRefresh
      .mockResolvedValueOnce(fullBatch())
      .mockResolvedValueOnce(fullBatch())
      .mockResolvedValueOnce(summary());

    await drain(PHARMACY, INSTANT);

    // `now` is a parameter rather than a call to the clock inside the loop. Asking
    // per pass would let a reminder fall due mid-run and be picked up by a later
    // pass, which makes "what did the 09:00 run see" unanswerable afterwards.
    expect(mockRefresh.mock.calls).toEqual([
      [PHARMACY, INSTANT],
      [PHARMACY, INSTANT],
      [PHARMACY, INSTANT],
    ]);
    expect(mockNow).not.toHaveBeenCalled();
  });

  it('stops at the cap, and says it stopped rather than leaving it to be inferred', async () => {
    // A batch that is always full: the shape a bug would produce if a reminder ever
    // came back still pending, and the shape a genuine 1000-deep backlog produces.
    mockRefresh.mockResolvedValue(fullBatch());

    await drain(PHARMACY, INSTANT);

    expect(mockRefresh).toHaveBeenCalledTimes(MAX_PASSES);
    const warnings = logged('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('may remain');
    expect(warnings[0]).toContain('The next run picks them up');
  });

  it('does not warn about the cap when the drain finished inside it', async () => {
    mockRefresh
      .mockResolvedValueOnce(fullBatch())
      .mockResolvedValueOnce(fullBatch())
      .mockResolvedValueOnce(summary());

    await drain(PHARMACY, INSTANT);

    expect(logged('warn')).toHaveLength(0);
  });

  it('pluralises the pass count honestly rather than printing "1 passes"', async () => {
    mockRefresh
      .mockResolvedValueOnce(fullBatch())
      .mockResolvedValueOnce(fullBatch())
      .mockResolvedValueOnce(summary());

    await drain(PHARMACY, INSTANT);

    expect(logged('info').join('\n')).toContain('drained in 2 passes');
  });
});

describe('runReminders', () => {
  it('refuses to report success against a database with no pharmacy in it', async () => {
    mockPharmacies.mockResolvedValue([]);

    await expect(runReminders()).rejects.toThrow('the database has no pharmacy in it');

    // Not "nothing to do, exit zero". The scheduler was asked to serve a pharmacy
    // and found none, which means `db:apply` never ran against this connection
    // string — and a cron job that exits zero would keep reporting health while
    // pointed at the wrong database for as long as nobody looked.
    expect(mockRefresh).not.toHaveBeenCalled();
    await expect(runReminders()).rejects.toThrow('npm run db:apply');
  });

  it('drains every pharmacy, all against the one instant', async () => {
    mockPharmacies.mockResolvedValue([PHARMACY, SECOND]);
    mockRefresh.mockResolvedValue(summary());

    await runReminders();

    expect(mockNow).toHaveBeenCalledTimes(1);
    expect(mockRefresh.mock.calls).toEqual([
      [PHARMACY, INSTANT],
      [SECOND, INSTANT],
    ]);
  });

  it('asks the table which pharmacies exist rather than reading one from the environment', async () => {
    await runReminders();

    // There is deliberately no PHARMACY_ID in `config`. A wrong id in a variable
    // fails silently — the run finds no due reminders for a pharmacy that has
    // none, logs a clean summary and exits zero — while the real pharmacy's
    // patients never hear anything. Asking the table cannot be wrong that way.
    expect(mockPharmacies).toHaveBeenCalledTimes(1);
    expect(process.env['PHARMACY_ID']).toBeUndefined();
  });

  it('announces the run with its batch limit and the instant it reasoned about', async () => {
    await runReminders();

    const opening = logged('info')[0] ?? '';
    expect(opening).toContain('1 pharmacy');
    expect(opening).toContain(String(DEFAULT_REMINDER_BATCH_LIMIT));
    expect(opening).toContain(INSTANT);
  });

  it('counts pharmacies rather than pluralising from a hard-coded word', async () => {
    mockPharmacies.mockResolvedValue([PHARMACY, SECOND]);
    await runReminders();
    expect(logged('info')[0]).toContain('2 pharmacies');
  });

  it('does not close the pool itself, because only the entry point owns the connection', async () => {
    await runReminders();

    // `closePool` sits in the `require.main` branch. A caller that imported
    // `runReminders` into a long-lived process would have its pool closed under it
    // if the function did this, so it does not.
    expect(mockClosePool).not.toHaveBeenCalled();
  });
});

describe('the module surface', () => {
  it('exports the entry point, the drain and the summary line, and nothing else', async () => {
    const mod = await import('../scripts/run-reminders');

    // Pinned so that adding an export is a decision that shows up as a failing
    // test rather than as a wider surface nobody asked for.
    expect(Object.keys(mod).sort()).toEqual([
      'MAX_PASSES',
      'drain',
      'runReminders',
      'summarise',
    ]);
  });
});
