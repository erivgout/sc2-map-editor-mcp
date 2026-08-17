/**
 * Path security (PLAN.md §35).
 *
 * This server mutates the user's filesystem on behalf of a language model, so every
 * path that crosses the MCP boundary goes through {@link PathGuard} before it is
 * touched. The guard answers exactly one question: *is this real, canonical location
 * inside a root the user allowed?*
 *
 * Two distinct path spaces exist and must never be conflated:
 *
 * - **Host paths** — real Windows/POSIX filesystem paths. Guarded by {@link PathGuard}.
 * - **Archive paths** — paths *inside* an SC2 document (`Base.SC2Data/GameData/...`).
 *   These arrive from untrusted archive contents and are normalised by
 *   {@link normalizeArchivePath}, which is deliberately stricter than the host guard.
 */

import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { SC2Error } from './errors.js';

/** Windows device names that are illegal as a path segment, with or without an extension. */
const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

// Control characters are exactly what this must catch: legal inside a JavaScript
// string, illegal in a Windows filename, and a classic way to smuggle a path past a
// naive check.
// eslint-disable-next-line no-control-regex
const WINDOWS_ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f]/;

/**
 * Renders an unexpected value for an error message.
 *
 * The runtime type guards below are not redundant despite the `string` annotations:
 * arguments arrive from a language model through JSON, and a schema gap would
 * otherwise surface as a confusing `TypeError` deep inside `node:path`.
 */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return `[${typeof value}]`;
}

function denied(message: string, candidate: string, suggestedAction?: string): SC2Error {
  return new SC2Error(
    'SC2_PATH_DENIED',
    message,
    suggestedAction === undefined
      ? { path: candidate, recoverable: true }
      : { path: candidate, recoverable: true, suggestedAction },
  );
}

/**
 * True when `candidate` is `root` itself or lives beneath it.
 *
 * Compares canonical, separator-normalised paths segment-wise, so `C:\Maps2` is not
 * treated as being inside `C:\Maps`. Case-insensitive on Windows, case-sensitive
 * elsewhere — matching the filesystems in question rather than assuming one.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return !relative.split(path.sep).includes('..');
}

/**
 * Resolves the deepest ancestor of `target` that exists and returns its canonical
 * (symlink-free) path plus the not-yet-existing remainder.
 *
 * Needed because `fs.realpath` throws on missing paths, but we must still guard
 * *creation* targets — and a symlinked parent is exactly how a caller would escape an
 * allowed root while pointing at a filename that does not exist yet.
 */
async function realpathDeepestExisting(target: string): Promise<{ base: string; rest: string[] }> {
  const absolute = path.resolve(target);
  const rest: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      const resolved = await realpath(current);
      return { base: resolved, rest: rest.reverse() };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new SC2Error('SC2_IO_ERROR', `Cannot resolve path: ${current}`, { path: current, recoverable: false }, { cause: error });
      }
      const parent = path.dirname(current);
      if (parent === current) {
        // Walked to the filesystem root without finding anything that exists.
        return { base: current, rest: rest.reverse() };
      }
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

export interface PathGuardOptions {
  /** Absolute host paths the caller is allowed to read/write under. */
  readonly allowedRoots: readonly string[];
}

export interface ResolveOptions {
  /**
   * `'must-exist'` requires the full path to resolve on disk (used for inputs).
   * `'may-create'` allows the leaf — or several missing segments — not to exist yet,
   * but still canonicalises and guards every ancestor that does (used for outputs).
   */
  readonly mode?: 'must-exist' | 'may-create';
}

/**
 * Canonicalises host paths and enforces the allowed-roots policy.
 *
 * Construct one per server configuration and share it; it holds no mutable state.
 */
export class PathGuard {
  /** Canonical allowed roots. Resolved lazily on first use so construction stays sync. */
  #canonicalRoots: string[] | undefined;
  readonly #configuredRoots: readonly string[];

  constructor(options: PathGuardOptions) {
    this.#configuredRoots = options.allowedRoots.map((root) => path.resolve(root));
  }

  /** The roots as configured, before canonicalisation. For diagnostics only. */
  get configuredRoots(): readonly string[] {
    return this.#configuredRoots;
  }

  async #roots(): Promise<string[]> {
    if (this.#canonicalRoots !== undefined) return this.#canonicalRoots;
    const resolved: string[] = [];
    for (const root of this.#configuredRoots) {
      try {
        resolved.push(await realpath(root));
      } catch {
        // A configured root that does not exist yet is not an error at construction
        // time — the user may create it later. Keep the literal form so it can still
        // match once it appears.
        resolved.push(root);
      }
    }
    this.#canonicalRoots = resolved;
    return resolved;
  }

  /**
   * Canonicalises `candidate` and asserts it is inside an allowed root.
   *
   * @throws SC2Error `SC2_PATH_DENIED` when the path escapes every root, is
   * malformed, or resolves through a symlink that leaves the allowed area.
   */
  async resolve(candidate: string, options: ResolveOptions = {}): Promise<string> {
    const mode = options.mode ?? 'must-exist';

    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw denied('Path must be a non-empty string.', describeValue(candidate));
    }
    if (candidate.includes('\u0000')) {
      throw denied('Path contains a NUL byte.', candidate);
    }
    if (!path.isAbsolute(candidate)) {
      throw denied(
        'Relative paths are not accepted; pass an absolute path.',
        candidate,
        'Supply the full absolute path, e.g. C:\\Users\\me\\Documents\\StarCraft II\\Maps\\MyMap.SC2Map',
      );
    }

    const roots = await this.#roots();
    if (roots.length === 0) {
      throw denied(
        'No allowed roots are configured, so every path is denied.',
        candidate,
        'Set "allowedRoots" in the server configuration to the directories you want the server to work in.',
      );
    }

    const { base, rest } = await realpathDeepestExisting(candidate);

    if (mode === 'must-exist' && rest.length > 0) {
      throw new SC2Error('SC2_NOT_FOUND', `Path does not exist: ${candidate}`, {
        path: candidate,
        recoverable: true,
      });
    }

    // Guard the missing remainder against traversal and Windows-illegal names before
    // rejoining, so `may-create` cannot smuggle `..` past the containment check.
    for (const segment of rest) {
      assertSafeSegment(segment, candidate);
    }

    const canonical = rest.length > 0 ? path.join(base, ...rest) : base;

    // Containment is checked against the canonical form, so a symlink that points out
    // of an allowed root is rejected even though its literal path looked fine.
    if (!roots.some((root) => isWithinRoot(root, canonical))) {
      throw denied(
        `Path is outside every allowed root: ${canonical}`,
        candidate,
        `Allowed roots: ${roots.join(', ')}`,
      );
    }

    return canonical;
  }

  /** Convenience wrapper for output paths that need not exist yet. */
  async resolveForCreate(candidate: string): Promise<string> {
    return this.resolve(candidate, { mode: 'may-create' });
  }
}

function assertSafeSegment(segment: string, fullPath: string): void {
  if (segment === '.' || segment === '..') {
    throw denied('Path contains a traversal segment.', fullPath);
  }
  if (process.platform === 'win32') {
    if (WINDOWS_ILLEGAL_CHARS.test(segment)) {
      throw denied(`Path segment contains characters Windows does not permit: ${segment}`, fullPath);
    }
    const withoutExtension = segment.split('.')[0]?.toLowerCase() ?? '';
    if (WINDOWS_RESERVED_NAMES.has(withoutExtension)) {
      throw denied(`Path segment is a reserved Windows device name: ${segment}`, fullPath);
    }
    if (/[. ]$/.test(segment)) {
      throw denied(`Path segment ends with a dot or space, which Windows silently strips: ${segment}`, fullPath);
    }
  }
}

/**
 * Normalises a path that came from *inside* an SC2 document.
 *
 * SC2/MPQ archives store paths with backslashes and inconsistent casing; we present
 * them with forward slashes (PLAN.md §10). Anything that could escape an extraction
 * directory is rejected outright rather than sanitised, because a silently-rewritten
 * archive path is a corrupted repack waiting to happen.
 *
 * @throws SC2Error `SC2_PATH_DENIED`
 */
export function normalizeArchivePath(archivePath: string): string {
  if (typeof archivePath !== 'string' || archivePath === '') {
    throw denied('Archive path must be a non-empty string.', describeValue(archivePath));
  }
  if (archivePath.includes('\u0000')) {
    throw denied('Archive path contains a NUL byte.', archivePath);
  }

  const unified = archivePath.replace(/\\/g, '/');

  if (unified.startsWith('/')) {
    throw denied('Archive paths must be relative to the archive root.', archivePath);
  }
  if (/^[a-zA-Z]:/.test(unified)) {
    throw denied('Archive path contains a drive letter.', archivePath);
  }

  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue; // Collapse `a//b` and `a/./b`.
    if (segment === '..') {
      throw denied('Archive path contains a traversal segment.', archivePath);
    }
    assertSafeSegment(segment, archivePath);
    segments.push(segment);
  }

  if (segments.length === 0) {
    throw denied('Archive path is empty after normalisation.', archivePath);
  }

  return segments.join('/');
}

/**
 * Maps an archive path onto a host path beneath `destinationRoot`, refusing anything
 * that would land outside it. Used by extraction (PLAN.md §10 `extract`).
 */
export function resolveArchiveMemberPath(destinationRoot: string, archivePath: string): string {
  const normalized = normalizeArchivePath(archivePath);
  const root = path.resolve(destinationRoot);
  const target = path.resolve(root, ...normalized.split('/'));
  if (!isWithinRoot(root, target)) {
    throw denied(`Archive member would extract outside the destination: ${archivePath}`, archivePath);
  }
  return target;
}

/** Case-normalised archive path, for duplicate detection. SC2 treats these as equal. */
export function archivePathKey(archivePath: string): string {
  return normalizeArchivePath(archivePath).toLowerCase();
}
