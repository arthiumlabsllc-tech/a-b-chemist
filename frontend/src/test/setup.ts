import '@testing-library/jest-dom';

/**
 * Shared jest setup, kept deliberately small.
 *
 * jsdom provides no service worker and no IndexedDB. The fakes for those live
 * with the suites that need them rather than here, because a fake has to match
 * the exact API surface the code under test uses — guessing that in a shared
 * file creates a second thing to keep in step, and a fake that is slightly wrong
 * makes a test pass against a browser API that does not exist.
 *
 * One thing deliberately not here: a `MessageChannel` polyfill for
 * `react-dom/server`, which jsdom cannot import without one. Node's
 * `MessageChannel` was tried, and its ports hold the event loop open, so React's
 * scheduler kept every jest worker alive after the run finished. Server-render
 * tests use `@jest-environment node` instead, where the primitive exists and
 * `react-dom/server` resolves to its Node build. That also means `window` is
 * genuinely absent rather than deleted for the duration of a test.
 */
