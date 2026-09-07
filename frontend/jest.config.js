/**
 * Jest for the frontend.
 *
 * Scope: the pure logic the app depends on being exactly right — on-device
 * pricing, the sync queue, the API client's error classification, configuration
 * resolution. Rendering whole pages needs a mocked auth store, a mocked router
 * and a mocked API for every screen, which buys far less confidence per line
 * than `next build` plus the type checker already do.
 *
 * No coverage threshold. The backend will have one because its surface is
 * largely pure functions; this one is mostly components, and a threshold here
 * would either be met by testing the wrong things or be ignored.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    // Next resolves this alias natively; jest has no bundler, so it has to be
    // told. Without the mapping every `@/lib/...` import fails at runtime while
    // the type checker stays perfectly happy about it.
    '^@/(.*)$': '<rootDir>/src/$1',
    // Tailwind is a build step, not something a unit test can import.
    '\\.(css|less|scss|sass)$': '<rootDir>/src/test/style-mock.js',
  },
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        // The app's tsconfig targets the Next bundler, which ts-jest cannot
        // consume: it needs CommonJS output and classic node resolution. These
        // overrides are the minimum that lets the same source run under jest.
        // Note this deliberately does NOT extend tsconfig.base.json, so
        // `noUncheckedIndexedAccess` is off here and on in the real build — the
        // type checker, not jest, is what enforces it.
        tsconfig: {
          target: 'ES2017',
          lib: ['dom', 'dom.iterable', 'esnext'],
          module: 'commonjs',
          moduleResolution: 'node',
          jsx: 'react-jsx',
          esModuleInterop: true,
          allowJs: true,
          resolveJsonModule: true,
          isolatedModules: false,
          strict: true,
          skipLibCheck: true,
        },
      },
    ],
  },
  collectCoverageFrom: ['src/lib/**/*.ts', 'src/hooks/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  clearMocks: true,
};
