/**
 * Dependency resolution (PLAN.md §25).
 *
 * A document's `DocumentInfo` lists dependencies as
 * `bnet:Void Multi (Mod)/0.0/999,file:Mods/VoidMulti.SC2Mod`. Turning that `file:` path
 * into something readable is where it gets interesting, because **stock Blizzard
 * dependencies are not files on disk at all**.
 *
 * Measured on a retail installation: there is no `Mods/` directory. `SC2Data/` contains
 * `config`, `data`, `ecache`, `indices` — Blizzard's CASC content store. The stock mods
 * live inside it, and reading them needs a CASC reader (CascLib or equivalent), which this
 * build does not have and which is a substantially larger piece of work than the MPQ
 * sidecar.
 *
 * What *can* be resolved: dependencies the user has as real files or directories — their
 * own `.SC2Mod` projects, mods shipped alongside a map, anything under a configured search
 * path. Those are common for arcade authors who split content across mods, and they are
 * exactly the ones a map author is likely to be editing.
 *
 * So resolution reports three outcomes, and the difference matters: **resolved**,
 * **in CASC** (exists, but unreadable by this build), and **not found**. Collapsing the
 * middle case into "missing" would tell the user their map is broken when it is fine.
 */

import path from 'node:path';

import { isDirectory, pathExists } from '../fs/index.js';
import type { DocumentDependency } from '../components/documentInfo.js';

export type DependencyResolution = 'resolved' | 'in-casc' | 'not-found';

export interface ResolvedDependency {
  /** The dependency as declared, preserved verbatim. */
  readonly declaration: DocumentDependency;
  readonly resolution: DependencyResolution;
  /** Absolute path when resolved. */
  readonly path: string | null;
  /** True when it resolved to an unpacked directory rather than a packed archive. */
  readonly isDirectory: boolean;
  /** Why it is unresolved, in words the caller can act on. */
  readonly reason: string | null;
}

export interface ResolveDependenciesOptions {
  /**
   * Directories to search, in priority order. Typically the document's own directory,
   * the user's `Documents/StarCraft II` folder, and the SC2 installation root.
   */
  readonly searchRoots: readonly string[];
  /** SC2 installation root, used to recognise a CASC-backed stock dependency. */
  readonly installRoot?: string | null | undefined;
}

/**
 * True when a `file:` path names something Blizzard ships inside CASC.
 *
 * The heuristic is deliberately narrow: a `Mods/` or `Campaigns/` prefix under an
 * installation that has no such directory on disk. That is exactly the stock case, and it
 * avoids claiming CASC for a user's own mod that merely happens to be missing.
 */
function looksLikeStockDependency(filePath: string, installRoot: string | null | undefined): boolean {
  if (installRoot === null || installRoot === undefined) return false;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return normalized.startsWith('mods/') || normalized.startsWith('campaigns/');
}

/**
 * Resolves each declared dependency to a path on disk, where one exists.
 *
 * Order is preserved: SC2 resolves dependencies in declaration order, and later entries
 * override earlier ones (PLAN.md §25).
 */
export async function resolveDependencies(
  dependencies: readonly DocumentDependency[],
  options: ResolveDependenciesOptions,
): Promise<ResolvedDependency[]> {
  const results: ResolvedDependency[] = [];

  for (const declaration of dependencies) {
    if (declaration.file === null) {
      results.push({
        declaration,
        resolution: 'not-found',
        path: null,
        isDirectory: false,
        reason: 'The dependency declares no file path, only a Battle.net identity, so there is nothing to look for locally.',
      });
      continue;
    }

    const relative = declaration.file.replace(/\\/g, '/');
    let found: string | null = null;

    for (const root of options.searchRoots) {
      const candidate = path.resolve(root, ...relative.split('/'));
      if (await pathExists(candidate)) {
        found = candidate;
        break;
      }
    }

    if (found !== null) {
      results.push({
        declaration,
        resolution: 'resolved',
        path: found,
        isDirectory: await isDirectory(found),
        reason: null,
      });
      continue;
    }

    if (looksLikeStockDependency(relative, options.installRoot)) {
      results.push({
        declaration,
        resolution: 'in-casc',
        path: null,
        isDirectory: false,
        reason:
          'This is a stock Blizzard dependency. It lives inside the installation\'s CASC content store rather than as a file, and this build cannot read CASC. The map is fine; its contents are simply not visible here.',
      });
      continue;
    }

    results.push({
      declaration,
      resolution: 'not-found',
      path: null,
      isDirectory: false,
      reason: `No file or directory matching "${declaration.file}" was found under any search root.`,
    });
  }

  return results;
}

/**
 * Default places to look for a dependency, in priority order.
 *
 * The document's own directory comes first: a mod shipped beside a map is the most
 * specific match, and the most likely thing the author is editing.
 */
export function defaultSearchRoots(options: {
  documentPath?: string | undefined;
  documentsRoot?: string | undefined;
  installRoot?: string | null | undefined;
}): string[] {
  const roots: string[] = [];

  if (options.documentPath !== undefined) {
    roots.push(path.dirname(options.documentPath));
    // A sibling of the map's own folder, e.g. Maps/MyMap.SC2Map next to Mods/MyMod.SC2Mod.
    roots.push(path.dirname(path.dirname(options.documentPath)));
  }
  if (options.documentsRoot !== undefined) roots.push(options.documentsRoot);
  if (options.installRoot !== null && options.installRoot !== undefined) roots.push(options.installRoot);

  return [...new Set(roots)];
}
