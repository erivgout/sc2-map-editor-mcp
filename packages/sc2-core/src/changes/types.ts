/**
 * The shared shape of every mutation (PLAN.md §13).
 *
 * Every mutating tool takes the same arguments and returns the same result. That
 * uniformity is what lets a caller learn the safety model once — dry-run, revision check,
 * diff, revert — instead of relearning it per tool.
 */

import { z } from 'zod';

/** Arguments every mutating tool accepts, on top of its own. */
export const MutationArgsSchema = z.object({
  workspace_id: z.string().min(1),
  /**
   * Fail with `SC2_CONFLICT` unless the workspace is still at this revision.
   *
   * Optional, but the only protection against a stale caller overwriting a change it
   * never saw (PLAN.md §49).
   */
  expected_revision: z.number().int().nonnegative().optional(),
  /** Compute and return the diff without writing anything. */
  dry_run: z.boolean().optional(),
});

export type MutationArgs = z.infer<typeof MutationArgsSchema>;

export interface ChangedFile {
  /** Archive-style path inside the workspace. */
  readonly path: string;
  /** `null` when the file did not exist before. */
  readonly beforeHash: string | null;
  /** `null` when the file was deleted. */
  readonly afterHash: string | null;
  readonly addedLines: number;
  readonly removedLines: number;
  /** Unified diff, omitted for binary content or when suppressed. */
  readonly diff: string | null;
}

export interface ChangeDiagnostic {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

/** The result shape shared by every mutating tool (PLAN.md §13). */
export interface ChangeResult {
  readonly changeId: string;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly dryRun: boolean;
  readonly filesChanged: readonly ChangedFile[];
  /** Human-readable account of what happened, one line per logical operation. */
  readonly summary: readonly string[];
  readonly diagnostics: readonly ChangeDiagnostic[];
  /** True once the staged document differs from the source and needs a commit to persist. */
  readonly requiresRepack: boolean;
  /** Snapshot taken before the change, for `sc2_restore_snapshot`. `null` on a dry run. */
  readonly snapshotId: string | null;
}

/** A change record as persisted under `<workspace>/changes/`. */
export const ChangeRecordSchema = z
  .object({
    recordVersion: z.literal(1),
    changeId: z.string().min(1),
    workspaceId: z.string().min(1),
    /** What produced this change, e.g. the tool name. */
    operation: z.string().min(1),
    createdAt: z.string().min(1),
    revisionBefore: z.number().int().nonnegative(),
    revisionAfter: z.number().int().nonnegative(),
    snapshotId: z.string().min(1).nullable(),
    reverted: z.boolean(),
    files: z.array(
      z.object({
        path: z.string(),
        beforeHash: z.string().nullable(),
        afterHash: z.string().nullable(),
        addedLines: z.number().int().nonnegative(),
        removedLines: z.number().int().nonnegative(),
      }),
    ),
    summary: z.array(z.string()),
  })
  .strict();

export type ChangeRecord = z.infer<typeof ChangeRecordSchema>;
