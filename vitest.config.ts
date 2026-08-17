import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Resolve workspace packages to their SOURCE, not their built `dist/`.
    //
    // Without this, `pnpm test` silently runs against whatever was last built: editing a
    // shared fixture and re-running tests would appear to change nothing. Vitest
    // transpiles TypeScript on the fly, so there is no reason to go through `dist/`.
    //
    // The stdio integration test is unaffected — it spawns the built server as a real
    // child process on purpose, and skips itself when `dist/` is missing.
    alias: {
      '@sc2mcp/core': path.join(repoRoot, 'packages/sc2-core/src/index.ts'),
      '@sc2mcp/test-utils': path.join(repoRoot, 'packages/sc2-test-utils/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Workspace staging touches the real filesystem; these are not microbenchmarks.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each test creates its own temp directory, so files never collide across workers.
    pool: 'forks',
  },
});
