/**
 * `@sc2mcp/test-utils` — helpers shared by unit and integration tests.
 *
 * Kept out of `@sc2mcp/core` so the domain package's public surface stays free of
 * test-only affordances (PLAN.md §5).
 */

export * from './temp.js';
export * from './fixtures.js';
