/**
 * Shared-package jest config.
 *
 * No `detectOpenHandles` and no `forceExit`, unlike the backend: this package
 * opens nothing. There is no socket, no timer, no file handle and no database in
 * it, by construction — `tsconfig.build.json` makes most of those uncompilable.
 * Copying the backend's flags here would slow every run down to guard against a
 * failure mode this package cannot have.
 *
 * @type {import('jest').Config}
 */

// A zone that is deliberately NOT UTC+0, for a package that contains no dates.
//
// That is the point. The engine is date-free by design: Act 1151 took effect on
// 1 January 2026 and replaced the old cascading computation, so a tax engine that
// knew today's date would be an engine that had to know which side of that line a
// sale fell on. This one does not, because the rates arrive as arguments from the
// pharmacy's own settings row rather than being chosen from the calendar.
//
// Setting the zone makes that property observable instead of merely asserted in a
// comment. Every parity vector below has to produce the same pesewas in Asia/Tokyo
// as it would in Africa/Accra, and if a future change introduces a date anywhere
// in this package — a "rate effective from" lookup is the obvious candidate — the
// suite is already running in a zone where getting it wrong shows up.
process.env.TZ = 'Asia/Tokyo';

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  clearMocks: true,
};
