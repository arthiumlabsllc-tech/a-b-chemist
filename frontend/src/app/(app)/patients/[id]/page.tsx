'use client';

/**
 * One patient. `/patients/[id]`, gated by `patients:read`.
 *
 * The whole record on one screen: the demographics and clinical lists, the readings
 * taken, the appointments booked, and the reminders those appointments raised. It is
 * also the one place that writes to any of them — edit the record, take a reading,
 * book an appointment, move one, end one — because each of those belongs where the
 * pharmacist is looking at the person they are for. The dialogs collect and validate
 * a body and hand it up; this page is the only part that talks to the API, so none
 * of them knows the patient id.
 *
 * ## The three reads are one permission, so they load together
 *
 * `GET /patients/:id`, `GET /screenings` and `GET /consultations` are all
 * `patients:read`, so they are fetched in one `Promise.all` rather than in a
 * waterfall, exactly as `/inventory/[id]` loads a product and its ledger. If any one
 * fails the page says it could not load the record, rather than showing a half-page
 * that looks complete and is missing the readings.
 *
 * ## Why an appointment write refreshes the reminders
 *
 * Booking raises an appointment reminder, moving one supersedes the old reminder and
 * raises a new one, and ending one supersedes whatever is still pending — all in
 * `consultations.service.ts`. The `ReminderPanel` fetches for itself, so the page
 * remounts it by bumping its `key` after any of those three writes; without that the
 * panel would keep showing the reminder for a slot that no longer exists. A reading
 * raises nothing, so recording one does not touch the panel.
 *
 * ## The two honesty points on this page
 *
 * A record whose `smsNumber` is null says so plainly, because its reminders will be
 * raised as `not sent` and the pharmacist should hear that while the patient is
 * still at the counter, not read it back in the bell afterwards. And an appointment
 * that has already ended is not offered a Reschedule or End button: the backend would
 * refuse it, but a button that always fails teaches the operator to distrust every
 * button.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';

import {
  BookConsultationModal,
  EndConsultationModal,
  RescheduleConsultationModal,
} from '@/components/consultations/consultation-modals';
import { ConsultationEntry } from '@/components/consultations/consultation-rows';
import { ReminderPanel } from '@/components/notifications/reminder-panel';
import { EditPatientModal } from '@/components/patients/patient-modals';
import { GENDER_UNASKED, GENDER_WORD } from '@/components/patients/patients-words';
import { RecordScreeningModal } from '@/components/screenings/screening-modal';
import { ScreeningEntry } from '@/components/screenings/screening-rows';
import { RISK_LEVEL_WORD } from '@/components/screenings/screenings-words';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Spinner,
  StatusNotice,
} from '@/components/ui/display';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api-error-message';
import type {
  BookConsultationBody,
  ConsultationCreatedResponse,
  ConsultationListResponse,
  ConsultationResponse,
  ConsultationView,
  EndConsultationBody,
  PatientResponse,
  PatientView,
  RecordScreeningBody,
  RescheduleBody,
  ScreeningCreatedResponse,
  ScreeningListResponse,
  ScreeningView,
  UpdatePatientBody,
} from '@/lib/api-types';
import {
  consultationQueryFrom,
  EMPTY_CONSULTATION_FILTERS,
} from '@/lib/consultations';
import { formatDate, formatDateTime } from '@/lib/format';
import { EMPTY_SCREENING_FILTERS, screeningQueryFrom } from '@/lib/screenings';

type OpenModal = 'edit' | 'record' | 'book' | 'reschedule' | 'end' | null;

/** How many readings and appointments to show. Both routes cap at their own limit. */
const PAGE_SIZE = 50;

/** A clinical list as one line, or the words for an empty one. */
function clinicalList(entries: readonly string[]): string {
  return entries.length === 0 ? 'None recorded' : entries.join(', ');
}

export default function PatientPage() {
  const { api, can, user } = useAuth();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const [patient, setPatient] = useState<PatientView | null>(null);
  const [screenings, setScreenings] = useState<ScreeningView[]>([]);
  const [consultations, setConsultations] = useState<ConsultationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // Bumped after an appointment write to remount the self-fetching reminder panel.
  const [reminderKey, setReminderKey] = useState(0);

  const [modal, setModal] = useState<OpenModal>(null);
  const [activeConsultation, setActiveConsultation] = useState<ConsultationView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const canEdit = can('patients:write');
  const canRecord = can('screenings:write');
  const canConsult = can('consultations:write');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [record, screeningPage, consultationPage] = await Promise.all([
          api.get<PatientResponse>(`/patients/${id}`),
          api.get<ScreeningListResponse>('/screenings', {
            query: screeningQueryFrom({ ...EMPTY_SCREENING_FILTERS, patientId: id }, PAGE_SIZE, 0),
          }),
          api.get<ConsultationListResponse>('/consultations', {
            // 'recent' is latest scheduled first, so the next appointment and the
            // history since the last one read down the page in the order a record is
            // read in.
            query: consultationQueryFrom(
              { ...EMPTY_CONSULTATION_FILTERS, patientId: id, order: 'recent' },
              PAGE_SIZE,
              0
            ),
          }),
        ]);
        if (cancelled) return;
        setPatient(record.patient);
        setScreenings(screeningPage.screenings);
        setConsultations(consultationPage.consultations);
      } catch (error) {
        if (!cancelled) setLoadError(apiErrorMessage(error, 'Could not load this record.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, id, reloadToken]);

  function openSimple(next: OpenModal) {
    setSubmitError(null);
    setNotice(null);
    setModal(next);
  }

  function openConsultation(next: 'reschedule' | 'end', consultation: ConsultationView) {
    setSubmitError(null);
    setNotice(null);
    setActiveConsultation(consultation);
    setModal(next);
  }

  function closeModal() {
    setModal(null);
    setActiveConsultation(null);
    setSubmitError(null);
  }

  async function onEdit(body: UpdatePatientBody) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.patch<PatientResponse>(`/patients/${id}`, body);
      setPatient(result.patient);
      setNotice('Record saved.');
      closeModal();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'Could not save the record.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function onRecord(body: RecordScreeningBody) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.post<ScreeningCreatedResponse>('/screenings', body);
      setNotice(`Reading recorded — ${RISK_LEVEL_WORD[result.screening.riskLevel]}.`);
      closeModal();
      reload();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'Could not record the reading.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function onBook(body: BookConsultationBody) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.post<ConsultationCreatedResponse>('/consultations', body);
      setNotice('Appointment booked. Its reminder is in the list below.');
      closeModal();
      setReminderKey((key) => key + 1);
      reload();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'Could not book the appointment.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function onReschedule(body: RescheduleBody) {
    if (activeConsultation === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.patch<ConsultationResponse>(`/consultations/${activeConsultation.id}`, body);
      setNotice('Appointment moved. Its reminder moved with it.');
      closeModal();
      setReminderKey((key) => key + 1);
      reload();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'Could not move the appointment.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function onEnd(body: EndConsultationBody) {
    if (activeConsultation === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.post<ConsultationResponse>(`/consultations/${activeConsultation.id}/end`, body);
      setNotice('Appointment ended. Any reminder still pending for it was stopped.');
      closeModal();
      setReminderKey((key) => key + 1);
      reload();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'Could not end the appointment.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={patient === null ? 'Patient' : patient.fullName}
        subtitle={patient === null ? undefined : `Added ${formatDate(patient.createdAt)}`}
        actions={
          <Button variant="secondary" onClick={() => router.push('/patients')}>
            Back to patients
          </Button>
        }
      />

      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
        {notice !== null && <StatusNotice>{notice}</StatusNotice>}
        {modal === null && submitError !== null && <ErrorNotice>{submitError}</ErrorNotice>}

        {loadError !== null && (
          <div className="space-y-3">
            <ErrorNotice>{loadError}</ErrorNotice>
            <Button variant="secondary" onClick={reload}>
              Try again
            </Button>
          </div>
        )}

        {loading && loadError === null && (
          <div className="flex justify-center p-12">
            <Spinner label="Loading record…" />
          </div>
        )}

        {!loading && loadError === null && patient !== null && (
          <div className="space-y-4">
            <Card className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">
                  {patient.gender === null ? GENDER_UNASKED : GENDER_WORD[patient.gender]}
                </Badge>
                {patient.smsNumber === null && (
                  <Badge tone="warning">Reminders cannot be texted</Badge>
                )}
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                <Fact label="Phone">{patient.phone ?? '—'}</Fact>
                <Fact label="Date of birth">
                  {patient.dateOfBirth === null ? '—' : formatDate(patient.dateOfBirth)}
                </Fact>
                <Fact label="Reminders text to">{patient.smsNumber ?? '—'}</Fact>
                <Fact label="Added">{formatDateTime(patient.createdAt)}</Fact>
                <Fact label="Last updated">{formatDateTime(patient.updatedAt)}</Fact>
              </dl>

              <div className="space-y-2 border-t border-surface-200 pt-3 text-sm">
                <ClinicalLine label="Allergies" text={clinicalList(patient.allergies)} />
                <ClinicalLine label="Conditions" text={clinicalList(patient.conditions)} />
                <ClinicalLine label="Medications" text={clinicalList(patient.medications)} />
                {patient.notes !== null && <ClinicalLine label="Notes" text={patient.notes} />}
              </div>

              {patient.smsNumber === null && (
                <StatusNotice>
                  No number on this record can be texted, so its reminders are raised as{' '}
                  <span className="font-semibold">not sent</span> with the reason beside them.
                  Nothing is lost — the reading and the appointment are still recorded — but no
                  message goes out until a number is added and an SMS provider is configured.
                </StatusNotice>
              )}

              {canEdit && (
                <div className="border-t border-surface-200 pt-3">
                  <Button
                    variant="secondary"
                    onClick={() => openSimple('edit')}
                    disabled={submitting}
                  >
                    Edit record
                  </Button>
                </div>
              )}
            </Card>

            <Card padded={false}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-200 px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold text-neutral-900">
                    Readings ({screenings.length})
                  </h2>
                  <p className="mt-0.5 text-2xs text-neutral-500">Newest first.</p>
                </div>
                {canRecord && (
                  <Button
                    variant="primary"
                    onClick={() => openSimple('record')}
                    disabled={submitting}
                  >
                    Record a reading
                  </Button>
                )}
              </div>
              {screenings.length === 0 ? (
                <EmptyState
                  title="No readings yet"
                  message={canRecord ? 'Record a blood pressure, glucose or weight.' : undefined}
                />
              ) : (
                <ul className="divide-y divide-surface-200">
                  {screenings.map((reading) => (
                    <ScreeningEntry key={reading.id} screening={reading} />
                  ))}
                </ul>
              )}
            </Card>

            <Card padded={false}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-200 px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold text-neutral-900">
                    Appointments ({consultations.length})
                  </h2>
                  <p className="mt-0.5 text-2xs text-neutral-500">Latest first.</p>
                </div>
                {canConsult && (
                  <Button variant="primary" onClick={() => openSimple('book')} disabled={submitting}>
                    Book an appointment
                  </Button>
                )}
              </div>
              {consultations.length === 0 ? (
                <EmptyState
                  title="No appointments yet"
                  message={canConsult ? 'Book a consultation for this patient.' : undefined}
                />
              ) : (
                <ul className="divide-y divide-surface-200">
                  {consultations.map((consultation) => (
                    <ConsultationEntry
                      key={consultation.id}
                      consultation={consultation}
                      action={
                        canConsult && consultation.status === 'scheduled' ? (
                          <>
                            <Button
                              variant="secondary"
                              onClick={() => openConsultation('reschedule', consultation)}
                              disabled={submitting}
                            >
                              Move
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => openConsultation('end', consultation)}
                              disabled={submitting}
                            >
                              End
                            </Button>
                          </>
                        ) : undefined
                      }
                    />
                  ))}
                </ul>
              )}
            </Card>

            <div className="space-y-2">
              <div>
                <h2 className="text-sm font-semibold text-neutral-900">Reminders</h2>
                <p className="mt-0.5 text-2xs text-neutral-500">
                  What is scheduled to go out for this patient, and whether it went.
                </p>
              </div>
              <ReminderPanel key={reminderKey} patientId={id} />
            </div>
          </div>
        )}
      </div>

      {canEdit && (
        <EditPatientModal
          open={modal === 'edit'}
          patient={patient}
          submitting={submitting}
          error={submitError}
          onClose={closeModal}
          onSubmit={(body) => void onEdit(body)}
        />
      )}
      {canRecord && (
        <RecordScreeningModal
          open={modal === 'record'}
          patientId={id}
          patientName={patient?.fullName}
          submitting={submitting}
          error={submitError}
          onClose={closeModal}
          onSubmit={(body) => void onRecord(body)}
        />
      )}
      {canConsult && (
        <>
          <BookConsultationModal
            open={modal === 'book'}
            patientId={id}
            patientName={patient?.fullName}
            conductedBy={user?.id ?? null}
            submitting={submitting}
            error={submitError}
            onClose={closeModal}
            onSubmit={(body) => void onBook(body)}
          />
          <RescheduleConsultationModal
            open={modal === 'reschedule'}
            consultation={activeConsultation}
            submitting={submitting}
            error={submitError}
            onClose={closeModal}
            onSubmit={(body) => void onReschedule(body)}
          />
          <EndConsultationModal
            open={modal === 'end'}
            consultation={activeConsultation}
            submitting={submitting}
            error={submitError}
            onClose={closeModal}
            onSubmit={(body) => void onEnd(body)}
          />
        </>
      )}
    </div>
  );
}

/** One labelled fact in the record card's grid. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-2xs text-neutral-500">{label}</dt>
      <dd className="text-neutral-900">{children}</dd>
    </div>
  );
}

/** One clinical list on the record: allergies, conditions, medications or notes. */
function ClinicalLine({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <span className="text-2xs text-neutral-500">{label}: </span>
      <span className="text-neutral-800">{text}</span>
    </div>
  );
}
