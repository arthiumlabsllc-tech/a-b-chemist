'use client';

/**
 * Settings. `/settings`, gated by `tax:read`; changing anything is `tax:change`.
 *
 * ## What is here and why it is mostly read-only
 *
 * Three cards. **Tax** is the one thing on this page that changes what a customer
 * pays, so it is the only writable part and it is writable only by the owner
 * (`tax:change`); everybody else sees the same figures with the controls disabled
 * and a line saying why. **Act 1151** is GRA's published reference beside the
 * stored rates, reported rather than applied — the API says whether they match and
 * leaves the meaning to the owner, because a small community pharmacy sits on
 * either side of the registration threshold and only the owner knows which side
 * A&B is on. **Payments** is the gateway's mode, read-only, so the owner can
 * confirm mobile money is live and not in test before the pharmacy opens.
 *
 * ## The rate field
 *
 * A rate is entered as a decimal — `0.15` for 15% — because that is what the
 * column stores and what the engine parses, and `lib/rates.ts` is the only place
 * the three spellings (decimal, percentage, ten-thousandths) meet. The live
 * `= 15%` hint is there so an owner who types `0.025` can see it read as two and
 * a half percent before saving, and so one who types `15` meaning fifteen percent
 * is told at the field, in words, that it is above one — rather than after a round
 * trip, or worse, silently.
 */

import { useCallback, useEffect, useState } from 'react';

import { METHOD_WORD } from '@/components/pos/sale-words';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  ErrorNotice,
  PageHeader,
  Spinner,
  StatusNotice,
  WarningNotice,
} from '@/components/ui/display';
import { Field, Input } from '@/components/ui/field';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api-error-message';
import type {
  PaymentConfig,
  PaymentConfigResponse,
  TaxSettingsBody,
  TaxSettingsResponse,
  TaxSettingsView,
} from '@/lib/api-types';
import { formatDate } from '@/lib/format';
import { decimalFromRate, labelFromRate, parseRateField } from '@/lib/rates';

export default function SettingsPage() {
  const { api, can } = useAuth();
  const canChange = can('tax:change');
  const canReadSales = can('sales:read');

  const [view, setView] = useState<TaxSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [vatText, setVatText] = useState('');
  const [nhilText, setNhilText] = useState('');
  const [getfundText, setGetfundText] = useState('');
  const [inclusive, setInclusive] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [paymentConfig, setPaymentConfig] = useState<PaymentConfig | null>(null);

  // Setters are stable identities, so this callback is too, and an effect that
  // lists it does not re-run for it. Seeding in one place keeps the load and the
  // post-save refresh putting the same four values into the same four fields.
  const seed = useCallback((next: TaxSettingsView) => {
    setVatText(next.vat.decimal);
    setNhilText(next.nhil.decimal);
    setGetfundText(next.getfund.decimal);
    setInclusive(next.taxInclusivePricing);
    setSaved(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const result = await api.get<TaxSettingsResponse>('/tax/settings');
        if (cancelled) return;
        setView(result.taxSettings);
        seed(result.taxSettings);
      } catch (error) {
        if (!cancelled) setLoadError(apiErrorMessage(error, 'Could not load the tax settings.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, reloadToken, seed]);

  // Only asked for when this person may run a counter, which is the permission the
  // gateway config sits behind. A failure is swallowed: the card simply does not
  // render, and a status the page was only going to display is not worth an alert.
  useEffect(() => {
    if (!canReadSales) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.get<PaymentConfigResponse>('/sales/payment-config');
        if (!cancelled) setPaymentConfig(result.paymentConfig);
      } catch {
        // Deliberately quiet. See the comment above.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, canReadSales]);

  const vatField = parseRateField(vatText, 'VAT');
  const nhilField = parseRateField(nhilText, 'NHIL');
  const getfundField = parseRateField(getfundText, 'GETFund levy');
  const formValid = vatField.ok && nhilField.ok && getfundField.ok;

  const dirty =
    view !== null &&
    (inclusive !== view.taxInclusivePricing ||
      (vatField.ok && vatField.rate !== view.vat.rate) ||
      (nhilField.ok && nhilField.rate !== view.nhil.rate) ||
      (getfundField.ok && getfundField.rate !== view.getfund.rate));

  const canSave = canChange && formValid && dirty && !saving;

  function onFieldChange(set: (value: string) => void) {
    return (value: string) => {
      set(value);
      setSaved(false);
      setSaveError(null);
    };
  }

  async function onSave() {
    if (!canChange || !vatField.ok || !nhilField.ok || !getfundField.ok) return;
    setSaving(true);
    setSaveError(null);
    const body: TaxSettingsBody = {
      taxInclusivePricing: inclusive,
      vatRate: vatField.decimal,
      nhilRate: nhilField.decimal,
      getfundRate: getfundField.decimal,
    };
    try {
      const result = await api.put<TaxSettingsResponse>('/tax/settings', body);
      // The response is the row the database sent back, so the form is reseeded
      // from it rather than from what was asked for: if the column stored
      // something else, the fields show that instead of confirming a save that
      // did not happen.
      setView(result.taxSettings);
      seed(result.taxSettings);
      setSaved(true);
    } catch (error) {
      setSaveError(apiErrorMessage(error, 'The settings could not be saved.'));
    } finally {
      setSaving(false);
    }
  }

  function onRestoreAct1151() {
    if (view === null) return;
    setVatText(decimalFromRate(view.act1151.vatRate));
    setNhilText(decimalFromRate(view.act1151.nhilRate));
    setGetfundText(decimalFromRate(view.act1151.getfundRate));
    setSaved(false);
    setSaveError(null);
    // Deliberately leaves `inclusive` alone: GRA publishes rates, not a
    // convention for whether shelf prices include them.
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="Settings" subtitle="What this pharmacy charges and how it takes payment" />
        <div className="flex justify-center p-12">
          <Spinner label="Loading settings…" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Settings" subtitle="What this pharmacy charges and how it takes payment" />
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
        {loadError !== null && (
          <div className="space-y-3">
            <ErrorNotice>{loadError}</ErrorNotice>
            <Button variant="secondary" onClick={() => setReloadToken((token) => token + 1)}>
              Try again
            </Button>
          </div>
        )}

        {loadError === null && view !== null && (
          <>
            {!canChange && (
              <StatusNotice>
                You can see these settings but not change them. Only the owner can change what the
                pharmacy charges.
              </StatusNotice>
            )}
            {saveError !== null && <ErrorNotice>{saveError}</ErrorNotice>}
            {saved && (
              <StatusNotice>Saved. The next sale prices with these rates.</StatusNotice>
            )}

            <Card>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-neutral-900">Tax</h2>
                  <p className="mt-0.5 text-sm text-neutral-600">
                    Currently charging {view.combinedLabel ?? 'over 100%'} combined — VAT{' '}
                    {view.vat.label}, NHIL {view.nhil.label}, GETFund {view.getfund.label}.
                  </p>
                </div>
                <Badge tone={view.matchesAct1151 ? 'positive' : 'warning'}>
                  {view.matchesAct1151 ? 'Matches Act 1151' : 'Differs from Act 1151'}
                </Badge>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <Field
                  label="VAT"
                  htmlFor="vat"
                  error={vatField.ok ? undefined : vatField.message}
                  hint={vatField.ok ? `= ${vatField.label}` : undefined}
                >
                  <Input
                    id="vat"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.1500"
                    value={vatText}
                    disabled={!canChange}
                    onChange={(event) => onFieldChange(setVatText)(event.target.value)}
                  />
                </Field>
                <Field
                  label="NHIL"
                  htmlFor="nhil"
                  error={nhilField.ok ? undefined : nhilField.message}
                  hint={nhilField.ok ? `= ${nhilField.label}` : undefined}
                >
                  <Input
                    id="nhil"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.0250"
                    value={nhilText}
                    disabled={!canChange}
                    onChange={(event) => onFieldChange(setNhilText)(event.target.value)}
                  />
                </Field>
                <Field
                  label="GETFund levy"
                  htmlFor="getfund"
                  error={getfundField.ok ? undefined : getfundField.message}
                  hint={getfundField.ok ? `= ${getfundField.label}` : undefined}
                >
                  <Input
                    id="getfund"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.0250"
                    value={getfundText}
                    disabled={!canChange}
                    onChange={(event) => onFieldChange(setGetfundText)(event.target.value)}
                  />
                </Field>
              </div>

              <label
                htmlFor="inclusive"
                className={[
                  'mt-4 flex items-start gap-3 rounded-md border border-surface-200 p-3',
                  canChange ? 'cursor-pointer' : 'opacity-70',
                ].join(' ')}
              >
                <input
                  id="inclusive"
                  type="checkbox"
                  className="mt-0.5 h-5 w-5 accent-primary-500"
                  checked={inclusive}
                  disabled={!canChange}
                  onChange={(event) => {
                    setInclusive(event.target.checked);
                    setSaved(false);
                    setSaveError(null);
                  }}
                />
                <span className="text-sm">
                  <span className="font-medium text-neutral-800">
                    Shelf prices already include tax
                  </span>
                  <span className="mt-0.5 block text-neutral-600">
                    On when the price on the box is the price the customer pays and the tax is
                    inside it. Off when tax is added at the till.
                  </span>
                </span>
              </label>
            </Card>

            <Card>
              <h2 className="text-base font-semibold text-neutral-900">Act 1151 reference</h2>
              <p className="mt-0.5 text-sm text-neutral-600">
                What GRA publishes for {view.act1151.instrument}, in force from{' '}
                {formatDate(view.act1151.inForceFrom)}. Reported so you can see whether your rates
                match — it never changes them for you.
              </p>
              <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
                <div>
                  <dt className="text-neutral-500">VAT</dt>
                  <dd className="font-medium text-neutral-900">
                    {labelFromRate(view.act1151.vatRate)}
                  </dd>
                </div>
                <div>
                  <dt className="text-neutral-500">NHIL</dt>
                  <dd className="font-medium text-neutral-900">
                    {labelFromRate(view.act1151.nhilRate)}
                  </dd>
                </div>
                <div>
                  <dt className="text-neutral-500">GETFund</dt>
                  <dd className="font-medium text-neutral-900">
                    {labelFromRate(view.act1151.getfundRate)}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-2xs text-neutral-500">
                Source: {view.act1151.source}. Retrieved {formatDate(view.act1151.retrieved)}.
              </p>
              {canChange && (
                <div className="mt-4">
                  <Button variant="secondary" onClick={onRestoreAct1151}>
                    Restore Act 1151 rates
                  </Button>
                </div>
              )}
            </Card>

            {canReadSales && paymentConfig !== null && (
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-neutral-900">Payments</h2>
                    <p className="mt-0.5 text-sm text-neutral-600">
                      Methods the till can take: {paymentConfig.methods.map((m) => METHOD_WORD[m]).join(', ')}.
                    </p>
                  </div>
                  <Badge
                    tone={
                      paymentConfig.mode === 'live'
                        ? 'positive'
                        : paymentConfig.mode === 'test'
                          ? 'warning'
                          : 'negative'
                    }
                  >
                    {paymentConfig.mode === 'live'
                      ? 'Live'
                      : paymentConfig.mode === 'test'
                        ? 'Test mode'
                        : 'Not configured'}
                  </Badge>
                </div>
                {paymentConfig.mode !== 'live' && (
                  <div className="mt-3">
                    <WarningNotice>
                      {paymentConfig.mode === 'test'
                        ? 'Mobile money is in test mode, so charges are not real. Set the live Paystack keys before the pharmacy opens.'
                        : 'No Paystack keys are set, so mobile money cannot be taken yet. Cash still works.'}
                    </WarningNotice>
                  </div>
                )}
              </Card>
            )}

            {canChange && (
              <div className="flex items-center justify-end gap-3 pb-2">
                {!dirty && formValid && (
                  <span className="text-sm text-neutral-500">No changes</span>
                )}
                <Button
                  variant="primary"
                  size="lg"
                  loading={saving}
                  disabled={!canSave}
                  onClick={() => void onSave()}
                >
                  Save changes
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
