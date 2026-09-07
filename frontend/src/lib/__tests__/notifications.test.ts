import type { NotificationRow, RefreshSummary, ReminderRow } from '../api-types';
import {
  bellFiltersActive,
  bellQueryFrom,
  deliveryStateOf,
  EMPTY_BELL_FILTERS,
  EMPTY_REMINDER_FILTERS,
  notificationStateOf,
  refreshDeliveredAny,
  refreshUndelivered,
  reminderFiltersActive,
  reminderQueryFrom,
  reminderStateOf,
  UNEXPLAINED_UNSENT,
} from '../notifications';

const PATIENT = '6f1e0b6a-0000-4000-8000-000000000001';
/** The reason the backend stores while no SMS provider is configured. */
const NO_PROVIDER = 'No SMS provider is configured, so nothing was sent.';

function reminder(overrides: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: '6f1e0b6a-0000-4000-8000-000000000011',
    pharmacyId: '6f1e0b6a-0000-4000-8000-0000000000ff',
    patientId: PATIENT,
    kind: 'refill',
    dueAt: '2026-09-08T09:00:00.000Z',
    message: 'Your refill is ready to collect.',
    status: 'not_sent',
    notSentReason: NO_PROVIDER,
    notificationId: null,
    dedupeKey: 'refill:6f1e0b6a',
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

function bell(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: '6f1e0b6a-0000-4000-8000-000000000022',
    pharmacyId: '6f1e0b6a-0000-4000-8000-0000000000ff',
    userId: null,
    type: 'refill_reminder',
    status: 'not_sent',
    title: 'Refill reminder not sent',
    body: NO_PROVIDER,
    relatedType: 'reminder',
    relatedId: '6f1e0b6a-0000-4000-8000-000000000011',
    dedupeKey: 'refill:6f1e0b6a',
    notSentReason: NO_PROVIDER,
    sentAt: null,
    readAt: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

function summary(overrides: Partial<RefreshSummary> = {}): RefreshSummary {
  return {
    now: '2026-09-08T09:00:00.000Z',
    due: 12,
    sent: 0,
    notSent: 12,
    failed: 0,
    alreadyDealt: 0,
    ...overrides,
  };
}

describe('bellQueryFrom', () => {
  it('sends only limit and offset for an unfiltered bell', () => {
    expect(bellQueryFrom({ ...EMPTY_BELL_FILTERS }, 20, 0)).toEqual({ limit: 20, offset: 0 });
  });

  it('omits unreadOnly when off rather than sending false', () => {
    // An absent key means "nobody asked about the read ones"; a present false is a
    // positive request for them. The bell keeps the two apart by sending only on.
    expect(bellQueryFrom({ ...EMPTY_BELL_FILTERS, unreadOnly: false }, 20, 0)).not.toHaveProperty(
      'unreadOnly'
    );
  });

  it('sends the type trimmed and unreadOnly as true when on', () => {
    expect(
      bellQueryFrom({ type: ' stock_expiry ', unreadOnly: true }, 20, 40)
    ).toEqual({ limit: 20, offset: 40, type: 'stock_expiry', unreadOnly: 'true' });
  });

  it('reports an unread-only bell as filtered', () => {
    expect(bellFiltersActive({ ...EMPTY_BELL_FILTERS })).toBe(false);
    expect(bellFiltersActive({ ...EMPTY_BELL_FILTERS, unreadOnly: true })).toBe(true);
    expect(bellFiltersActive({ ...EMPTY_BELL_FILTERS, type: 'product_recall' })).toBe(true);
  });
});

describe('reminderQueryFrom', () => {
  it('sends only limit and offset when no filter is set', () => {
    expect(reminderQueryFrom({ ...EMPTY_REMINDER_FILTERS }, 50, 0)).toEqual({ limit: 50, offset: 0 });
    expect(reminderFiltersActive({ ...EMPTY_REMINDER_FILTERS })).toBe(false);
  });

  it('sends each filter that is set, trimmed, including the order toggle', () => {
    expect(
      reminderQueryFrom(
        {
          patientId: ` ${PATIENT} `,
          kind: 'appointment',
          status: '',
          from: '2026-09-01',
          to: '',
          order: 'upcoming',
        },
        50,
        0
      )
    ).toEqual({
      limit: 50,
      offset: 0,
      patientId: PATIENT,
      kind: 'appointment',
      from: '2026-09-01',
      order: 'upcoming',
    });
  });

  it('treats the order toggle alone as no filter', () => {
    expect(reminderFiltersActive({ ...EMPTY_REMINDER_FILTERS, order: 'recent' })).toBe(false);
    expect(reminderFiltersActive({ ...EMPTY_REMINDER_FILTERS, status: 'not_sent' })).toBe(true);
  });
});

describe('deliveryStateOf', () => {
  it('counts only a sent row as delivered', () => {
    expect(deliveryStateOf('sent', null)).toEqual({
      delivered: true,
      owesReason: false,
      reason: null,
    });
  });

  it('does not dress a pending row up as delivered', () => {
    // "Pending" is nothing attempted yet, not a message on its way.
    expect(deliveryStateOf('pending', null)).toEqual({
      delivered: false,
      owesReason: false,
      reason: null,
    });
  });

  it('surfaces a not_sent reason verbatim', () => {
    expect(deliveryStateOf('not_sent', NO_PROVIDER)).toEqual({
      delivered: false,
      owesReason: true,
      reason: NO_PROVIDER,
    });
  });

  it('surfaces a failed reason verbatim too', () => {
    const state = deliveryStateOf('failed', 'The provider rejected the number.');
    expect(state.delivered).toBe(false);
    expect(state.owesReason).toBe(true);
    expect(state.reason).toBe('The provider rejected the number.');
  });

  it('falls back to an honest unknown when a reason is missing, rather than inventing one', () => {
    // The schema guarantees a reason, so this is the unreachable defence — and it
    // says "nothing recorded" instead of guessing a cause.
    expect(deliveryStateOf('not_sent', null).reason).toBe(UNEXPLAINED_UNSENT);
    expect(deliveryStateOf('failed', '   ').reason).toBe(UNEXPLAINED_UNSENT);
  });
});

describe('row adapters', () => {
  it('reads a reminder row', () => {
    expect(reminderStateOf(reminder()).reason).toBe(NO_PROVIDER);
    expect(reminderStateOf(reminder({ status: 'sent', notSentReason: null })).delivered).toBe(true);
  });

  it('reads a bell row', () => {
    expect(notificationStateOf(bell()).owesReason).toBe(true);
    expect(notificationStateOf(bell({ status: 'pending', notSentReason: null })).reason).toBeNull();
  });
});

describe('refresh summary honesty', () => {
  it('reports nothing delivered while no provider is configured', () => {
    expect(refreshDeliveredAny(summary())).toBe(false);
    expect(refreshDeliveredAny(summary({ sent: 3, notSent: 9 }))).toBe(true);
  });

  it('counts the reminders left undelivered, ignoring ones another pass handled', () => {
    expect(refreshUndelivered(summary({ notSent: 12, failed: 0, alreadyDealt: 4 }))).toBe(12);
    expect(refreshUndelivered(summary({ notSent: 5, failed: 2 }))).toBe(7);
  });
});
