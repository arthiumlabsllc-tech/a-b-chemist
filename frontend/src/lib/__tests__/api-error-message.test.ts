import { ApiError } from '../api-client';
import { apiErrorMessage } from '../api-error-message';

/**
 * The mapping every page relies on to say something honest after a failed
 * request. The two cases worth pinning are the ones that are easy to merge and
 * wrong to: a network failure says "offline" (safe to retry), and a timeout must
 * *not*, because a timed-out write may already have been recorded.
 */
describe('apiErrorMessage', () => {
  it('says the device is offline for a network failure, whatever the fallback', () => {
    const error = new ApiError('network', 'fetch failed');
    expect(apiErrorMessage(error, 'Could not load.')).toBe(
      'You appear to be offline. Check the connection and try again.'
    );
  });

  it('shows the backend message for an http failure', () => {
    const error = new ApiError('http', 'Not enough stock to fill that basket', {
      status: 409,
      code: 'insufficient_stock',
    });
    expect(apiErrorMessage(error, 'Could not save.')).toBe('Not enough stock to fill that basket');
  });

  it('falls back when an http failure carried no message', () => {
    const error = new ApiError('http', '', { status: 500 });
    expect(apiErrorMessage(error, 'Could not save.')).toBe('Could not save.');
  });

  it('does not call a timeout offline, and shows its own message', () => {
    // The distinction the API client keeps: a timeout may have been processed, so
    // it must not be flattened into the retryable "you appear to be offline".
    const error = new ApiError('timeout', 'The request took too long');
    expect(apiErrorMessage(error, 'Could not load.')).toBe('The request took too long');
  });

  it('falls back for something that is not an ApiError at all', () => {
    expect(apiErrorMessage(new Error('boom'), 'Could not load.')).toBe('Could not load.');
    expect(apiErrorMessage('boom', 'Could not load.')).toBe('Could not load.');
    expect(apiErrorMessage(null, 'Could not load.')).toBe('Could not load.');
    expect(apiErrorMessage(undefined, 'Could not load.')).toBe('Could not load.');
  });
});
