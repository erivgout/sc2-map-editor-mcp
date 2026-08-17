/**
 * `@sc2mcp/core` — the domain layer.
 *
 * Nothing here knows about MCP. Tool handlers in `@sc2mcp/server` validate input,
 * call into these services, and translate results (PLAN.md §4).
 */

export * from './archive/index.js';
export * from './capabilities.js';
export * from './components/index.js';
export * from './config.js';
export * from './errors.js';
export * from './fs/index.js';
export * from './install/index.js';
export * from './logging.js';
export * from './paths.js';
export * from './process/index.js';
export * from './workspace/index.js';
export * from './xml/index.js';
