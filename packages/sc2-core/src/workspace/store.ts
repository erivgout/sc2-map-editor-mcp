/**
 * Durable workspace store (PLAN.md §8, §40, §49).
 *
 * Owns the on-disk layout under `workspaceRoot`, the `state.json` lifecycle, and the
 * per-workspace mutation lock. It knows nothing about SC2 formats — that belongs to
 * the services layered on top.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { SC2Error } from '../errors.js';
import { ensureDir, pathExists, readdirSafe, removeTree, writeJsonAtomic } from '../fs/index.js';
import {
  WORKSPACE_STATE_VERSION,
  WorkspaceStateSchema,
  type WorkspaceLayout,
  type WorkspaceState,
} from './types.js';

/** Workspace ids are opaque to callers, but must be safe as a directory name. */
const WORKSPACE_ID_PATTERN = /^ws_[0-9a-f]{32}$/;

export function generateWorkspaceId(): string {
  return `ws_${randomUUID().replace(/-/g, '')}`;
}

export function assertValidWorkspaceId(id: string): void {
  // The `typeof` guard is not redundant despite the annotation: ids arrive from a
  // model through JSON, and this value is about to become a directory name.
  if (typeof id !== 'string' || !WORKSPACE_ID_PATTERN.test(id)) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `Not a valid workspace id: ${typeof id === 'string' ? id : `[${typeof id}]`}`, {
      recoverable: true,
      suggestedAction: 'Use the workspace_id returned by sc2_open_document.',
    });
  }
}

export interface WorkspaceStoreOptions {
  /** Server state root, e.g. `%LOCALAPPDATA%/sc2-map-editor-mcp`. */
  readonly workspaceRoot: string;
  /** Recorded into new workspaces for migration diagnostics. */
  readonly serverVersion: string;
  /** Injectable clock, so tests need not sleep. */
  readonly now?: () => Date;
}

export class WorkspaceStore {
  readonly #root: string;
  readonly #serverVersion: string;
  readonly #now: () => Date;
  /**
   * Per-workspace mutation lock (PLAN.md §49). In-process only — it serialises
   * overlapping tool calls within one server, which is the concurrency model the plan
   * describes. It is deliberately NOT a cross-process file lock; two servers pointed
   * at one workspace root is not a supported configuration, and pretending otherwise
   * would be worse than saying so.
   */
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(options: WorkspaceStoreOptions) {
    this.#root = path.resolve(options.workspaceRoot);
    this.#serverVersion = options.serverVersion;
    this.#now = options.now ?? (() => new Date());
  }

  get root(): string {
    return this.#root;
  }

  get workspacesRoot(): string {
    return path.join(this.#root, 'workspaces');
  }

  layoutFor(id: string): WorkspaceLayout {
    assertValidWorkspaceId(id);
    const root = path.join(this.workspacesRoot, id);
    return {
      root,
      statePath: path.join(root, 'state.json'),
      workingPath: path.join(root, 'working'),
      snapshotsPath: path.join(root, 'snapshots'),
      changesPath: path.join(root, 'changes'),
      logsPath: path.join(root, 'logs'),
    };
  }

  /** Creates the directory skeleton and writes the initial `state.json`. */
  async create(input: {
    sourcePath: string;
    sourceKind: WorkspaceState['sourceKind'];
    documentKind: WorkspaceState['documentKind'];
    sourceHash: string;
    readOnly: boolean;
  }): Promise<{ state: WorkspaceState; layout: WorkspaceLayout }> {
    const id = generateWorkspaceId();
    const layout = this.layoutFor(id);
    const timestamp = this.#now().toISOString();

    await ensureDir(layout.root);
    await Promise.all([
      ensureDir(layout.workingPath),
      ensureDir(layout.snapshotsPath),
      ensureDir(layout.changesPath),
      ensureDir(layout.logsPath),
    ]);

    const state: WorkspaceState = {
      stateVersion: WORKSPACE_STATE_VERSION,
      id,
      sourcePath: input.sourcePath,
      sourceKind: input.sourceKind,
      documentKind: input.documentKind,
      sourceHash: input.sourceHash,
      revision: 0,
      dirty: false,
      readOnly: input.readOnly,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      createdByServerVersion: this.#serverVersion,
    };

    await writeJsonAtomic(layout.statePath, state);
    return { state, layout };
  }

  async read(id: string): Promise<WorkspaceState> {
    const layout = this.layoutFor(id);

    let raw: string;
    try {
      raw = await readFile(layout.statePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SC2Error('SC2_WORKSPACE_NOT_FOUND', `No such workspace: ${id}`, {
          workspaceId: id,
          recoverable: true,
          suggestedAction: 'Call sc2_open_document to create a workspace.',
        });
      }
      throw new SC2Error(
        'SC2_IO_ERROR',
        `Cannot read workspace state: ${layout.statePath}`,
        { workspaceId: id, path: layout.statePath, recoverable: false },
        { cause: error },
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new SC2Error(
        'SC2_PARSE_ERROR',
        `Workspace state is not valid JSON: ${layout.statePath}`,
        { workspaceId: id, path: layout.statePath, recoverable: false },
        { cause: error },
      );
    }

    // Version-check before schema-validating, so an old workspace gets a migration
    // message rather than a confusing pile of field-level errors (PLAN.md §40).
    const storedVersion = (parsedJson as { stateVersion?: unknown }).stateVersion;
    if (storedVersion !== WORKSPACE_STATE_VERSION) {
      throw new SC2Error(
        'SC2_UNSUPPORTED_OPERATION',
        `Workspace ${id} uses state version ${String(storedVersion)}, but this server speaks version ${WORKSPACE_STATE_VERSION}.`,
        {
          workspaceId: id,
          path: layout.statePath,
          recoverable: false,
          suggestedAction: 'Discard this workspace and reopen the document with the current server.',
        },
      );
    }

    const parsed = WorkspaceStateSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new SC2Error('SC2_PARSE_ERROR', `Workspace state is malformed: ${layout.statePath}`, {
        workspaceId: id,
        path: layout.statePath,
        recoverable: false,
        context: { issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`) },
      });
    }

    return parsed.data;
  }

  async write(state: WorkspaceState): Promise<void> {
    const layout = this.layoutFor(state.id);
    await writeJsonAtomic(layout.statePath, state);
  }

  /** Stamps `lastAccessedAt` and persists. Cheap enough to call on every read tool. */
  async touch(state: WorkspaceState): Promise<WorkspaceState> {
    const next: WorkspaceState = { ...state, lastAccessedAt: this.#now().toISOString() };
    await this.write(next);
    return next;
  }

  async list(): Promise<WorkspaceState[]> {
    const entries = await readdirSafe(this.workspacesRoot);
    const states: WorkspaceState[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !WORKSPACE_ID_PATTERN.test(entry.name)) continue;
      try {
        states.push(await this.read(entry.name));
      } catch {
        // A corrupt or version-mismatched workspace must not make listing fail; it is
        // simply not listed. `sc2_discard_workspace` can still remove it by id.
      }
    }
    states.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return states;
  }

  async exists(id: string): Promise<boolean> {
    return pathExists(this.layoutFor(id).statePath);
  }

  /** Deletes the entire workspace directory. Never touches the original source. */
  async discard(id: string): Promise<void> {
    const layout = this.layoutFor(id);
    await removeTree(layout.root);
  }

  /**
   * Runs `fn` with exclusive access to one workspace.
   *
   * Calls queue behind each other rather than failing fast, so two overlapping
   * mutations serialise. Stale-revision detection (`SC2_CONFLICT`) is a separate
   * concern handled inside the transaction, not by this lock.
   *
   * The chain entry per id is never deleted; the map is bounded by the number of
   * distinct workspaces this process has locked, not by call count.
   */
  async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    assertValidWorkspaceId(id);
    const previous = this.#locks.get(id) ?? Promise.resolve();

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // The tail of the chain is `held`, which only resolves once we are done — so the
    // next caller waits for us. `previous` is swallowed first: one failed mutation
    // must not poison every later one queued on the same workspace.
    this.#locks.set(
      id,
      previous.then(
        () => held,
        () => held,
      ),
    );

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
