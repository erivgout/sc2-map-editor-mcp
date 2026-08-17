/**
 * Temp-directory helpers for tests.
 *
 * Deliberately depends on nothing but `node:fs` — `@sc2mcp/core` depends on this
 * package in its own tests, so taking a dependency the other way would create a cycle
 * *and* would mean core's tests exercised core's own filesystem helpers as their
 * fixture-setup mechanism.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface TempDir {
  /**
   * Canonical path, already `realpath`-resolved. Necessary because macOS maps
   * `/var` → `/private/var` and Windows temp paths can carry 8.3 short names; an
   * unresolved path would fail the very containment checks under test.
   */
  readonly path: string;
  cleanup(): Promise<void>;
}

export async function createTempDir(prefix = 'sc2mcp-test-'): Promise<TempDir> {
  const created = await mkdtemp(path.join(os.tmpdir(), prefix));
  const canonical = await realpath(created);
  return {
    path: canonical,
    cleanup: async () => {
      await rm(canonical, { recursive: true, force: true });
    },
  };
}

/** Writes a `{ 'relative/path': contents }` map under `root`, creating directories. */
export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}
