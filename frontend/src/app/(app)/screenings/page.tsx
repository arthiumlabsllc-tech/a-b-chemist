'use client';

/**
 * Every reading, across every patient. `/screenings`, gated by `patients:read`.
 *
 * A pharmacy-wide view of the readings that have been taken, newest first,
 * filterable by what was measured and by when. It is read-only on purpose, and
 * the reason is a fact about the API rather than a preference: `ScreeningView`
 * carries the `patientId` but not the patient's name, because a reading belongs to
 * a record and the name lives on that record. So a row here links through to
 * `/patients/[id]` instead of offering to act on a reading whose patient it cannot
 * name, and recording a reading stays on the patient's own page, where the
 * pharmacist is looking at the person it is for.
 *
 * The fetch is not debounced, following `reminder-panel.tsx` rather than
 * `/inventory`: there is no free-text box here, only a type and two dates, so each
 * change is one event and a 250ms wait would make the dropdown feel laggy rather
 * than save a request. An in-flight response is still cancelled when the filters
 * move, so a slow answer cannot land on top of a newer one.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { ScreeningEntry } from '@/components/screenings/screening-rows';
import { SCREENING_TYPE_WORD } from '@/components/screenings/screenings-words';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/display';
import { Field, Input, Select } from '@/components/ui/field';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api-error-message';
import type { ScreeningListResponse, ScreeningType, ScreeningView } from '@/lib/api-types';
import { SCREENING_TYPES } from '@/lib/api-types';
import {
  EMPTY_SCREENING_FILTERS,
  screeningFiltersActive,
  screeningQueryFrom,
  type ScreeningFilters,
} from '@/lib/screenings';

/** The backend's own `DEFAULT_LIST_LIMIT`, so a page is one server page. */
const PAGE_SIZE = 50;

export default function ScreeningsPage() {
  const { api } = useAuth();

  const [filters, setFilters] = useState<ScreeningFilters>(EMPTY_SCREENING_FILTERS);
  const [offset, setOffset] = useState(0);
  const [screenings, setScreenings] = useState<ScreeningView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  const filtersActive = screeningFiltersActive(filters);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const result = await api.get<ScreeningListResponse>('/screenings', {
          query: screeningQueryFrom(filters, PAGE_SIZE, offset),
        });
        if (cancelled) return;
        setScreenings(result.screenings);
        setHasMore(result.screenings.length === PAGE_SIZE);
      } catch (error) {
        if (!cancelled) setLoadError(apiErrorMessage(error, 'Could not load the readings.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, filters, offset, reloadToken]);

  function update(patch: Partial<ScreeningFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  }

  function clearFilters() {
    setFilters(EMPTY_SCREENING_FILTERS);
    setOffset(0);
  }

  return (
    <div>
      <PageHeader
        title="Screenings"
        subtitle="Every reading, newest first — open one to see the patient it belongs to"
      />

      <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
        <Card>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="What was measured" htmlFor="screenings-type">
              <Select
                id="screenings-type"
                value={filters.type}
                onChange={(event) => update({ type: event.target.value })}
              >
                <option value="">All types</option>
                {SCREENING_TYPES.map((value: ScreeningType) => (
                  <option key={value} value={value}>
                    {SCREENING_TYPE_WORD[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="From" htmlFor="screenings-from">
              <Input
                id="screenings-from"
                type="date"
                value={filters.from}
                onChange={(event) => update({ from: event.target.value })}
              />
            </Field>
            <Field label="To" htmlFor="screenings-to">
              <Input
                id="screenings-to"
                type="date"
                value={filters.to}
                onChange={(event) => update({ to: event.target.value })}
              />
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
            <Spinner label="Loading readings…" />
          </div>
        )}

        {!loading && loadError === null && screenings.length === 0 && (
          <Card padded={false}>
            <EmptyState
              title="No readings found"
              message={
                filtersActive
                  ? 'No reading matches these filters.'
                  : 'Readings appear here once they are recorded on a patient.'
              }
            />
          </Card>
        )}

        {!loading && loadError === null && screenings.length > 0 && (
          <div className="space-y-3">
            <Card padded={false}>
              <ul className="divide-y divide-surface-200">
                {screenings.map((reading) => (
                  <ScreeningEntry
                    key={reading.id}
                    screening={reading}
                    action={
                      <Link
                        href={`/patients/${reading.patientId}`}
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
                {offset + 1}–{offset + screenings.length}
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
