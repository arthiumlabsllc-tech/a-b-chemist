/**
 * The three things the till must still have when the server cannot be reached:
 * the catalogue, the tax settings and who is signed in with what permissions.
 *
 * ## Why these three and nothing else
 *
 * They are exactly what BRIEF.md §4.5 names, and each is the minimum for one
 * offline capability. The catalogue is what the product grid renders and what a
 * basket is built from; without it there is nothing to tap. The tax settings are
 * what let a basket be priced on-device at all — `priceTillBasket` takes them as
 * an argument, and in exclusive-pricing mode the total cannot be computed without
 * the rates. The session is what lets a tablet that restarted during an outage
 * still show the till to the person who was signed in, rather than a login form
 * that cannot log anybody in because `/auth/refresh` needs the server too.
 *
 * Patient data is deliberately never cached. It is personal health data under
 * Act 843, the API is a different origin that `sw.js` refuses to cache in any
 * phase, and nothing offline needs it: a sale is queued against a `productId`,
 * not a patient.
 *
 * ## Why a port, with the browser binding kept out of the logic
 *
 * `CachePort` is the whole surface — read a key, write a key, drop a key, clear.
 * `memoryCache` implements it in a `Map` and is what every test uses; `idbCache`
 * implements it over `lib/offline/idb.ts`. The typed accessors below
 * (`rememberCatalogue`, `readCatalogue`, …) are written against the port, so the
 * round-trip, the `fetchedAt` stamp and the "absent key is null" behaviour are all
 * testable without a browser — the same split `auth-session.ts` makes between its
 * store and `browserRefreshTokenStorage`, and the reason `src/test/setup.ts` has no
 * IndexedDB fake in it.
 */

import type { AuthUser } from '../auth-session';
import type { TaxSettingsView, TillProduct } from '../api-types';
import { CACHE_STORE, idbAvailable, idbClear, idbDelete, idbGet, idbPut } from './idb';

/** One cached value and the moment it was fetched, so staleness can be judged. */
export interface CacheEntry<T> {
  value: T;
  /** Epoch milliseconds. `Date.now()` at the moment the server answered. */
  fetchedAt: number;
}

/**
 * The persistence surface. Implementations decide where bytes go; the accessors
 * below decide what a byte means.
 */
export interface CachePort {
  /** The entry under `key`, or null when nothing has been cached there. */
  read<T>(key: string): Promise<CacheEntry<T> | null>;
  /** Stores `value` under `key`, stamped with the current time. */
  write<T>(key: string, value: T): Promise<void>;
  /**
   * Drops the entry under one `key`, leaving the rest of the cache alone.
   *
   * Needed because the three cached things have different lifetimes. A session the
   * server ended must not be restorable, so it goes; the catalogue and the tax
   * settings are not secrets and are still worth having, so they stay. `clear`
   * could do the job only by throwing away the two things the next person to sign
   * in on this tablet would immediately need again.
   */
  delete(key: string): Promise<void>;
  /** Drops every cached value. */
  clear(): Promise<void>;
}

/** The catalogue as the till loaded it: the products and the filter chips. */
export interface CachedCatalogue {
  products: TillProduct[];
  categories: string[];
}

/**
 * Who was signed in, cached so a restart during an outage can restore the till.
 *
 * The access token is not here and never would be: it is memory-only by the
 * security posture in `auth-session.ts`. What is cached is the identity and the
 * granted permissions — enough to render the till and gate its buttons offline,
 * and nothing that could authorise a request, because offline there are no
 * requests to authorise: writes queue and reads come from this cache.
 */
export interface CachedSession {
  user: AuthUser;
  permissions: string[];
}

const CATALOGUE_KEY = 'catalogue';
const TAX_SETTINGS_KEY = 'taxSettings';
const SESSION_KEY = 'session';

/** The record as it sits in IndexedDB, keyed by `key` (the store's `keyPath`). */
interface CacheRecord {
  key: string;
  value: unknown;
  fetchedAt: number;
}

/** An in-memory `CachePort`. What tests use; also the fallback with no IndexedDB. */
export function memoryCache(): CachePort {
  const entries = new Map<string, CacheEntry<unknown>>();
  return {
    async read<T>(key: string): Promise<CacheEntry<T> | null> {
      const entry = entries.get(key);
      // Copied on the way out so a caller mutating the result cannot rewrite what
      // is stored, which would make a later read disagree with the write that put
      // it there.
      return entry === undefined ? null : { value: entry.value as T, fetchedAt: entry.fetchedAt };
    },
    async write<T>(key: string, value: T): Promise<void> {
      entries.set(key, { value, fetchedAt: Date.now() });
    },
    async delete(key: string): Promise<void> {
      entries.delete(key);
    },
    async clear(): Promise<void> {
      entries.clear();
    },
  };
}

/** The IndexedDB-backed `CachePort`, over the guarded binding in `idb.ts`. */
export function idbCache(): CachePort {
  return {
    async read<T>(key: string): Promise<CacheEntry<T> | null> {
      const record = await idbGet<CacheRecord>(CACHE_STORE, key);
      return record === undefined ? null : { value: record.value as T, fetchedAt: record.fetchedAt };
    },
    async write<T>(key: string, value: T): Promise<void> {
      const record: CacheRecord = { key, value, fetchedAt: Date.now() };
      await idbPut(CACHE_STORE, record);
    },
    async delete(key: string): Promise<void> {
      await idbDelete(CACHE_STORE, key);
    },
    async clear(): Promise<void> {
      await idbClear(CACHE_STORE);
    },
  };
}

// --- Typed accessors --------------------------------------------------------
//
// Written against `CachePort` rather than a singleton, so a test passes
// `memoryCache()` and the app passes `getOfflineCache()`. The keys are private to
// this module: a caller names a thing ("the catalogue"), never a string, so two
// parts of the app cannot cache different values under one key by typo.

export function rememberCatalogue(cache: CachePort, catalogue: CachedCatalogue): Promise<void> {
  return cache.write<CachedCatalogue>(CATALOGUE_KEY, catalogue);
}

export function readCatalogue(cache: CachePort): Promise<CacheEntry<CachedCatalogue> | null> {
  return cache.read<CachedCatalogue>(CATALOGUE_KEY);
}

export function rememberTaxSettings(cache: CachePort, view: TaxSettingsView): Promise<void> {
  return cache.write<TaxSettingsView>(TAX_SETTINGS_KEY, view);
}

export function readTaxSettings(cache: CachePort): Promise<CacheEntry<TaxSettingsView> | null> {
  return cache.read<TaxSettingsView>(TAX_SETTINGS_KEY);
}

export function rememberSession(
  cache: CachePort,
  user: AuthUser,
  permissions: readonly string[]
): Promise<void> {
  // Copied into a plain array: the session hands out a `readonly string[]` and
  // IndexedDB will not clone a frozen or exotic array reliably across browsers.
  return cache.write<CachedSession>(SESSION_KEY, { user, permissions: [...permissions] });
}

export function readSession(cache: CachePort): Promise<CacheEntry<CachedSession> | null> {
  return cache.read<CachedSession>(SESSION_KEY);
}

/**
 * Drops the cached session and nothing else.
 *
 * Called whenever a session ends for a reason the server gave — revoked,
 * deactivated, signed out — and it is the load-bearing half of the offline
 * restore. Without it, deactivating a staff member would take effect only while
 * their tablet could reach the server: the cached identity would sit in IndexedDB
 * and the next offline restart would hand the till straight back to them.
 */
export function forgetSession(cache: CachePort): Promise<void> {
  return cache.delete(SESSION_KEY);
}

// --- The app's one cache ----------------------------------------------------

let cache: CachePort | null = null;

/**
 * The cache the app uses: IndexedDB where it exists, memory where it does not.
 *
 * Created on first use rather than at import, so importing this module during a
 * server render or in a test touches no browser storage — the same rule
 * `getAuthSession()` follows. The memory fallback is honest about its limit: it
 * does not survive a reload, so on a browser with no IndexedDB the till simply
 * cannot trade through a restart, and says so rather than pretending to cache.
 */
export function getOfflineCache(): CachePort {
  if (cache === null) {
    cache = idbAvailable() ? idbCache() : memoryCache();
  }
  return cache;
}

/** Drops the singleton. Tests use it; the app never needs to. */
export function resetOfflineCache(): void {
  cache = null;
}
