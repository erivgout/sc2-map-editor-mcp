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

/**
 * Version of the `sc2mpq` sidecar CLI contract. The helper must report a matching
 * value or the adapter refuses to use it — a silently-mismatched sidecar is how a
 * repack corrupts a map.
 */
export const MPQ_HELPER_PROTOCOL_VERSION = 1;

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
