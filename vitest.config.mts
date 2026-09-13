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
        // The same shape: argv in, a file out. What it produces is covered by
        // document.test.ts, and that the committed file matches is covered by
        // the `openapi:check` step in CI, which is a stronger guarantee than a
        // unit test of the writer could give.
        'src/api/openapi/cli.ts',
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
        'src/api/auth/services/rate-limit.service.ts',
        // The linking policy is inseparable from the constraints that enforce
        // it: two unique indexes, one transaction, and what happens when two
        // sign-ins race. Covered by oauth-identity.service.int.test.ts, whose
        // central case is CVE-2026-53516 reproduced against a real database —
        // and both halves of the guard were confirmed to fail the suite when
        // removed. Unit tests here would mock the indexes away and prove
        // nothing about the vulnerability they exist to close.
        'src/api/auth/services/oauth-identity.service.ts',
        // HTTP wiring and the flow it drives: cookies, status codes,
        // middleware order. Covered by e2e/auth-http.int.test.ts against a
        // real server and a real database, which CI runs as its own job. Unit
        // tests here would assert against a fake request object and prove
        // nothing about the wiring.
        //
        // The session guard is deliberately absent from this list: it gained
        // its own unit tests, so excluding it would hide real coverage.
        'src/api/auth/auth.controller.ts',
        'src/api/auth/auth.service.ts',
        // Same shape as auth.controller.ts/auth.service.ts above: HTTP
        // wiring and the flow it drives, covered by
        // e2e/oauth-signin.int.test.ts and e2e/oauth-linking.int.test.ts
        // against a real server, a real database, and a stub identity
        // provider -- including the callback's error paths, which need a
        // provider response to reach at all.
        'src/api/auth/oauth.controller.ts',
        'src/api/auth/services/oauth.service.ts',
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
