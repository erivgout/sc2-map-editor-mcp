import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Workspace staging touches the real filesystem; these are not microbenchmarks.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each test creates its own temp directory, so files never collide across workers.
    pool: 'forks',
  },
});
