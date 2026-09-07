import { randomBytes } from 'node:crypto';

/**
 * The reference a mobile money tender is bound to.
 *
 * Built from the receipt number and sixteen random characters. The receipt number
 * is there so a pharmacist on the phone to Paystack support can read a reference
 * that means something and find the sale from it; the random part is there
 * because `sale_number` is unique per pharmacy and not across them, and a
 * webhook arrives with a reference and no way to say which pharmacy it belongs
 * to. One Paystack account means one pharmacy today, and the reference does not
 * rely on that staying true.
 *
 * ## Why it lives here and not in `services/paystack.service.ts`
 *
 * It is minted by the sale write path, which is in `sales.service.ts`, and
 * `paystack.service.ts` already imports from `sales.service.ts` to apply an
 * outcome to a tender. Minting it there would close the loop between the two,
 * and that loop only stays harmless for as long as every use of every import
 * happens to sit inside a function body rather than at module level — an
 * invariant nobody can see from either file. A leaf module with one dependency
 * on `node:crypto` cannot take part in a cycle, and the reference format is a
 * fact about the sale rather than about the gateway in any case.
 *
 * ## Why sixteen characters and not eight
 *
 * The first draft used four random bytes. Four bytes is 32 bits, and references
 * are drawn once per tender forever, so what matters is not the chance of any
 * two colliding but the chance that *some* pair in a growing set does — which
 * reaches even money at around 77,000 of them. A pharmacy ringing 200 mobile
 * money sales a day gets there in about a year, and the failure is not an error:
 * `findSalePaymentByReference` takes the earliest match, so a webhook for the
 * newer tender would settle the older one and both would look correct.
 *
 * Eight bytes puts that boundary past five billion tenders, which no single
 * pharmacy reaches. Migration 0003 backs it with a unique index, so even a
 * collision here would be a refused insert rather than a mis-settled sale — the
 * entropy is what keeps that refusal from ever happening, and the index is what
 * makes it loud instead of silent if it does.
 */
export function newPaymentReference(saleNumber: string): string {
  return `${saleNumber}-${randomBytes(8).toString('hex').toUpperCase()}`;
}
