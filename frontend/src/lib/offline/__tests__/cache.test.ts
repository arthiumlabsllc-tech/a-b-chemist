/**
 * The offline read cache, against the in-memory port. The IndexedDB binding is a
 * thin adapter over `idb.ts` and is not unit-tested here — the port contract is
 * what the accessors depend on, and `src/test/setup.ts` has no IndexedDB fake on
 * purpose.
 */

import type { AuthUser } from '../../auth-session';
import type { TaxSettingsView } from '../../api-types';
import {
  forgetSession,
  memoryCache,
  readCatalogue,
  readSession,
  readTaxSettings,
  rememberCatalogue,
  rememberSession,
  rememberTaxSettings,
} from '../cache';

const USER: AuthUser = {
  id: 'user-1',
  fullName: 'Ama Mensah',
  email: 'ama@abchemist.test',
  role: 'pharmacist',
  isActive: true,
};

describe('the offline read cache', () => {
  it('reads null for a key nothing has been cached under', async () => {
    // The distinction the till depends on: "not cached yet" is null, not an empty
    // catalogue that would render a grid with nothing in it and no way to tell why.
    expect(await readCatalogue(memoryCache())).toBeNull();
    expect(await readTaxSettings(memoryCache())).toBeNull();
    expect(await readSession(memoryCache())).toBeNull();
  });

  it('round-trips the catalogue and stamps when it was fetched', async () => {
    const cache = memoryCache();
    const before = Date.now();
    // An empty product list still exercises the round-trip; the shape of a
    // TillProduct is guarded by api-types.mirror.test.ts, not re-asserted here.
    await rememberCatalogue(cache, { products: [], categories: ['Analgesics', 'Antibiotics'] });

    const entry = await readCatalogue(cache);
    expect(entry).not.toBeNull();
    expect(entry?.value.categories).toEqual(['Analgesics', 'Antibiotics']);
    expect(entry?.value.products).toEqual([]);
    // A real timestamp, so a caller can judge staleness rather than trusting the
    // cache blindly forever.
    expect(entry?.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(entry?.fetchedAt).toBeLessThanOrEqual(Date.now());
  });

  it('round-trips the tax settings', async () => {
    const cache = memoryCache();
    // The view's full shape is the mirror test's concern; this checks the accessor
    // pairs the right value with the right key.
    const view = { taxInclusivePricing: true } as unknown as TaxSettingsView;
    await rememberTaxSettings(cache, view);

    const entry = await readTaxSettings(cache);
    expect(entry?.value.taxInclusivePricing).toBe(true);
  });

  it('round-trips the session, copying permissions into a plain writable array', async () => {
    const cache = memoryCache();
    // A readonly/frozen list is what the session holds; IndexedDB will not clone
    // every exotic array reliably, so the cache copies it. Passing a frozen array
    // proves the copy happens rather than the reference being stored.
    const permissions = Object.freeze(['sales:create', 'patients:read']);
    await rememberSession(cache, USER, permissions);

    const entry = await readSession(cache);
    expect(entry?.value.user).toEqual(USER);
    expect(entry?.value.permissions).toEqual(['sales:create', 'patients:read']);
    expect(Array.isArray(entry?.value.permissions)).toBe(true);
  });

  it('overwrites a key rather than accumulating under it', async () => {
    const cache = memoryCache();
    await rememberCatalogue(cache, { products: [], categories: ['First'] });
    await rememberCatalogue(cache, { products: [], categories: ['Second'] });

    const entry = await readCatalogue(cache);
    expect(entry?.value.categories).toEqual(['Second']);
  });

  it('drops only the session when the session is what has ended', async () => {
    const cache = memoryCache();
    await rememberCatalogue(cache, { products: [], categories: ['Analgesics'] });
    await rememberTaxSettings(cache, { taxInclusivePricing: true } as unknown as TaxSettingsView);
    await rememberSession(cache, USER, ['sales:create']);

    await forgetSession(cache);

    // The load-bearing half of the offline restore: a session the server ended must
    // not be restorable from this device, or deactivating a staff member would only
    // take effect while their tablet could reach the server.
    expect(await readSession(cache)).toBeNull();
    // And the other two survive, because they are not secrets and the next person
    // to sign in on this tablet needs them immediately — an offline till with no
    // cached catalogue has nothing to sell from.
    expect(await readCatalogue(cache)).not.toBeNull();
    expect(await readTaxSettings(cache)).not.toBeNull();
  });

  it('clears every key', async () => {
    const cache = memoryCache();
    await rememberCatalogue(cache, { products: [], categories: ['Analgesics'] });
    await rememberSession(cache, USER, ['sales:create']);

    await cache.clear();

    expect(await readCatalogue(cache)).toBeNull();
    expect(await readSession(cache)).toBeNull();
  });
});
