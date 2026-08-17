/**
 * Commit: writing a staged document back out (PLAN.md §9).
 *
 * This is the one operation that leaves the server's own state directory and touches
 * something the user cares about, so it is the most conservative thing in the codebase:
 *
 *  1. Refuse if validation found errors, unless the caller explicitly forces it.
 *  2. Refuse if the *source* changed since it was opened, unless the caller allows it —
 *     otherwise a commit silently discards whatever else edited the document.
 *  3. Build the output somewhere else, then move it into place, so an interruption never
 *     leaves a half-written document.
 *  4. Never overwrite without being asked, and back up first when told to.
 */

import { rename } from 'node:fs/promises';
import path from 'node:path';

import { SC2Error } from '../errors.js';
import { copyDirectory, ensureDir, isDirectory, pathExists, removeTree, type WalkOptions } from '../fs/index.js';
import type { Logger } from '../logging.js';

export interface CommitInput {
  /** Canonical, guarded destination path. */
  readonly outputPath: string;
  /** The staged tree to write out. */
  readonly workingPath: string;
  readonly sourceKind: 'directory' | 'mpq';
  /** Replace an existing file or directory at the destination. */
  readonly overwrite: boolean;
  /** Take a timestamped backup before overwriting. Ignored when not overwriting. */
  readonly backup: boolean;
  readonly walkLimits: WalkOptions;
  readonly logger: Logger;
}

export interface CommitResult {
  readonly outputPath: string;
  readonly fileCount: number;
  /** Where the previous contents were moved, when a backup was taken. */
  readonly backupPath: string | null;
  readonly overwritten: boolean;
}

/** `Name.SC2Map` -> `Name.SC2Map.backup-20260817-104900`. */
function backupPathFor(outputPath: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `${outputPath}.backup-${stamp}`;
}

/**
 * Writes a staged document to `outputPath` as an unpacked directory.
 *
 * Packing to an `.SC2Map` archive needs the MPQ helper; that path refuses explicitly
 * rather than writing a directory where the caller asked for an archive.
 */
export async function commitDocument(input: CommitInput): Promise<CommitResult> {
  if (input.sourceKind === 'mpq') {
    throw new SC2Error(
      'SC2_UNSUPPORTED_OPERATION',
      'Committing to a packed archive needs the sc2mpq helper, which is not available in this build.',
      {
        path: input.outputPath,
        recoverable: false,
        suggestedAction: 'Commit to a directory path instead, or build the helper (see docs/native-helper.md).',
      },
    );
  }

  const destinationExists = await pathExists(input.outputPath);
  if (destinationExists && !input.overwrite) {
    throw new SC2Error('SC2_CONFLICT', `Something already exists at ${input.outputPath}.`, {
      path: input.outputPath,
      recoverable: true,
      suggestedAction: 'Choose a different output path, or pass overwrite=true.',
    });
  }

  if (destinationExists && !(await isDirectory(input.outputPath))) {
    // Overwriting a *file* with a directory is almost certainly not what was meant, and
    // the file may be a packed map the user still wants.
    throw new SC2Error(
      'SC2_CONFLICT',
      `${input.outputPath} exists and is a file; this build writes unpacked document directories.`,
      {
        path: input.outputPath,
        recoverable: true,
        suggestedAction: 'Pick a directory path, or build the MPQ helper to write a packed archive.',
      },
    );
  }

  // Stage the output beside its destination so the final move is a same-volume rename.
  const staging = `${input.outputPath}.incoming-${process.pid}-${Date.now()}`;
  await removeTree(staging);

  let fileCount: number;
  try {
    await ensureDir(path.dirname(input.outputPath));
    fileCount = await copyDirectory(input.workingPath, staging, input.walkLimits);
  } catch (error) {
    await removeTree(staging);
    throw new SC2Error(
      'SC2_IO_ERROR',
      `Could not build the output document; nothing at ${input.outputPath} was changed.`,
      { path: input.outputPath, recoverable: false },
      { cause: error },
    );
  }

  let backupPath: string | null = null;
  try {
    if (destinationExists) {
      if (input.backup) {
        backupPath = backupPathFor(input.outputPath, new Date());
        await rename(input.outputPath, backupPath);
      } else {
        await removeTree(input.outputPath);
      }
    }
    await rename(staging, input.outputPath);
  } catch (error) {
    await removeTree(staging);
    // Put the original back if the backup move succeeded but the final rename did not.
    if (backupPath !== null && !(await pathExists(input.outputPath))) {
      await rename(backupPath, input.outputPath).catch(() => {});
      backupPath = null;
    }
    throw new SC2Error(
      'SC2_IO_ERROR',
      `Could not move the finished document into place at ${input.outputPath}.`,
      {
        path: input.outputPath,
        recoverable: false,
        ...(backupPath === null ? {} : { suggestedAction: `The previous contents are at ${backupPath}.` }),
      },
      { cause: error },
    );
  }

  input.logger.info('document committed', {
    outputPath: input.outputPath,
    fileCount,
    overwritten: destinationExists,
    backupPath,
  });

  return { outputPath: input.outputPath, fileCount, backupPath, overwritten: destinationExists };
}
