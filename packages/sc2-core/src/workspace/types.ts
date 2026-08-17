/**
 * Workspace model (PLAN.md §8, §9, §40).
 *
 * A workspace is a server-owned staging copy of one SC2 document. It is durable on
 * disk and keyed by an opaque id, because MCP's stateless request model means we
 * cannot hang document state off a connection: a client may reconnect between two
 * tool calls and must still be able to name the same working copy.
 */

import { z } from 'zod';

/**
 * On-disk schema version for `state.json`.
 *
 * Bump when the persisted shape changes incompatibly. PLAN.md §40: an unreadable
 * workspace must fail with a migration message, never be silently reinterpreted.
 */
export const WORKSPACE_STATE_VERSION = 1;

export const DocumentKindSchema = z.enum(['map', 'mod', 'campaign', 'unknown']);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

export const SourceKindSchema = z.enum(['directory', 'mpq']);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const WorkspaceStateSchema = z
  .object({
    stateVersion: z.literal(WORKSPACE_STATE_VERSION),
    id: z.string().min(1),
    /** Canonical host path the document was opened from. */
    sourcePath: z.string().min(1),
    sourceKind: SourceKindSchema,
    documentKind: DocumentKindSchema,
    /**
     * Content hash pinning the source at open time.
     *
     * For an MPQ this is the archive file's hash. For a directory it is a manifest
     * hash over `(relativePath, size, hash)` of every file, since a directory has no
     * single byte stream to hash. Commit compares this to detect that the user
     * edited the source behind our back (PLAN.md §9).
     */
    sourceHash: z.string().min(1),
    /** Increments once per successful mutation. Drives optimistic concurrency. */
    revision: z.number().int().nonnegative(),
    /** True once `working/` diverges from the source. */
    dirty: z.boolean(),
    /** Opened with `readOnly: true`; every mutating tool refuses. */
    readOnly: z.boolean(),
    createdAt: z.string().min(1),
    lastAccessedAt: z.string().min(1),
    /** Server version that created this workspace, for migration diagnostics. */
    createdByServerVersion: z.string().min(1),
  })
  .strict();

export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

/** The public, model-visible view of a workspace (PLAN.md §8). */
export interface SC2WorkspaceDescriptor {
  readonly id: string;
  readonly sourcePath: string;
  readonly sourceKind: SourceKind;
  readonly documentKind: DocumentKind;
  /** Absolute path of the `working/` tree. Surfaced so the user can open it themselves. */
  readonly stagingPath: string;
  readonly sourceHash: string;
  readonly revision: number;
  readonly dirty: boolean;
  readonly readOnly: boolean;
  readonly createdAt: string;
  readonly lastAccessedAt: string;
}

/** Absolute paths of a workspace's on-disk layout (PLAN.md §8). */
export interface WorkspaceLayout {
  readonly root: string;
  readonly statePath: string;
  /** The editable staging tree. All mutations land here and nowhere else. */
  readonly workingPath: string;
  /** Point-in-time copies taken before a transaction's first write. */
  readonly snapshotsPath: string;
  /** Change records: one per applied transaction. */
  readonly changesPath: string;
  readonly logsPath: string;
}

export function toDescriptor(state: WorkspaceState, layout: WorkspaceLayout): SC2WorkspaceDescriptor {
  return {
    id: state.id,
    sourcePath: state.sourcePath,
    sourceKind: state.sourceKind,
    documentKind: state.documentKind,
    stagingPath: layout.workingPath,
    sourceHash: state.sourceHash,
    revision: state.revision,
    dirty: state.dirty,
    readOnly: state.readOnly,
    createdAt: state.createdAt,
    lastAccessedAt: state.lastAccessedAt,
  };
}

/**
 * Infers document kind from a path's extension.
 *
 * Extension is a hint, not proof — an unpacked directory may be named anything. The
 * open flow refines this from the document's actual contents where it can, and
 * `unknown` is a legitimate answer we surface rather than guess past.
 */
export function documentKindFromPath(sourcePath: string): DocumentKind {
  const lower = sourcePath.toLowerCase();
  if (lower.endsWith('.sc2map')) return 'map';
  if (lower.endsWith('.sc2mod')) return 'mod';
  if (lower.endsWith('.sc2campaign')) return 'campaign';
  return 'unknown';
}
