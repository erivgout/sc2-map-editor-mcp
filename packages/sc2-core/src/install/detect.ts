/**
 * StarCraft II installation discovery (PLAN.md §16.A, §29).
 *
 * Rules the plan sets and this module keeps to:
 *   - never scan the whole disk;
 *   - never hardcode a single executable path;
 *   - return *candidates* and let the caller/user disambiguate.
 *
 * Two findings from ADR 0001 shape the implementation:
 *   1. `StarCraft II.exe` at the install root is the launcher shim — its file version
 *      (1.18.x) is unrelated to the game build. The real builds live in
 *      `Versions\Base<N>\SC2_x64.exe`, so the build number comes from there.
 *   2. `%USERPROFILE%\Documents` is not necessarily the Documents folder. OneDrive
 *      Known Folder Move relocates it, which is the case on the development machine.
 */

import { readdirSafe, pathExists } from '../fs/index.js';
import path from 'node:path';
import os from 'node:os';

export interface Sc2Installation {
  /** Installation root, e.g. `C:\Program Files (x86)\StarCraft II`. */
  readonly path: string;
  /** How this candidate was found. Ordered strongest-first by the caller. */
  readonly source: 'config' | 'environment' | 'registry' | 'known-location';
  /** Absolute path of the editor executable, preferring the 64-bit build. */
  readonly editorPath: string | null;
  /** Highest `Versions\Base<N>` found, or `null` when the folder is absent. */
  readonly latestBuild: number | null;
  /** Absolute path of `SC2_x64.exe` for {@link latestBuild}. */
  readonly gameExecutablePath: string | null;
  /** True when the root looks like a real installation rather than a stray folder. */
  readonly usable: boolean;
}

/** Editor executables, most-preferred first. */
const EDITOR_EXECUTABLES = ['StarCraft II Editor_x64.exe', 'StarCraft II Editor.exe'];

/** Non-recursive, hand-picked locations. Deliberately short — this is not a search. */
function knownLocations(): string[] {
  if (process.platform === 'win32') {
    const candidates = [
      process.env['ProgramFiles(x86)'],
      process.env['ProgramFiles'],
      process.env['ProgramW6432'],
    ].filter((value): value is string => value !== undefined && value !== '');
    const roots = candidates.map((base) => path.join(base, 'StarCraft II'));
    // Blizzard's installer offers a second drive often enough to be worth one guess.
    roots.push('C:\\Program Files (x86)\\StarCraft II', 'D:\\StarCraft II');
    return [...new Set(roots)];
  }
  if (process.platform === 'darwin') {
    return ['/Applications/StarCraft II'];
  }
  return [path.join(os.homedir(), 'StarCraft II')];
}

/** Parses `Base97563` → `97563`. Returns `null` for anything else. */
function parseBuildFolder(name: string): number | null {
  const match = /^Base(\d+)$/.exec(name);
  if (match?.[1] === undefined) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Inspects one candidate root without deciding whether it is *the* installation. */
export async function inspectInstallation(root: string, source: Sc2Installation['source']): Promise<Sc2Installation> {
  const resolvedRoot = path.resolve(root);

  let editorPath: string | null = null;
  for (const executable of EDITOR_EXECUTABLES) {
    const candidate = path.join(resolvedRoot, executable);
    if (await pathExists(candidate)) {
      editorPath = candidate;
      break;
    }
  }

  let latestBuild: number | null = null;
  const versionEntries = await readdirSafe(path.join(resolvedRoot, 'Versions'));
  for (const entry of versionEntries) {
    if (!entry.isDirectory()) continue;
    const build = parseBuildFolder(entry.name);
    if (build !== null && (latestBuild === null || build > latestBuild)) latestBuild = build;
  }

  let gameExecutablePath: string | null = null;
  if (latestBuild !== null) {
    for (const executable of ['SC2_x64.exe', 'SC2.exe']) {
      const candidate = path.join(resolvedRoot, 'Versions', `Base${latestBuild}`, executable);
      if (await pathExists(candidate)) {
        gameExecutablePath = candidate;
        break;
      }
    }
  }

  return {
    path: resolvedRoot,
    source,
    editorPath,
    latestBuild,
    gameExecutablePath,
    // An installation is only useful to us if we can reach the editor. A game-only
    // install (no editor) is reported but marked unusable rather than hidden.
    usable: editorPath !== null,
  };
}

export interface DetectInstallationsOptions {
  /** `sc2InstallPath` from configuration, when set. */
  readonly configuredPath?: string | null | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Extra roots to consider, e.g. results of a registry query. Injected rather than
   * read here so this module stays free of child-process spawning.
   */
  readonly registryPaths?: readonly string[];
}

/**
 * Returns every plausible installation, strongest evidence first, deduplicated by
 * canonical path.
 *
 * The caller decides what to do with more than one. PLAN.md §16.A is explicit: do not
 * silently select when ambiguous.
 */
export async function detectInstallations(options: DetectInstallationsOptions = {}): Promise<Sc2Installation[]> {
  const env = options.env ?? process.env;

  const ordered: { root: string; source: Sc2Installation['source'] }[] = [];

  if (options.configuredPath !== null && options.configuredPath !== undefined && options.configuredPath !== '') {
    ordered.push({ root: options.configuredPath, source: 'config' });
  }

  const fromEnv = env['SC2MCP_SC2_INSTALL_PATH'] ?? env['SC2PATH'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    ordered.push({ root: fromEnv.trim(), source: 'environment' });
  }

  for (const registryPath of options.registryPaths ?? []) {
    if (registryPath.trim() !== '') ordered.push({ root: registryPath.trim(), source: 'registry' });
  }

  for (const known of knownLocations()) {
    ordered.push({ root: known, source: 'known-location' });
  }

  const seen = new Set<string>();
  const results: Sc2Installation[] = [];
  for (const { root, source } of ordered) {
    const key = path.resolve(root).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(await pathExists(root))) continue;
    results.push(await inspectInstallation(root, source));
  }

  return results;
}

/**
 * Picks a single installation only when the choice is unambiguous.
 *
 * Returns `null` when nothing usable was found, or when several *equally strong*
 * candidates exist — the caller must then ask rather than assume. A `config` or
 * `environment` hit always wins, because the user stated it explicitly.
 */
export function selectInstallation(candidates: readonly Sc2Installation[]): Sc2Installation | null {
  const usable = candidates.filter((candidate) => candidate.usable);
  if (usable.length === 0) return null;

  const explicit = usable.filter((candidate) => candidate.source === 'config' || candidate.source === 'environment');
  if (explicit.length > 0) return explicit[0] ?? null;

  return usable.length === 1 ? (usable[0] ?? null) : null;
}
