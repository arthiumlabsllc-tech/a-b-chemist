/**
 * The one sentence to show a person when a request failed.
 *
 * Every page catches an `ApiError` and has to decide what to say. Doing it in one
 * place keeps the till, the settings form and the stock screen agreeing, and keeps
 * the distinction the API client is careful about — a request that never connected
 * (`network`, safe to retry, so "you appear to be offline") from one that timed out
 * (`timeout`, which may already have been processed, so *not* "offline") — from
 * being flattened by a page that only meant to print a message.
 *
 * The backend's own message is preferred whenever it sent one, because it is the
 * message written for the person at the counter ("Not enough stock", "Only the
 * owner can change the rates"). The `fallback` is for the two cases where there is
 * nothing to show: a failure that is not an `ApiError` at all, and an `ApiError`
 * the server left blank, which a 5xx that withholds its detail does.
 */

import { ApiError } from './api-client';

export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.isOffline) {
      return 'You appear to be offline. Check the connection and try again.';
    }
    return error.message === '' ? fallback : error.message;
  }
  return fallback;
}
