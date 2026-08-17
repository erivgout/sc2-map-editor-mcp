/**
 * Change history, diffing, and snapshot tools (PLAN.md §13, §42 Phase 7).
 *
 * These are what make mutation reviewable. Every mutating tool records a change with the
 * snapshot taken before it; these tools let a caller see what happened, undo it, or pin a
 * known-good state to come back to.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { SC2Error } from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

const WorkspaceIdSchema = z.string().min(1).describe('Workspace id returned by sc2_open_document.');

/** Cap on diff text returned in one call, so a huge change cannot flood the context. */
const MAX_DIFF_CHARS = 200_000;

const ChangedFileSchema = z.object({
  path: z.string(),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  addedLines: z.number().int(),
  removedLines: z.number().int(),
  diff: z.string().nullable(),
});

/** Trims diff bodies once the total exceeds the budget, and says how many were dropped. */
function budgetDiffs<T extends { diff: string | null; path: string }>(files: T[]): { files: T[]; omitted: number } {
  let used = 0;
  let omitted = 0;

  const budgeted = files.map((file) => {
    if (file.diff === null) return file;
    if (used + file.diff.length <= MAX_DIFF_CHARS) {
      used += file.diff.length;
      return file;
    }
    omitted += 1;
    return { ...file, diff: null };
  });

  return { files: budgeted, omitted };
}

export function registerChangeTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger } = context;
  const transactions = workspaces.transactions;

  server.registerTool(
    'sc2_diff_workspace',
    {
      title: 'Diff the staged document',
      description:
        'Shows what has changed in the staging copy, as a unified diff. By default the comparison is against the original source document; pass a snapshot_id to compare against a snapshot instead. Diffing against a packed source is not possible in this build — take a snapshot before editing and compare against that.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        snapshot_id: z
          .string()
          .optional()
          .describe('Compare against this snapshot rather than the original source.'),
        include_diffs: z.boolean().optional().describe('Include diff text. Defaults to true; false returns counts only.'),
      }),
      outputSchema: z.object({
        comparedAgainst: z.string(),
        filesChanged: z.array(ChangedFileSchema),
        totalAdded: z.number().int(),
        totalRemoved: z.number().int(),
        diffsOmitted: z.number().int(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_diff_workspace', logger }, async (args) => {
      const changed =
        args.snapshot_id === undefined
          ? await workspaces.diffAgainstSource(args.workspace_id)
          : await transactions.diffAgainstSnapshot(args.workspace_id, args.snapshot_id);

      const stripped = args.include_diffs === false ? changed.map((file) => ({ ...file, diff: null })) : changed;
      const { files, omitted } = budgetDiffs([...stripped]);

      const totalAdded = files.reduce((total, file) => total + file.addedLines, 0);
      const totalRemoved = files.reduce((total, file) => total + file.removedLines, 0);
      const comparedAgainst =
        args.snapshot_id === undefined ? 'the original source document' : `snapshot ${args.snapshot_id}`;

      const lines = [
        files.length === 0
          ? `No differences from ${comparedAgainst}.`
          : `${files.length} file(s) differ from ${comparedAgainst}: +${totalAdded} / -${totalRemoved} lines.`,
        // A null diff means the body was suppressed or budgeted out; show the counts.
        ...files.map((file) => file.diff ?? `--- ${file.path} (+${file.addedLines}/-${file.removedLines})`),
        omitted > 0 ? `${omitted} diff(s) omitted to stay within the response budget; request them per-file.` : '',
      ].filter((line) => line !== '');

      return ok(lines.join('\n\n'), {
        comparedAgainst,
        filesChanged: files,
        totalAdded,
        totalRemoved,
        diffsOmitted: omitted,
      });
    }),
  );

  server.registerTool(
    'sc2_get_changes',
    {
      title: 'List the change history',
      description:
        'Lists every change applied to this workspace, oldest first, with the files each touched and the snapshot taken before it. Reverted changes are still listed and flagged, so the history is a record of what happened rather than of what currently holds.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        change_id: z.string().optional().describe('Return just this change, with full detail.'),
      }),
      outputSchema: z.object({
        changes: z.array(
          z.object({
            changeId: z.string(),
            operation: z.string(),
            createdAt: z.string(),
            revisionBefore: z.number().int(),
            revisionAfter: z.number().int(),
            snapshotId: z.string().nullable(),
            reverted: z.boolean(),
            summary: z.array(z.string()),
            files: z.array(
              z.object({
                path: z.string(),
                beforeHash: z.string().nullable(),
                afterHash: z.string().nullable(),
                addedLines: z.number().int(),
                removedLines: z.number().int(),
              }),
            ),
          }),
        ),
        currentRevision: z.number().int(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_changes', logger }, async (args) => {
      const descriptor = await workspaces.getDescriptor(args.workspace_id);
      const changes =
        args.change_id === undefined
          ? await transactions.listChanges(args.workspace_id)
          : [await transactions.getChange(args.workspace_id, args.change_id)];

      const lines = [
        `Workspace is at revision ${descriptor.revision}${descriptor.dirty ? ' (dirty)' : ''}.`,
        ...(changes.length === 0
          ? ['No changes have been applied.']
          : changes.map(
              (change) =>
                `${change.changeId} — ${change.operation} — rev ${change.revisionBefore} -> ${change.revisionAfter} — ${change.files.length} file(s)${change.reverted ? ' [REVERTED]' : ''}\n  ${change.summary.join('\n  ')}`,
            )),
      ];

      return ok(lines.join('\n'), { changes, currentRevision: descriptor.revision });
    }),
  );

  server.registerTool(
    'sc2_revert_change',
    {
      title: 'Revert a change',
      description:
        'Undoes a change by restoring the snapshot taken before it. Only the most recent non-reverted change can be reverted — restoring an older snapshot would silently discard everything applied after it, so undoing several means reverting them in order. The revision moves forward, because a revert is itself a change.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        change_id: z.string().min(1),
      }),
      outputSchema: z.object({
        changeId: z.string(),
        revisionAfter: z.number().int(),
        filesRestored: z.number().int(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_revert_change', logger }, async (args) => {
      const result = await transactions.revertChange(args.workspace_id, args.change_id);
      return ok(
        `Reverted ${args.change_id} (${result.record.operation}). The workspace is now at revision ${result.revisionAfter}, with ${result.fileCount} file(s) restored.`,
        { changeId: args.change_id, revisionAfter: result.revisionAfter, filesRestored: result.fileCount },
      );
    }),
  );

  server.registerTool(
    'sc2_create_snapshot',
    {
      title: 'Snapshot the staged document',
      description:
        'Takes a full copy of the staging tree that can be restored later. Mutating tools snapshot automatically before every change, so this is for pinning a known-good state you want to come back to across several changes.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        label: z.string().optional().describe('A note to identify this snapshot later.'),
      }),
      outputSchema: z.object({ snapshotId: z.string(), fileCount: z.number().int() }),
      // Writes server-owned files, so not read-only — but it cannot lose anything.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_create_snapshot', logger }, async (args) => {
      const descriptor = await workspaces.getDescriptor(args.workspace_id);
      if (descriptor.readOnly) {
        // Snapshotting a read-only workspace is harmless, but it signals an intent to
        // edit that will fail later; saying so now is more useful than at write time.
        throw new SC2Error('SC2_UNSUPPORTED_OPERATION', 'This workspace was opened read-only, so there is nothing to snapshot for.', {
          workspaceId: args.workspace_id,
          recoverable: false,
          suggestedAction: 'Reopen the document without read_only if you intend to edit it.',
        });
      }

      const snapshot = await transactions.createSnapshot(args.workspace_id, args.label);
      return ok(`Created snapshot ${snapshot.snapshotId} with ${snapshot.fileCount} file(s).`, {
        snapshotId: snapshot.snapshotId,
        fileCount: snapshot.fileCount,
      });
    }),
  );

  server.registerTool(
    'sc2_restore_snapshot',
    {
      title: 'Restore a snapshot',
      description:
        'Replaces the staging tree with a snapshot\'s contents. This discards EVERY change made after that snapshot, not just the most recent one — use sc2_revert_change if you only mean to undo the last change. The original source document is never touched.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        snapshot_id: z.string().min(1),
      }),
      outputSchema: z.object({ snapshotId: z.string(), filesRestored: z.number().int(), revisionAfter: z.number().int() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_restore_snapshot', logger }, async (args) => {
      const state = await workspaces.getState(args.workspace_id);
      if (state.readOnly) {
        throw new SC2Error('SC2_UNSUPPORTED_OPERATION', 'This workspace was opened read-only.', {
          workspaceId: args.workspace_id,
          recoverable: false,
        });
      }

      const result = await transactions.restoreSnapshot(args.workspace_id, args.snapshot_id);

      // The revision moves forward: the document state changed, and reusing an earlier
      // number would let a stale caller's expected_revision check pass wrongly.
      const revisionAfter = state.revision + 1;
      await workspaces.store.write({ ...state, revision: revisionAfter, lastAccessedAt: new Date().toISOString() });

      return ok(
        `Restored snapshot ${args.snapshot_id}: ${result.fileCount} file(s). The workspace is now at revision ${revisionAfter}. Any changes made after that snapshot are gone.`,
        { snapshotId: args.snapshot_id, filesRestored: result.fileCount, revisionAfter },
      );
    }),
  );

  server.registerTool(
    'sc2_list_snapshots',
    {
      title: 'List snapshots',
      description:
        'Lists snapshots held for this workspace, oldest first. Includes the automatic snapshots taken before each change as well as any created explicitly.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema }),
      outputSchema: z.object({
        snapshots: z.array(
          z.object({
            snapshotId: z.string(),
            createdAt: z.string(),
            label: z.string().nullable(),
            fileCount: z.number().int(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_list_snapshots', logger }, async (args) => {
      const snapshots = await transactions.listSnapshots(args.workspace_id);
      const text =
        snapshots.length === 0
          ? 'No snapshots.'
          : snapshots
              .map((snapshot) => `${snapshot.snapshotId} — ${snapshot.createdAt} — ${snapshot.fileCount} file(s)${snapshot.label === null ? '' : ` — ${snapshot.label}`}`)
              .join('\n');
      return ok(text, { snapshots });
    }),
  );
}
