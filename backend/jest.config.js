/**
 * Backend jest config.
 *
 * No coverage threshold is set yet, and that is deliberate rather than an
 * oversight. A threshold declared before there is a suite to measure either
 * fails every run and gets switched off, or is set so low it means nothing.
 * One is added at the final gate, against the real numbers, where it can be
 * argued for.
 *
 * `testEnvironment: 'node'` and no jsdom: this package has no DOM in it, and
 * pulling one in would let a test pass against a browser API that production
 * does not have.
 *
 * @type {import('jest').Config}
 */

// A zone that is deliberately NOT UTC+0, set here rather than in jest.setup.js.
//
// The machine this suite was written on is UTC+0. So is Ghana, and so is the
// production host. That is the worst possible configuration for finding a
// timezone bug: a date helper reading the local calendar and one reading the UTC
// calendar return the same string in all three places, and different strings for
// part of every day on a developer's laptop west of Greenwich — or on the phone
// replaying an offline sale in Phase 9.
//
// It has to be here and not in `setupFiles`. jest.setup.js runs inside the test
// context, by which point V8 has already resolved that context's timezone and the
// assignment is inert; this file is evaluated by the parent process before it
// spawns a worker, so the workers inherit a zone that actually differs from UTC.
// Tried the other way first, and `clock.test.ts` said so.
process.env.TZ = 'Asia/Tokyo';

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Environment pinned before any module is imported. `setupFiles`, not
  // `setupFilesAfterEnv`: the config singleton is built on first import, so a
  // later hook cannot influence it. See jest.setup.js.
  setupFiles: ['<rootDir>/jest.setup.js'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/server.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  clearMocks: true,
  // A hung handle at the end of a suite is a real defect: it means something
  // opened a connection or a timer and never closed it, which on Render keeps
  // the old process alive through a deploy.
  detectOpenHandles: true,
  forceExit: false,
};
