import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['src/**/*.int.test.ts', 'node_modules/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.{test,spec}.ts',
        // Entrypoints are wiring: they are exercised by the container stack
        // job, not by unit tests, and mocking Nest's bootstrap to reach them
        // would test the mock.
        'src/api/main.ts',
        'src/worker/main.ts',
        'src/**/*.module.ts',
        // A CLI that is I/O from end to end. It is covered, but by the CI
        // `migrations` job, which applies the schema against a real
        // PostgreSQL, asserts re-running is a no-op, then rolls back and
        // re-applies. Unit tests here would test a mocked pg client.
        'src/core/db/migrator/cli.ts',
        // A thin Nest adapter over createPool/createDb, both of which are
        // tested directly in database.test.ts.
        'src/core/db/db.service.ts',
        // Re-export barrels.
        'src/**/index.ts',
        // Checks the source tree rather than running it.
        'src/architecture.test.ts',
        // Test-only helpers, never shipped.
        'src/testing/**',
        // Repositories are database behaviour: ON CONFLICT, unique indexes,
        // concurrent inserts. They are covered by the *.int.test.ts suite
        // against a real PostgreSQL, which CI runs as its own job. Unit tests
        // here would assert that we called a mock.
        'src/**/*.repository.ts',
        // Counting rows inside a moving window is database behaviour, the same
        // as a repository. Covered by rate-limit.service.int.test.ts, which
        // exercises both limits, the interaction between them, and that the
        // counters survive a restart. Unit tests here would mock the counting.
        'src/api/auth/rate-limiting/rate-limit.service.ts',
        // HTTP wiring and the flow it drives: cookies, status codes,
        // middleware order, the guard's interaction with cookie-parser. All
        // covered by auth.http.int.test.ts against a real server and a real
        // database, which CI runs as its own job. Unit tests here would assert
        // against a fake request object and prove nothing about the wiring.
        'src/api/auth/http/auth.controller.ts',
        'src/api/auth/auth.service.ts',
        'src/api/auth/http/session.guard.ts',
      ],
      // Deliberately low for M0, when most of the tree is wiring. The
      // thresholds rise as the milestones that carry real logic land; docs
      // chapter 2.3 expects testing evidence in the evaluation chapter.
      // A ratchet, not an aspiration: these are at or just below what the
      // suite achieves today, so coverage cannot silently fall. Raise them as
      // each milestone lands real logic -- docs chapter 2.3 expects testing
      // evidence in the evaluation chapter.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
