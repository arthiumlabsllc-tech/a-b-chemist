'use client';

/**
 * One sale. `/sales/[id]`, gated by `sales:read`.
 *
 * The receipt for a stored sale, and the three things that can still be done to
 * it: void it, add a payment to one left pending, and ask the gateway about a
 * mobile-money tender that never confirmed. It renders the same `Receipt` the till
 * shows the moment a sale completes, so a reprint here and the screen at the
 * counter are one layout rather than two that can drift.
 *
 * The actions are gated twice — by permission and by the sale's state. A settled
 * sale cannot take a payment and a voided sale cannot be voided again, so those
 * buttons are simply not offered. The backend would refuse them anyway, but a
 * button that always fails teaches the operator to distrust every button.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

import { Receipt } from '@/components/pos/receipt';
import { AddPaymentModal, VoidSaleModal } from '@/components/sales/sale-modals';
import { Button } from '@/components/ui/button';
import {
  Card,
  ErrorNotice,
  Money,
  PageHeader,
  Spinner,
  StatusNotice,
} from '@/components/ui/display';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api-error-message';
import type {
  ConfirmChargeResult,
  CreateSalePayment,
  SaleDetail,
  VoidSaleBody,
} from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { outstandingBalance } from '@/lib/sales';

type OpenModal = 'void' | 'addPayment' | null;

export default function SaleDetailPage() {
  const { api, can } = useAuth();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const [detail, setDetail] = useState<SaleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [modal, setModal] = useState<OpenModal>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const result = await api.get<SaleDetail>(`/sales/${id}`);
        if (!cancelled) setDetail(result);
      } catch (error) {
        if (!cancelled) setLoadError(apiErrorMessage(error, 'Could not load this sale.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, id, reloadToken]);

  const canVoid = detail !== null && can('sales:void') && detail.sale.status !== 'voided';
  const canAddPayment =
    detail !== null && can('payments:add') && detail.sale.status === 'pending';
  const canVerify = can('payments:verify');
  const pendingMomo =
    detail?.payments.filter((payment) => payment.method === 'momo' && payment.status === 'pending') ??
    [];

  function open(next: OpenModal) {
    setSubmitError(null);
    setNotice(null);
    setModal(next);
  }

  function closeModal() {
    setModal(null);
    setSubmitError(null);
  }

  async function onVoid(body: VoidSaleBody) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.post<SaleDetail>(`/sales/${id}/void`, body);
      setDetail(result);
      setNotice('Sale voided. The stock went back to its batches and the tenders were reversed.');
      closeModal();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'The sale could not be voided.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function onAddPayment(body: CreateSalePayment) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.post<SaleDetail>(`/sales/${id}/payments`, body);
      setDetail(result);
      setNotice(
        result.sale.status === 'pending'
          ? 'Payment recorded. The sale is still awaiting confirmation.'
          : 'Payment recorded. The sale is now settled.'
      );
      closeModal();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'The payment could not be added.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function onVerify(paymentId: string) {
    setSubmitting(true);
    setSubmitError(null);
    setNotice(null);
    try {
      const result = await api.post<ConfirmChargeResult>(`/sales/payments/${paymentId}/verify`);
      if (result.detail !== null) setDetail(result.detail);
      if (result.unsettled) {
        setNotice(
          'The gateway has not settled this payment yet, so it is still pending. Ask the customer to approve it, or take another payment.'
        );
      } else if (result.arrivedAfterVoid) {
        setNotice(
          'The payment confirmed, but this sale had already been voided. It needs reconciling against the drawer.'
        );
      } else if (result.changed) {
        setNotice('Payment confirmed. The sale has been updated.');
      } else {
        setNotice('The gateway had nothing new — this payment was already settled.');
      }
    } catch (error) {
      setSubmitError(apiErrorMessage(error, 'The payment could not be verified.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={detail === null ? 'Sale' : `Sale ${detail.sale.saleNumber}`}
        subtitle={detail === null ? undefined : formatDateTime(detail.sale.createdAt)}
        actions={
          <Button variant="secondary" onClick={() => router.push('/sales')}>
            Back to sales
          </Button>
        }
      />

      <div className="mx-auto w-full max-w-2xl space-y-4 p-4 sm:p-6">
        {notice !== null && <StatusNotice>{notice}</StatusNotice>}

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
            <Spinner label="Loading sale…" />
          </div>
        )}

        {!loading && loadError === null && detail !== null && (
          <div className="space-y-4">
            <Card>
              <Receipt detail={detail} />
            </Card>

            {(canVoid || canAddPayment || (canVerify && pendingMomo.length > 0)) && (
              <Card className="space-y-3">
                <p className="text-sm font-semibold text-neutral-900">Actions</p>
                {modal === null && submitError !== null && <ErrorNotice>{submitError}</ErrorNotice>}

                {(canVoid || canAddPayment) && (
                  <div className="flex flex-wrap gap-2">
                    {canAddPayment && (
                      <Button variant="primary" onClick={() => open('addPayment')} disabled={submitting}>
                        Add a payment
                      </Button>
                    )}
                    {canVoid && (
                      <Button variant="danger" onClick={() => open('void')} disabled={submitting}>
                        Void sale
                      </Button>
                    )}
                  </div>
                )}

                {canVerify && pendingMomo.length > 0 && (
                  <div className="space-y-2 border-t border-surface-200 pt-3">
                    <p className="text-2xs text-neutral-500">
                      Mobile money awaiting confirmation. Verifying asks the gateway about the
                      payment that is already there — it never starts a second charge.
                    </p>
                    {pendingMomo.map((payment) => (
                      <div key={payment.id} className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate text-sm text-neutral-600">
                          <Money value={payment.amount} />
                          {' · '}
                          {payment.reference === null ? 'no reference' : payment.reference}
                        </span>
                        <Button
                          variant="secondary"
                          loading={submitting}
                          onClick={() => void onVerify(payment.id)}
                        >
                          Verify
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}
          </div>
        )}
      </div>

      <VoidSaleModal
        open={modal === 'void'}
        saleNumber={detail?.sale.saleNumber ?? ''}
        submitting={submitting}
        error={submitError}
        onClose={closeModal}
        onSubmit={(body) => void onVoid(body)}
      />
      <AddPaymentModal
        open={modal === 'addPayment'}
        saleNumber={detail?.sale.saleNumber ?? ''}
        outstanding={
          detail === null ? '0.00' : outstandingBalance(detail.sale.total, detail.sale.amountPaid)
        }
        submitting={submitting}
        error={submitError}
        onClose={closeModal}
        onSubmit={(body) => void onAddPayment(body)}
      />
    </div>
  );
}
