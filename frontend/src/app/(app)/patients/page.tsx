'use client';

/**
 * Patients. `/patients`, gated by `patients:read`.
 *
 * The list the care pages work from: every patient record, searchable by name or
 * phone, each row a link to `/patients/[id]` where the record, its readings, its
 * appointments and its reminders live. This page reads and navigates; the one thing
 * it writes is a new record, because "add a patient" belongs where the list is —
 * the same split `/inventory` uses.
 *
 * The fetch is debounced for the reason `/sales` gives: the search box drives the
 * same effect as the page offset, and a request per keystroke would hammer a route
 * that shares its IP rate-limit bucket with the whole pharmacy behind one NAT. An
 * in-flight response is cancelled when the filters move again.
 *
 * ## `total` makes the pagination honest
 *
 * `PatientListResponse` carries a `total`, so the footer says "1–50 of 123" and
 * disables Next on the last page rather than guessing. `/sales` and `/inventory`
 * get no count back and infer "there might be more" from a full page; here the
 * count is returned, so inferring would throw away an answer the server computed.
 *
 * ## The one honesty marker on a row
 *
 * A patient whose `smsNumber` is null cannot be texted, so their reminders will be
 * raised as `not sent`. That is worth saying here rather than only on the record
 * page, because it is the thing a pharmacist would otherwise discover after the
 * patient has gone — but it is a marker, not a warning colour: no number is an
 * ordinary record, not a broken one.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { CreatePatientModal } from '@/components/patients/patient-modals';
import { GENDER_UNASKED, GENDER_WORD } from '@/components/patients/patients-words';
import { Button } from '@/components/ui/button';
import {
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Spinner,
  StatusNotice,
} from '@/components/ui/display';
import { Field, Input } from '@/components/ui/field';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api-error-message';
import type {
  CreatePatientBody,
  PatientCreatedResponse,
  PatientListResponse,
  PatientView,
} from '@/lib/api-types';
import { formatDate } from '@/lib/format';
import {
  EMPTY_PATIENT_FILTERS,
  patientFiltersActive,
  patientQueryFrom,
  type PatientFilters,
} from '@/lib/patients';

/** The backend's own `DEFAULT_LIST_LIMIT`, so a page is one server page. */
const PAGE_SIZE = 50;

/** The line under a name: how to reach them, and the two facts a record leads with. */
function patientSummary(patient: PatientView): string {
  const parts: string[] = [patient.phone === null ? 'No phone on record' : patient.phone];
  if (patient.dateOfBirth !== null) parts.push(`Born ${formatDate(patient.dateOfBirth)}`);
  // A gender nobody asked is kept apart from one the patient declined, which is
  // what `GENDER_UNASKED` and `'undisclosed'` are: the first is a gap to fill at
  // the next visit, the second is an answer to respect.
  parts.push(patient.gender === null ? GENDER_UNASKED : GENDER_WORD[patient.gender]);
  return parts.join(' · ');
}

export default function PatientsPage() {
  const { api, can } = useAuth();
  const canWrite = can('patients:write');

  const [filters, setFilters] = useState<PatientFilters>(EMPTY_PATIENT_FILTERS);
  const [offset, setOffset] = useState(0);
  const [patients, setPatients] = useState<PatientView[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  const filtersActive = patientFiltersActive(filters);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      void (async () => {
        setLoading(true);
        setLoadError(null);
        try {
          const result = await api.get<PatientListResponse>('/patients', {
            query: patientQueryFrom(filters, PAGE_SIZE, offset),
          });
          if (cancelled) return;
          setPatients(result.patients);
          setTotal(result.total);
        } catch (error) {
          if (!cancelled) {
            setLoadError(apiErrorMessage(error, 'Could not load the patient list.'));
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [api, filters, offset, reloadToken]);

  function update(patch: Partial<PatientFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  }

  function clearFilters() {
    setFilters(EMPTY_PATIENT_FILTERS);
    setOffset(0);
  }

  async function onCreate(body: CreatePatientBody) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.post<PatientCreatedResponse>('/patients', body);
      setCreating(false);
      setNotice(`Added ${result.patient.fullName}.`);
      reload();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'Could not add the patient.'));
    } finally {
      setSubmitting(false);
    }
  }

  const hasMore = offset + patients.length < total;

  return (
    <div>
      <PageHeader
        title="Patients"
        subtitle="Every patient record, searchable by name or phone"
        actions={
          canWrite ? (
            <Button
              variant="primary"
              onClick={() => {
                setNotice(null);
                setSubmitError(null);
                setCreating(true);
              }}
            >
              Add patient
            </Button>
          ) : undefined
        }
      />

      <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
        {notice !== null && <StatusNotice>{notice}</StatusNotice>}

        <Card>
          <Field label="Search" htmlFor="patients-search">
            <Input
              id="patients-search"
              placeholder="Name or phone"
              autoComplete="off"
              maxLength={120}
              value={filters.search}
              onChange={(event) => update({ search: event.target.value })}
            />
          </Field>
          {filtersActive && (
            <div className="mt-3">
              <Button variant="ghost" onClick={clearFilters}>
                Clear search
              </Button>
            </div>
          )}
        </Card>

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
            <Spinner label="Loading patients…" />
          </div>
        )}

        {!loading && loadError === null && patients.length === 0 && (
          <Card padded={false}>
            <EmptyState
              title="No patients found"
              message={
                filtersActive ? 'No record matches that search.' : 'Add a patient to start a record.'
              }
              action={
                canWrite && !filtersActive ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    Add patient
                  </Button>
                ) : undefined
              }
            />
          </Card>
        )}

        {!loading && loadError === null && patients.length > 0 && (
          <div className="space-y-3">
            <ul className="space-y-2">
              {patients.map((patient) => (
                <li key={patient.id}>
                  <Link href={`/patients/${patient.id}`} className="block">
                    <Card className="transition hover:bg-surface-50">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-neutral-900">{patient.fullName}</p>
                          <p className="mt-0.5 text-2xs text-neutral-500">
                            {patientSummary(patient)}
                          </p>
                        </div>
                        {patient.smsNumber === null && (
                          <span className="shrink-0 text-2xs text-neutral-400">
                            Reminders cannot be texted
                          </span>
                        )}
                      </div>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="flex items-center justify-between gap-3">
              <Button
                variant="secondary"
                onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                disabled={offset === 0 || loading}
              >
                Previous
              </Button>
              <span className="text-2xs text-neutral-500">
                {offset + 1}–{offset + patients.length} of {total}
              </span>
              <Button
                variant="secondary"
                onClick={() => setOffset((current) => current + PAGE_SIZE)}
                disabled={!hasMore || loading}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>

      {canWrite && (
        <CreatePatientModal
          open={creating}
          submitting={submitting}
          error={submitError}
          onClose={() => setCreating(false)}
          onSubmit={(body) => void onCreate(body)}
        />
      )}
    </div>
  );
}
