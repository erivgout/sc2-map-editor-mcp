/**
 * The change/transaction engine (PLAN.md §13).
 *
 * Every mutating tool goes through here, so the safety properties are proved once:
 *
 * - **A snapshot is taken before the first write.** Revert is always possible.
 * - **Writes are all-or-nothing.** If any file fails, every file already written is
 *   restored. A failed multi-file mutation must not leave half a change behind.
 * - **`dry_run` computes the same diff without touching `working/`.** The preview a caller
 *   approves is produced by the identical code path as the real thing.
 * - **The revision increments once per applied transaction**, and `expected_revision`
 *   lets a caller refuse to act on a stale view (PLAN.md §49).
 *
 * The engine deals only in file contents. What to write is the caller's business; keeping
 * the document consistent when it goes wrong is this file's.
 */

import { randomUUID } from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { SC2Error } from '../errors.js';
import {
  copyDirectory,
  ensureDir,
  hashBuffer,
  isRegularFile,
  pathExists,
  removeTree,
  walkFiles,
  writeFileAtomic,
  writeJsonAtomic,
  type WalkOptions,
} from '../fs/index.js';
import type { Logger } from '../logging.js';
import { resolveArchiveMemberPath } from '../paths.js';
import type { WorkspaceStore } from '../workspace/store.js';
import type { WorkspaceState } from '../workspace/types.js';
import { diffText, formatUnifiedDiff } from './diff.js';
import {
  ChangeRecordSchema,
  type ChangeDiagnostic,
  type ChangeRecord,
  type ChangeResult,
  type ChangedFile,
} from './types.js';

/** A single file operation staged inside a transaction. */
export type FileOperation =
  | { readonly kind: 'write'; readonly path: string; readonly content: string }
  | { readonly kind: 'delete'; readonly path: string };

export interface TransactionOptions {
  readonly store: WorkspaceStore;
  readonly logger: Logger;
  readonly walkLimits: WalkOptions;
}

export interface RunTransactionInput {
  readonly workspaceId: string;
  /** Tool name or similar, recorded on the change. */
  readonly operation: string;
  readonly expectedRevision?: number | undefined;
  readonly dryRun?: boolean | undefined;
  /** One line per logical operation, for the human-readable summary. */
  readonly summary: readonly string[];
  readonly diagnostics?: readonly ChangeDiagnostic[] | undefined;
  readonly files: readonly FileOperation[];
  /** Omit diff bodies (counts are still reported). For very large changes. */
  readonly suppressDiffs?: boolean | undefined;
}

function newChangeId(): string {
  return `chg_${randomUUID().replace(/-/g, '')}`;
}

function newSnapshotId(): string {
  return `snap_${randomUUID().replace(/-/g, '')}`;
}

export class TransactionEngine {
  readonly #store: WorkspaceStore;
  readonly #logger: Logger;
  readonly #walkLimits: WalkOptions;

  constructor(options: TransactionOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
    this.#walkLimits = options.walkLimits;
  }

  /**
   * Copies the whole staged tree into `snapshots/<id>/`.
   *
   * A full copy, not a delta: SC2 documents are small enough that correctness is worth
   * more than the disk, and a delta scheme that is wrong loses the user's work.
   */
  async createSnapshot(workspaceId: string, label?: string): Promise<{ snapshotId: string; fileCount: number; path: string }> {
    const layout = this.#store.layoutFor(workspaceId);
    const snapshotId = newSnapshotId();
    const snapshotPath = path.join(layout.snapshotsPath, snapshotId);

    await ensureDir(snapshotPath);
    const fileCount = await copyDirectory(layout.workingPath, path.join(snapshotPath, 'working'), this.#walkLimits);
    await writeJsonAtomic(path.join(snapshotPath, 'snapshot.json'), {
      snapshotId,
      workspaceId,
      label: label ?? null,
      createdAt: new Date().toISOString(),
      fileCount,
    });

    this.#logger.debug('snapshot created', { workspaceId, snapshotId, fileCount });
    return { snapshotId, fileCount, path: snapshotPath };
  }

  /** Replaces `working/` with a snapshot's contents. */
  async restoreSnapshot(workspaceId: string, snapshotId: string): Promise<{ fileCount: number }> {
    const layout = this.#store.layoutFor(workspaceId);
    const snapshotWorking = path.join(layout.snapshotsPath, snapshotId, 'working');

    if (!(await pathExists(snapshotWorking))) {
      throw new SC2Error('SC2_NOT_FOUND', `No such snapshot: ${snapshotId}`, {
        workspaceId,
        recoverable: true,
        suggestedAction: 'Use sc2_get_changes to list snapshots taken before each change.',
      });
    }

    // Swap in via a staging directory and a rename, so an interrupted restore leaves
    // either the old tree or the new one, never a half-copied mixture.
    const incoming = path.join(layout.root, `.restore-${Date.now()}`);
    await removeTree(incoming);
    const fileCount = await copyDirectory(snapshotWorking, incoming, this.#walkLimits);

    const outgoing = path.join(layout.root, `.previous-${Date.now()}`);
    await rename(layout.workingPath, outgoing);
    try {
      await rename(incoming, layout.workingPath);
    } catch (error) {
      await rename(outgoing, layout.workingPath).catch(() => {});
      await removeTree(incoming);
      throw new SC2Error(
        'SC2_IO_ERROR',
        `Could not restore snapshot ${snapshotId}; the workspace was left unchanged.`,
        { workspaceId, recoverable: false },
        { cause: error },
      );
    }
    await removeTree(outgoing);

    this.#logger.info('snapshot restored', { workspaceId, snapshotId, fileCount });
    return { fileCount };
  }

  async listSnapshots(workspaceId: string): Promise<{ snapshotId: string; createdAt: string; label: string | null; fileCount: number }[]> {
    const layout = this.#store.layoutFor(workspaceId);
    const { readdirSafe } = await import('../fs/index.js');
    const entries = await readdirSafe(layout.snapshotsPath);

    const snapshots: { snapshotId: string; createdAt: string; label: string | null; fileCount: number }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = await readFile(path.join(layout.snapshotsPath, entry.name, 'snapshot.json'), 'utf8');
        const parsed = JSON.parse(raw) as { snapshotId?: string; createdAt?: string; label?: string | null; fileCount?: number };
        snapshots.push({
          snapshotId: parsed.snapshotId ?? entry.name,
          createdAt: parsed.createdAt ?? '',
          label: parsed.label ?? null,
          fileCount: parsed.fileCount ?? 0,
        });
      } catch {
        // A snapshot whose metadata is unreadable is still restorable by id; skip it here.
      }
    }
    snapshots.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return snapshots;
  }

  async listChanges(workspaceId: string): Promise<ChangeRecord[]> {
    const layout = this.#store.layoutFor(workspaceId);
    const { readdirSafe } = await import('../fs/index.js');
    const entries = await readdirSafe(layout.changesPath);

    const records: ChangeRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const raw = await readFile(path.join(layout.changesPath, entry.name), 'utf8');
        const parsed = ChangeRecordSchema.safeParse(JSON.parse(raw));
        if (parsed.success) records.push(parsed.data);
      } catch {
        // Ignore unreadable records rather than failing the whole history listing.
      }
    }
    records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return records;
  }

  async getChange(workspaceId: string, changeId: string): Promise<ChangeRecord> {
    const record = (await this.listChanges(workspaceId)).find((candidate) => candidate.changeId === changeId);
    if (record === undefined) {
      throw new SC2Error('SC2_NOT_FOUND', `No such change: ${changeId}`, {
        workspaceId,
        recoverable: true,
        suggestedAction: 'Use sc2_get_changes to list the change history.',
      });
    }
    return record;
  }

  /**
   * Runs one transaction.
   *
   * Holds the per-workspace lock for its whole duration, so two overlapping mutations
   * serialise rather than interleaving (PLAN.md §49).
   */
  async run(input: RunTransactionInput): Promise<ChangeResult> {
    return this.#store.withLock(input.workspaceId, () => this.#runLocked(input));
  }

  async #runLocked(input: RunTransactionInput): Promise<ChangeResult> {
    const state = await this.#store.read(input.workspaceId);
    const layout = this.#store.layoutFor(input.workspaceId);
    const dryRun = input.dryRun ?? true;

    this.#assertWritable(state, input.expectedRevision);

    // Resolve and read current contents first. Everything below works on this snapshot of
    // reality, so the diff a caller approves matches what is actually written.
    const planned = await this.#planFiles(layout.workingPath, input.files, input.suppressDiffs ?? false);

    if (planned.changed.length === 0) {
      // A no-op must not burn a revision or leave a snapshot behind.
      return {
        changeId: newChangeId(),
        revisionBefore: state.revision,
        revisionAfter: state.revision,
        dryRun,
        filesChanged: [],
        summary: [...input.summary, 'No files changed; the requested edit matches what is already there.'],
        diagnostics: [...(input.diagnostics ?? [])],
        requiresRepack: state.dirty,
        snapshotId: null,
      };
    }

    const changeId = newChangeId();

    if (dryRun) {
      return {
        changeId,
        revisionBefore: state.revision,
        revisionAfter: state.revision,
        dryRun: true,
        filesChanged: planned.changed,
        summary: [...input.summary],
        diagnostics: [...(input.diagnostics ?? [])],
        requiresRepack: state.dirty,
        snapshotId: null,
      };
    }

    const snapshot = await this.createSnapshot(input.workspaceId, `before ${input.operation}`);

    // Track what we actually wrote, so a mid-way failure can be undone precisely rather
    // than by restoring the whole snapshot (which would also undo nothing-at-all cases).
    const written: { absolutePath: string; previous: Buffer | null }[] = [];

    try {
      for (const operation of planned.operations) {
        const previous = operation.existedBefore ? await readFile(operation.absolutePath) : null;

        if (operation.kind === 'delete') {
          await rm(operation.absolutePath, { force: true });
        } else {
          await writeFileAtomic(operation.absolutePath, operation.content);
        }
        written.push({ absolutePath: operation.absolutePath, previous });
      }
    } catch (error) {
      // Roll back in reverse order, restoring each file's exact prior bytes.
      for (const entry of [...written].reverse()) {
        try {
          if (entry.previous === null) await rm(entry.absolutePath, { force: true });
          else await writeFileAtomic(entry.absolutePath, entry.previous);
        } catch {
          // If even the rollback fails the snapshot is the backstop; report it below.
        }
      }

      this.#logger.error('transaction rolled back', {
        workspaceId: input.workspaceId,
        changeId,
        operation: input.operation,
        snapshotId: snapshot.snapshotId,
      });

      throw new SC2Error(
        'SC2_IO_ERROR',
        `The change could not be applied and was rolled back. No partial edits remain.`,
        {
          workspaceId: input.workspaceId,
          recoverable: false,
          suggestedAction: `If anything looks wrong, restore snapshot ${snapshot.snapshotId}.`,
          context: { changeId, snapshotId: snapshot.snapshotId },
        },
        { cause: error },
      );
    }

    const revisionAfter = state.revision + 1;
    await this.#store.write({ ...state, revision: revisionAfter, dirty: true, lastAccessedAt: new Date().toISOString() });

    const record: ChangeRecord = {
      recordVersion: 1,
      changeId,
      workspaceId: input.workspaceId,
      operation: input.operation,
      createdAt: new Date().toISOString(),
      revisionBefore: state.revision,
      revisionAfter,
      snapshotId: snapshot.snapshotId,
      reverted: false,
      files: planned.changed.map((file) => ({
        path: file.path,
        beforeHash: file.beforeHash,
        afterHash: file.afterHash,
        addedLines: file.addedLines,
        removedLines: file.removedLines,
      })),
      summary: [...input.summary],
    };
    await writeJsonAtomic(path.join(layout.changesPath, `${changeId}.json`), record);

    this.#logger.info('change applied', {
      workspaceId: input.workspaceId,
      changeId,
      operation: input.operation,
      fileCount: planned.changed.length,
      revisionAfter,
    });

    return {
      changeId,
      revisionBefore: state.revision,
      revisionAfter,
      dryRun: false,
      filesChanged: planned.changed,
      summary: [...input.summary],
      diagnostics: [...(input.diagnostics ?? [])],
      requiresRepack: true,
      snapshotId: snapshot.snapshotId,
    };
  }

  /**
   * Reverts a change by restoring the snapshot taken before it.
   *
   * Only the most recent non-reverted change can be reverted. Restoring an older
   * snapshot would silently discard every change made after it; presenting that as
   * "revert this one change" would be a lie. Undoing several means reverting in order.
   */
  async revertChange(workspaceId: string, changeId: string): Promise<{ record: ChangeRecord; revisionAfter: number; fileCount: number }> {
    return this.#store.withLock(workspaceId, async () => {
      const state = await this.#store.read(workspaceId);
      if (state.readOnly) {
        throw new SC2Error('SC2_UNSUPPORTED_OPERATION', 'This workspace was opened read-only.', {
          workspaceId,
          recoverable: false,
        });
      }

      const records = await this.listChanges(workspaceId);
      const record = records.find((candidate) => candidate.changeId === changeId);
      if (record === undefined) {
        throw new SC2Error('SC2_NOT_FOUND', `No such change: ${changeId}`, { workspaceId, recoverable: true });
      }
      if (record.reverted) {
        throw new SC2Error('SC2_CONFLICT', `Change ${changeId} has already been reverted.`, { workspaceId, recoverable: false });
      }
      if (record.snapshotId === null) {
        throw new SC2Error('SC2_UNSUPPORTED_OPERATION', `Change ${changeId} has no snapshot and cannot be reverted.`, {
          workspaceId,
          recoverable: false,
        });
      }

      const latest = [...records].reverse().find((candidate) => !candidate.reverted);
      if (latest?.changeId !== undefined && latest.changeId !== changeId) {
        throw new SC2Error(
          'SC2_CONFLICT',
          `Change ${changeId} is not the most recent change; ${latest.changeId} came after it.`,
          {
            workspaceId,
            recoverable: true,
            suggestedAction: `Revert ${latest.changeId} first, or use sc2_restore_snapshot to jump straight back to snapshot ${record.snapshotId} — which discards everything after it.`,
          },
        );
      }

      const { fileCount } = await this.restoreSnapshot(workspaceId, record.snapshotId);

      // The revision moves forward, never back: a revert is itself a change, and reusing
      // the old number would make two different document states share one revision.
      const revisionAfter = state.revision + 1;
      await this.#store.write({ ...state, revision: revisionAfter, lastAccessedAt: new Date().toISOString() });

      const layout = this.#store.layoutFor(workspaceId);
      await writeJsonAtomic(path.join(layout.changesPath, `${changeId}.json`), { ...record, reverted: true });

      this.#logger.info('change reverted', { workspaceId, changeId, revisionAfter });
      return { record: { ...record, reverted: true }, revisionAfter, fileCount };
    });
  }

  /** Diffs the staged tree against a snapshot, or against the state before a change. */
  async diffAgainstSnapshot(workspaceId: string, snapshotId: string): Promise<ChangedFile[]> {
    const layout = this.#store.layoutFor(workspaceId);
    const snapshotWorking = path.join(layout.snapshotsPath, snapshotId, 'working');

    if (!(await pathExists(snapshotWorking))) {
      throw new SC2Error('SC2_NOT_FOUND', `No such snapshot: ${snapshotId}`, { workspaceId, recoverable: true });
    }

    const [current, previous] = await Promise.all([
      walkFiles(layout.workingPath, this.#walkLimits),
      walkFiles(snapshotWorking, this.#walkLimits),
    ]);

    const currentMap = new Map(current.map((file) => [file.relativePath, file.absolutePath]));
    const previousMap = new Map(previous.map((file) => [file.relativePath, file.absolutePath]));
    const allPaths = [...new Set([...currentMap.keys(), ...previousMap.keys()])].sort();

    const changed: ChangedFile[] = [];
    for (const relativePath of allPaths) {
      const beforePath = previousMap.get(relativePath);
      const afterPath = currentMap.get(relativePath);

      const beforeBuffer = beforePath === undefined ? null : await readFile(beforePath);
      const afterBuffer = afterPath === undefined ? null : await readFile(afterPath);

      if (beforeBuffer !== null && afterBuffer !== null && beforeBuffer.equals(afterBuffer)) continue;

      const diff = diffText(
        relativePath,
        beforeBuffer?.toString('utf8') ?? '',
        afterBuffer?.toString('utf8') ?? '',
      );

      changed.push({
        path: relativePath,
        beforeHash: beforeBuffer === null ? null : hashBuffer(beforeBuffer),
        afterHash: afterBuffer === null ? null : hashBuffer(afterBuffer),
        addedLines: diff.addedLines,
        removedLines: diff.removedLines,
        diff: formatUnifiedDiff(diff) || null,
      });
    }

    return changed;
  }

  #assertWritable(state: WorkspaceState, expectedRevision: number | undefined): void {
    if (state.readOnly) {
      throw new SC2Error('SC2_UNSUPPORTED_OPERATION', 'This workspace was opened read-only; mutating tools refuse on it.', {
        workspaceId: state.id,
        recoverable: false,
        suggestedAction: 'Reopen the document with read_only omitted or false.',
      });
    }

    if (expectedRevision !== undefined && expectedRevision !== state.revision) {
      throw new SC2Error(
        'SC2_CONFLICT',
        `Workspace is at revision ${state.revision}, but the caller expected ${expectedRevision}.`,
        {
          workspaceId: state.id,
          recoverable: true,
          suggestedAction: 'Re-read the workspace state and reapply your edit against the current revision.',
          context: { actualRevision: state.revision, expectedRevision },
        },
      );
    }
  }

  /**
   * Resolves paths, reads current contents, and computes the diff for each operation.
   *
   * Operations that would not change anything are dropped here, so a caller asking to set
   * a value to what it already is gets an honest "nothing changed" rather than a revision
   * bump and an empty diff.
   */
  async #planFiles(
    workingPath: string,
    files: readonly FileOperation[],
    suppressDiffs: boolean,
  ): Promise<{
    changed: ChangedFile[];
    operations: { kind: 'write' | 'delete'; absolutePath: string; content: string; existedBefore: boolean }[];
  }> {
    const changed: ChangedFile[] = [];
    const operations: { kind: 'write' | 'delete'; absolutePath: string; content: string; existedBefore: boolean }[] = [];
    const seen = new Set<string>();

    for (const file of files) {
      if (seen.has(file.path.toLowerCase())) {
        throw new SC2Error('SC2_CONFLICT', `The same file appears twice in one transaction: ${file.path}`, {
          path: file.path,
          recoverable: false,
        });
      }
      seen.add(file.path.toLowerCase());

      // Guarded exactly as extraction is: a crafted path must not escape the workspace.
      const absolutePath = resolveArchiveMemberPath(workingPath, file.path);
      const existedBefore = await pathExists(absolutePath);

      if (existedBefore && !(await isRegularFile(absolutePath))) {
        // A directory (or device) where a file is expected. Caught here so it surfaces as
        // a domain error rather than an EISDIR from deep inside the write.
        throw new SC2Error('SC2_INVALID_ARGUMENT', `Cannot write to ${file.path}: it exists but is not a regular file.`, {
          path: file.path,
          recoverable: false,
        });
      }

      const beforeBuffer = existedBefore ? await readFile(absolutePath) : null;

      if (file.kind === 'delete') {
        // Deleting what is not there is a no-op, not an error.
        if (!existedBefore || beforeBuffer === null) continue;

        const diff = diffText(file.path, beforeBuffer.toString('utf8'), '');
        changed.push({
          path: file.path,
          beforeHash: hashBuffer(beforeBuffer),
          afterHash: null,
          addedLines: 0,
          removedLines: diff.removedLines,
          diff: suppressDiffs ? null : formatUnifiedDiff(diff) || null,
        });
        operations.push({ kind: 'delete', absolutePath, content: '', existedBefore });
        continue;
      }

      const afterBuffer = Buffer.from(file.content, 'utf8');
      // Writing identical bytes is not a change; dropping it here is what makes a
      // "set this to what it already is" call report honestly instead of bumping a revision.
      if (beforeBuffer?.equals(afterBuffer) === true) continue;

      const diff = diffText(file.path, beforeBuffer?.toString('utf8') ?? '', file.content);
      changed.push({
        path: file.path,
        beforeHash: beforeBuffer === null ? null : hashBuffer(beforeBuffer),
        afterHash: hashBuffer(afterBuffer),
        addedLines: diff.addedLines,
        removedLines: diff.removedLines,
        diff: suppressDiffs ? null : formatUnifiedDiff(diff) || null,
      });
      operations.push({ kind: 'write', absolutePath, content: file.content, existedBefore });
    }

    return { changed, operations };
  }
}
