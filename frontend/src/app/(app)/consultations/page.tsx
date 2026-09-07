'use client';

/**
 * The whole appointment diary. `/consultations`, gated by `patients:read`.
 *
 * Every patient's appointments in one place, upcoming first, filterable by status
 * and by when. There is no type filter because `GET /consultations` takes a status
 * filter and not a type one — the `types` it echoes describes the rows rather than
 * narrowing them, and a dropdown the endpoint ignored would be a control that lies.
 * Read-only for the same reason `/screenings` is: the API's
 * `ConsultationView` carries the `patientId` but not the patient's name, so a row
 * links through to `/patients/[id]` rather than offering to move or end an
 * appointment it cannot name a patient for. Booking, moving and ending all stay on
 * the patient's own page — an appointment is changed by somebody looking at the
 * person it is for, not from a list of anonymous slots.
 *
 * `order` starts at `upcoming`, which is the repository's own default spelled out
 * so the toggle reflects what the list is actually doing. It is a view toggle and
 * not a filter, which is why `consultationFiltersActive` ignores it and why
 * changing it alone does not offer "Clear".
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { ConsultationEntry } from '@/components/consultations/consultation-rows';
import { CONSULTATION_STATUS_WORD } from '@/components/consultations/consultations-words';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/display';
import { Field, Input, Select } from '@/components/ui/field';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api-error-message';
import type {
  ConsultationListResponse,
  ConsultationStatus,
  ConsultationView,
} from '@/lib/api-types';
import { CONSULTATION_STATUSES } from '@/lib/api-types';
import {
  consultationFiltersActive,
  consultationQueryFrom,
  EMPTY_CONSULTATION_FILTERS,
  type ConsultationFilters,
} from '@/lib/consultations';

/** The backend's own `DEFAULT_LIST_LIMIT`, so a page is one server page. */
const PAGE_SIZE = 50;

/** The diary opens upcoming-first, so the toggle says so rather than showing blank. */
const INITIAL_FILTERS: ConsultationFilters = { ...EMPTY_CONSULTATION_FILTERS, order: 'upcoming' };

const ORDER_OPTIONS = [
  { value: 'upcoming', label: 'Upcoming first' },
  { value: 'recent', label: 'Most recent first' },
] as const;

export default function ConsultationsPage() {
  const { api } = useAuth();

  const [filters, setFilters] = useState<ConsultationFilters>(INITIAL_FILTERS);
  const [offset, setOffset] = useState(0);
  const [consultations, setConsultations] = useState<ConsultationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  const filtersActive = consultationFiltersActive(filters);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const result = await api.get<ConsultationListResponse>('/consultations', {
          query: consultationQueryFrom(filters, PAGE_SIZE, offset),
        });
        if (cancelled) return;
        setConsultations(result.consultations);
        setHasMore(result.consultations.length === PAGE_SIZE);
      } catch (error) {
        if (!cancelled) setLoadError(apiErrorMessage(error, 'Could not load the diary.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, filters, offset, reloadToken]);

  function update(patch: Partial<ConsultationFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  }

  function clearFilters() {
    setFilters(INITIAL_FILTERS);
    setOffset(0);
  }

  return (
    <div>
      <PageHeader
        title="Consultations"
        subtitle="The whole diary, upcoming first — open an appointment to see the patient it belongs to"
      />

      <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
        <Card>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Status" htmlFor="consultations-status">
              <Select
                id="consultations-status"
                value={filters.status}
                onChange={(event) => update({ status: event.target.value })}
              >
                <option value="">Any status</option>
                {CONSULTATION_STATUSES.map((value: ConsultationStatus) => (
                  <option key={value} value={value}>
                    {CONSULTATION_STATUS_WORD[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="From" htmlFor="consultations-from">
              <Input
                id="consultations-from"
                type="date"
                value={filters.from}
                onChange={(event) => update({ from: event.target.value })}
              />
            </Field>
            <Field label="To" htmlFor="consultations-to">
              <Input
                id="consultations-to"
                type="date"
                value={filters.to}
                onChange={(event) => update({ to: event.target.value })}
              />
            </Field>
            <Field label="Order" htmlFor="consultations-order">
              <Select
                id="consultations-order"
                value={filters.order}
                onChange={(event) => update({ order: event.target.value })}
              >
                {ORDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {filtersActive && (
            <div className="mt-3 flex justify-end">
              <Button variant="ghost" onClick={clearFilters}>
                Clear filters
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
            <Spinner label="Loading the diary…" />
          </div>
        )}

        {!loading && loadError === null && consultations.length === 0 && (
          <Card padded={false}>
            <EmptyState
              title="No appointments found"
              message={
                filtersActive
                  ? 'No appointment matches these filters.'
                  : 'Appointments appear here once they are booked on a patient.'
              }
            />
          </Card>
        )}

        {!loading && loadError === null && consultations.length > 0 && (
          <div className="space-y-3">
            <Card padded={false}>
              <ul className="divide-y divide-surface-200">
                {consultations.map((consultation) => (
                  <ConsultationEntry
                    key={consultation.id}
                    consultation={consultation}
                    action={
                      <Link
                        href={`/patients/${consultation.patientId}`}
                        className="inline-block text-sm font-medium text-primary-700 hover:text-primary-800 hover:underline"
                      >
                        Open the patient record
                      </Link>
                    }
                  />
                ))}
              </ul>
            </Card>

            <div className="flex items-center justify-between gap-3">
              <Button
                variant="secondary"
                onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                disabled={offset === 0 || loading}
              >
                Previous
              </Button>
              <span className="text-2xs text-neutral-500">
                {offset + 1}–{offset + consultations.length}
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
    </div>
  );
}
