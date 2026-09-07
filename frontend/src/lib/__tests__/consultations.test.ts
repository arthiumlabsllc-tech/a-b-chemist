import type { ConsultationView } from '../api-types';
import {
  bookConsultationBody,
  consultationDraftFrom,
  consultationFiltersActive,
  consultationQueryFrom,
  EMPTY_CONSULTATION_DRAFT,
  firstConsultationError,
  rescheduleBody,
  rescheduleUnchanged,
  type ConsultationDraft,
} from '../consultations';

const PATIENT = '6f1e0b6a-0000-4000-8000-000000000001';
const CONDUCTOR = '6f1e0b6a-0000-4000-8000-0000000000aa';
const LINK = 'https://meet.example/abc';

function draft(overrides: Partial<ConsultationDraft> = {}): ConsultationDraft {
  return { ...EMPTY_CONSULTATION_DRAFT, ...overrides };
}

/**
 * A stored video appointment: the only kind that carries a link, so it is the
 * fixture that exercises the reschedule diff's ability to *clear* one.
 */
function stored(overrides: Partial<ConsultationView> = {}): ConsultationView {
  return {
    id: '6f1e0b6a-0000-4000-8000-0000000000cc',
    pharmacyId: '6f1e0b6a-0000-4000-8000-0000000000ff',
    patientId: PATIENT,
    conductedBy: CONDUCTOR,
    type: 'video',
    status: 'scheduled',
    scheduledAt: '2026-09-10T14:30:00.000Z',
    durationMinutes: 20,
    videoUrl: LINK,
    notes: 'Bring the referral letter',
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

describe('consultationDraftFrom', () => {
  it('seeds the time as a datetime-local value, not the stored instant', () => {
    const seeded = consultationDraftFrom(stored());
    expect(seeded.scheduledAt).toBe('2026-09-10T14:30');
    expect(seeded.type).toBe('video');
    expect(seeded.durationMinutes).toBe('20');
    expect(seeded.videoUrl).toBe(LINK);
    expect(seeded.notes).toBe('Bring the referral letter');
  });

  it('seeds a null length, link and note to empty text', () => {
    const seeded = consultationDraftFrom(
      stored({ type: 'in_person', durationMinutes: null, videoUrl: null, notes: null })
    );
    expect(seeded.durationMinutes).toBe('');
    expect(seeded.videoUrl).toBe('');
    expect(seeded.notes).toBe('');
  });
});

describe('bookConsultationBody', () => {
  it('sends only what was given, and omits an unassigned conductor', () => {
    expect(
      bookConsultationBody(
        PATIENT,
        draft({ type: 'in_person', scheduledAt: '2026-09-10T09:00' }),
        null
      )
    ).toEqual({
      patientId: PATIENT,
      type: 'in_person',
      scheduledAt: '2026-09-10T09:00:00.000Z',
    });
  });

  it('assigns the conductor when the page passes one', () => {
    const body = bookConsultationBody(
      PATIENT,
      draft({ type: 'phone', scheduledAt: '2026-09-10T09:00' }),
      CONDUCTOR
    );
    expect(body.conductedBy).toBe(CONDUCTOR);
  });

  it('carries a whole number of minutes when one is typed', () => {
    const body = bookConsultationBody(
      PATIENT,
      draft({ type: 'in_person', scheduledAt: '2026-09-10T09:00', durationMinutes: '45' }),
      null
    );
    expect(body.durationMinutes).toBe(45);
  });

  it('stores a link only for a video consultation, and trims it', () => {
    const video = bookConsultationBody(
      PATIENT,
      draft({ type: 'video', scheduledAt: '2026-09-10T09:00', videoUrl: ` ${LINK} ` }),
      null
    );
    expect(video.videoUrl).toBe(LINK);

    // Text left in the link field by a type switch must not be stored for an
    // in-person visit: there is no meeting to link to.
    const inPerson = bookConsultationBody(
      PATIENT,
      draft({ type: 'in_person', scheduledAt: '2026-09-10T09:00', videoUrl: LINK }),
      null
    );
    expect(inPerson.videoUrl).toBeUndefined();
  });
});

describe('rescheduleBody', () => {
  it('always sends the time and nothing else when the form is untouched', () => {
    // scheduledAt is required on a reschedule even when it has not moved, because
    // a move with no new time is not a move — but the other three fields must be
    // omitted so their stored values survive.
    expect(rescheduleBody(stored(), consultationDraftFrom(stored()))).toEqual({
      scheduledAt: '2026-09-10T14:30:00.000Z',
    });
  });

  it('sends only the field that moved', () => {
    const body = rescheduleBody(
      stored(),
      consultationDraftFrom(stored({ scheduledAt: '2026-09-11T10:00:00.000Z' }))
    );
    expect(body).toEqual({ scheduledAt: '2026-09-11T10:00:00.000Z' });
  });

  it('clears the link by sending null when the type moves off video', () => {
    const body = rescheduleBody(
      stored(),
      consultationDraftFrom(stored({ type: 'in_person' }))
    );
    // The draft still holds the seeded link text, but a non-video appointment
    // folds it to null, and null — not '' — is what clears the stored column.
    expect(body.type).toBe('in_person');
    expect(body.videoUrl).toBeNull();
  });

  it('clears a note by sending null, never an empty string', () => {
    const seeded = consultationDraftFrom(stored());
    const body = rescheduleBody(stored(), { ...seeded, notes: '' });
    expect(body.notes).toBeNull();
  });

  it('sets a length where the stored row had none', () => {
    const seeded = consultationDraftFrom(stored({ durationMinutes: null }));
    const body = rescheduleBody(stored({ durationMinutes: null }), {
      ...seeded,
      durationMinutes: '30',
    });
    expect(body.durationMinutes).toBe(30);
  });
});

describe('rescheduleUnchanged', () => {
  it('is true for a form opened and saved without an edit', () => {
    expect(rescheduleUnchanged(stored(), consultationDraftFrom(stored()))).toBe(true);
  });

  it('is false when the instant moves, even by a minute', () => {
    expect(
      rescheduleUnchanged(stored(), consultationDraftFrom(stored({ scheduledAt: '2026-09-10T14:31:00.000Z' })))
    ).toBe(false);
  });

  it('is false when a note is cleared', () => {
    const seeded = consultationDraftFrom(stored());
    expect(rescheduleUnchanged(stored(), { ...seeded, notes: '' })).toBe(false);
  });
});

describe('consultationQueryFrom', () => {
  it('sends only limit and offset when no filter is set', () => {
    expect(
      consultationQueryFrom(
        { patientId: '', conductedBy: '', status: '', from: '', to: '', order: '' },
        50,
        0
      )
    ).toEqual({ limit: 50, offset: 0 });
    expect(
      consultationFiltersActive({ patientId: '', conductedBy: '', status: '', from: '', to: '', order: '' })
    ).toBe(false);
  });

  it('sends the filters that are set, trimmed, and the order toggle', () => {
    expect(
      consultationQueryFrom(
        {
          patientId: ` ${PATIENT} `,
          conductedBy: '',
          status: 'scheduled',
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
      status: 'scheduled',
      from: '2026-09-01',
      order: 'upcoming',
    });
  });

  it('treats the order toggle alone as no filter, so the page offers no Clear', () => {
    expect(
      consultationFiltersActive({ patientId: '', conductedBy: '', status: '', from: '', to: '', order: 'recent' })
    ).toBe(false);
    expect(
      consultationFiltersActive({ patientId: '', conductedBy: '', status: 'completed', from: '', to: '', order: '' })
    ).toBe(true);
  });
});

describe('firstConsultationError', () => {
  it('is null for an in-person appointment with a time', () => {
    expect(
      firstConsultationError(draft({ type: 'in_person', scheduledAt: '2026-09-10T09:00' }))
    ).toBeNull();
  });

  it('requires a time', () => {
    expect(firstConsultationError(draft({ type: 'in_person' }))).toEqual({
      field: 'scheduledAt',
      message: 'Enter the date and time of the appointment',
    });
    expect(
      firstConsultationError(draft({ type: 'in_person', scheduledAt: 'not-a-time' }))?.field
    ).toBe('scheduledAt');
  });

  it('requires a whole number of minutes', () => {
    expect(
      firstConsultationError(
        draft({ type: 'in_person', scheduledAt: '2026-09-10T09:00', durationMinutes: '20.5' })
      )
    ).toEqual({
      field: 'durationMinutes',
      message: 'Enter the length of the consultation as a whole number of minutes',
    });
  });

  it('allows a blank length, which is not a zero-minute appointment', () => {
    expect(
      firstConsultationError(draft({ type: 'in_person', scheduledAt: '2026-09-10T09:00', durationMinutes: '' }))
    ).toBeNull();
  });

  it('refuses a meeting link that is not https', () => {
    expect(
      firstConsultationError(
        draft({ type: 'video', scheduledAt: '2026-09-10T09:00', videoUrl: 'http://meet.example/abc' })
      )
    ).toEqual({ field: 'videoUrl', message: 'The meeting link must start with https://' });
  });

  it('refuses a meeting link that is not an address at all', () => {
    expect(
      firstConsultationError(
        draft({ type: 'video', scheduledAt: '2026-09-10T09:00', videoUrl: 'meet.example/abc' })
      )
    ).toEqual({ field: 'videoUrl', message: 'That is not a web address' });
  });

  it('accepts an https meeting link for a video consultation', () => {
    expect(
      firstConsultationError(draft({ type: 'video', scheduledAt: '2026-09-10T09:00', videoUrl: LINK }))
    ).toBeNull();
  });

  it('does not police the link field for a consultation that is not a video one', () => {
    // The field is not shown for an in-person visit, so stray text in it is not
    // the pharmacist's error to fix.
    expect(
      firstConsultationError(
        draft({ type: 'in_person', scheduledAt: '2026-09-10T09:00', videoUrl: 'not a url' })
      )
    ).toBeNull();
  });

  it('refuses a note past the cap', () => {
    expect(
      firstConsultationError(
        draft({ type: 'in_person', scheduledAt: '2026-09-10T09:00', notes: 'x'.repeat(501) })
      )
    ).toEqual({ field: 'notes', message: 'Notes must be 500 characters or fewer' });
  });

  it('does not refuse an appointment in the past, because the server does not either', () => {
    expect(
      firstConsultationError(draft({ type: 'in_person', scheduledAt: '2020-01-01T09:00' }))
    ).toBeNull();
  });
});
