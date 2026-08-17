/**
 * Build identity reported by `sc2_get_server_info` (PLAN.md §7 step 3, §16.A, §40).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** MCP revision this server targets. Verified against the SDK v2 wire era in ADR 0001. */
export const MCP_PROTOCOL_TARGET = '2026-07-28';

/** Bumped whenever the persisted workspace layout changes (PLAN.md §40). */
export const WORKSPACE_STATE_SCHEMA_VERSION = 1;

// The sidecar protocol version lives with the adapter that enforces it
// (`@sc2mcp/core`'s archive/protocol.ts), so there is one definition to keep in step
// with native/sc2mpq/CMakeLists.txt rather than two.
export { MPQ_HELPER_PROTOCOL_VERSION } from '@sc2mcp/core';

function readOwnVersion(): string {
  // Resolves identically from `src/` (tests) and `dist/` (build): both sit one level
  // below the package root.
  const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_NAME = 'sc2-map-editor-mcp';
export const SERVER_VERSION = readOwnVersion();
