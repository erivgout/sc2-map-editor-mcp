/**
 * Filesystem primitives shared by every subsystem: hashing, atomic writes, and
 * bounded recursive walks.
 *
 * PLAN.md §35 requires atomic writes and enforced resource limits; PLAN.md §48
 * requires hashing to stay off the hot path. Everything that touches disk on behalf
 * of a tool should go through here rather than calling `node:fs` directly, so the
 * limits are applied in one place.
 */

import { createHash } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import { copyFile, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { SC2Error } from '../errors.js';

/** The one hash used for workspace manifests, change records, and source pinning. */
export const HASH_ALGORITHM = 'sha256';

/** `sha256:<hex>` — self-describing so a stored hash survives an algorithm change. */
export type ContentHash = string;

export function hashBuffer(data: Uint8Array): ContentHash {
  return `${HASH_ALGORITHM}:${createHash(HASH_ALGORITHM).update(data).digest('hex')}`;
}

export async function hashFile(filePath: string): Promise<ContentHash> {
  const hash = createHash(HASH_ALGORITHM);
  try {
    await pipeline(createReadStream(filePath), hash);
  } catch (error) {
    throw new SC2Error(
      'SC2_IO_ERROR',
      `Cannot hash file: ${filePath}`,
      { path: filePath, recoverable: false },
      { cause: error },
    );
  }
  return `${HASH_ALGORITHM}:${hash.digest('hex')}`;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function ensureDir(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
}

/** `readdir` that treats an absent directory as empty rather than throwing. */
export async function readdirSafe(target: string): Promise<Dirent[]> {
  try {
    return await readdir(target, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new SC2Error(
      'SC2_IO_ERROR',
      `Cannot read directory: ${target}`,
      { path: target, recoverable: false },
      { cause: error },
    );
  }
}

/**
 * Writes `data` to `target` such that a reader never observes a partial file.
 *
 * The temp file is created in the *same directory* as the target so the final
 * `rename` stays within one filesystem, where it is atomic. Writing to the OS temp
 * dir and renaming across volumes would silently degrade to a copy.
 */
export async function writeFileAtomic(target: string, data: Uint8Array | string): Promise<void> {
  const directory = path.dirname(target);
  await ensureDir(directory);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);

  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(data);
      // Flush before the rename: a crash between write and rename must leave the
      // original intact, never a renamed-but-empty file.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new SC2Error(
      'SC2_IO_ERROR',
      `Cannot write file: ${target}`,
      { path: target, recoverable: false },
      { cause: error },
    );
  }
}

export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

/** A single file discovered by {@link walkFiles}. Paths are archive-style (`/`-joined). */
export interface WalkedFile {
  /** Path relative to the walk root, using `/` regardless of platform. */
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly size: number;
}

export interface WalkOptions {
  /** Hard ceiling on files returned. Exceeding it is an error, never a silent truncation. */
  readonly maxFiles: number;
  /** Hard ceiling on any single file. Exceeding it is an error. */
  readonly maxFileBytes?: number;
  /** Directory names skipped entirely, compared case-insensitively. */
  readonly skipDirectories?: readonly string[];
}

/**
 * Recursively lists files beneath `root`.
 *
 * Symlinks are **not** followed: `readdir` with `withFileTypes` reports the link
 * itself, and we skip it. Following links inside a staged workspace would let a
 * crafted document reach outside the staging directory (PLAN.md §35).
 *
 * Results are sorted by relative path so callers get deterministic output
 * (PLAN.md §14 "keep output deterministic").
 */
export async function walkFiles(root: string, options: WalkOptions): Promise<WalkedFile[]> {
  const skip = new Set((options.skipDirectories ?? []).map((name) => name.toLowerCase()));
  const results: WalkedFile[] = [];

  async function visit(directory: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new SC2Error(
        'SC2_IO_ERROR',
        `Cannot read directory: ${directory}`,
        { path: directory, recoverable: false },
        { cause: error },
      );
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (skip.has(entry.name.toLowerCase())) continue;
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;

      if (results.length >= options.maxFiles) {
        throw new SC2Error(
          'SC2_LIMIT_EXCEEDED',
          `Directory contains more than the configured maximum of ${options.maxFiles} files.`,
          {
            path: root,
            recoverable: true,
            suggestedAction: 'Raise "maxExtractedFiles" in the server configuration, or point at a smaller document.',
          },
        );
      }

      const info = await stat(absolutePath);
      if (options.maxFileBytes !== undefined && info.size > options.maxFileBytes) {
        throw new SC2Error(
          'SC2_LIMIT_EXCEEDED',
          `File exceeds the configured maximum of ${options.maxFileBytes} bytes: ${relativePath}`,
          {
            path: absolutePath,
            recoverable: true,
            suggestedAction: 'Raise "maxSingleFileBytes" in the server configuration.',
            context: { size: info.size },
          },
        );
      }

      results.push({ relativePath, absolutePath, size: info.size });
    }
  }

  await visit(root, '');
  results.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return results;
}

/**
 * Copies a directory tree, skipping symlinks for the same reason {@link walkFiles}
 * does. Returns the number of files copied.
 */
export async function copyDirectory(source: string, destination: string, options: WalkOptions): Promise<number> {
  const files = await walkFiles(source, options);
  await ensureDir(destination);
  for (const file of files) {
    const target = path.join(destination, ...file.relativePath.split('/'));
    await ensureDir(path.dirname(target));
    await copyFile(file.absolutePath, target);
  }
  return files.length;
}

/** Recursive delete that tolerates an already-absent target. */
export async function removeTree(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

/**
 * Writes `data` non-atomically. Only for scratch files inside a temp directory the
 * caller owns; anything a reader might observe should use {@link writeFileAtomic}.
 */
export async function writeScratchFile(target: string, data: Uint8Array | string): Promise<void> {
  await ensureDir(path.dirname(target));
  await writeFile(target, data);
}
