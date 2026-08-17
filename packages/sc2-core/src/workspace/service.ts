/**
 * Workspace service (PLAN.md §9, §16.B).
 *
 * Enforces the staging model: opening a document never modifies the source. Both
 * directory and packed sources are copied/extracted into a server-owned `working/`
 * tree, and every mutation from here on targets that copy.
 */

import path from 'node:path';

import type { ServerConfig } from '../config.js';
import { SC2Error } from '../errors.js';
import { copyDirectory, walkFiles, type WalkOptions, type WalkedFile } from '../fs/index.js';
import type { Logger } from '../logging.js';
import { resolveArchiveMemberPath, type PathGuard } from '../paths.js';
import { inspectSource, type SourceInfo } from './source.js';
import { WorkspaceStore } from './store.js';
import { toDescriptor, type DocumentKind, type SC2WorkspaceDescriptor, type WorkspaceState } from './types.js';

/**
 * Extracts a packed SC2 document. Implemented by the `sc2mpq` sidecar adapter in
 * Phase 3; until that exists the service is constructed without one and refuses
 * packed sources rather than silently mis-handling them.
 */
export interface MpqExtractor {
  extract(archivePath: string, destination: string): Promise<{ fileCount: number }>;
}

export interface WorkspaceServiceOptions {
  readonly config: ServerConfig;
  readonly pathGuard: PathGuard;
  readonly store: WorkspaceStore;
  readonly logger: Logger;
  readonly mpqExtractor?: MpqExtractor | undefined;
}

export interface OpenDocumentInput {
  readonly sourcePath: string;
  readonly documentKind?: DocumentKind | undefined;
  /** When true, every mutating tool refuses on this workspace. */
  readonly readOnly?: boolean | undefined;
}

export interface OpenDocumentResult {
  readonly workspace: SC2WorkspaceDescriptor;
  readonly stagedFileCount: number;
  readonly stagedBytes: number;
}

export interface DocumentSummary {
  readonly workspace: SC2WorkspaceDescriptor;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** Top-level entries of the staged tree — the fastest orientation signal. */
  readonly topLevelEntries: readonly string[];
  /**
   * Subsystems this build cannot report on yet. Present so the model is told what is
   * missing rather than inferring absence from silence (PLAN.md §11, §41).
   */
  readonly notYetImplemented: readonly string[];
}

export class WorkspaceService {
  readonly #config: ServerConfig;
  readonly #pathGuard: PathGuard;
  readonly #store: WorkspaceStore;
  readonly #logger: Logger;
  readonly #mpqExtractor: MpqExtractor | undefined;

  constructor(options: WorkspaceServiceOptions) {
    this.#config = options.config;
    this.#pathGuard = options.pathGuard;
    this.#store = options.store;
    this.#logger = options.logger;
    this.#mpqExtractor = options.mpqExtractor;
  }

  get store(): WorkspaceStore {
    return this.#store;
  }

  /** Walk limits derived from config. Applied to both source and staged trees. */
  #walkLimits(): WalkOptions {
    return {
      maxFiles: this.#config.maxExtractedFiles,
      maxFileBytes: this.#config.maxSingleFileBytes,
    };
  }

  /**
   * Stages a document and returns its workspace.
   *
   * Order matters: guard the path, classify and hash the source, create the workspace
   * record, then stage. The record is written before staging so a crash mid-copy
   * leaves a discoverable workspace to discard, not an orphaned directory.
   */
  async openDocument(input: OpenDocumentInput): Promise<OpenDocumentResult> {
    const sourcePath = await this.#pathGuard.resolve(input.sourcePath, { mode: 'must-exist' });

    const source: SourceInfo = await inspectSource(sourcePath, {
      documentKindHint: input.documentKind,
      maxArchiveBytes: this.#config.maxArchiveBytes,
      walkLimits: this.#walkLimits(),
    });

    // Captured before the workspace is created so the staging step below has a
    // definitely-defined extractor without a non-null assertion.
    const extractor = this.#mpqExtractor;
    if (source.kind === 'mpq' && extractor === undefined) {
      throw new SC2Error(
        'SC2_UNSUPPORTED_OPERATION',
        'Packed SC2 documents cannot be opened yet: the sc2mpq helper is not available in this build.',
        {
          path: sourcePath,
          recoverable: false,
          suggestedAction:
            'Open the unpacked document directory instead, or build the sc2mpq helper (see docs/ and PLAN.md Phase 3).',
        },
      );
    }

    const { state, layout } = await this.#store.create({
      sourcePath,
      sourceKind: source.kind,
      documentKind: source.documentKind,
      sourceHash: source.hash,
      readOnly: input.readOnly ?? false,
    });

    try {
      if (source.kind === 'directory') {
        await copyDirectory(sourcePath, layout.workingPath, this.#walkLimits());
      } else if (extractor !== undefined) {
        await extractor.extract(sourcePath, layout.workingPath);
      }
    } catch (error) {
      // Staging failed, so the workspace is useless. Remove it rather than leave a
      // half-populated tree that later tools would report on as if it were the document.
      await this.#store.discard(state.id).catch(() => {});
      throw error;
    }

    const staged = await walkFiles(layout.workingPath, this.#walkLimits());
    const stagedBytes = staged.reduce((total, file) => total + file.size, 0);

    this.#logger.info('workspace opened', {
      workspaceId: state.id,
      sourceKind: source.kind,
      documentKind: source.documentKind,
      stagedFileCount: staged.length,
      stagedBytes,
    });

    return {
      workspace: toDescriptor(state, layout),
      stagedFileCount: staged.length,
      stagedBytes,
    };
  }

  async getState(workspaceId: string): Promise<WorkspaceState> {
    return this.#store.read(workspaceId);
  }

  async getDescriptor(workspaceId: string): Promise<SC2WorkspaceDescriptor> {
    const state = await this.#store.read(workspaceId);
    return toDescriptor(state, this.#store.layoutFor(workspaceId));
  }

  async getSummary(workspaceId: string): Promise<DocumentSummary> {
    const state = await this.#store.touch(await this.#store.read(workspaceId));
    const layout = this.#store.layoutFor(workspaceId);
    const files = await walkFiles(layout.workingPath, this.#walkLimits());

    const topLevel = new Set<string>();
    for (const file of files) {
      const [head] = file.relativePath.split('/');
      if (head !== undefined) topLevel.add(head);
    }

    return {
      workspace: toDescriptor(state, layout),
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      topLevelEntries: [...topLevel].sort(),
      // Kept explicit and honest: these are Phase 4+ (PLAN.md §42).
      notYetImplemented: [
        'components',
        'dependencies',
        'locales',
        'catalogCounts',
        'galaxyScripts',
        'diagnostics',
      ],
    };
  }

  /** Lists the staged tree. Callers paginate; this returns everything under the limits. */
  async listFiles(workspaceId: string): Promise<WalkedFile[]> {
    await this.#store.read(workspaceId);
    const layout = this.#store.layoutFor(workspaceId);
    return walkFiles(layout.workingPath, this.#walkLimits());
  }

  /**
   * Resolves an archive-style path inside a workspace to a host path.
   *
   * Uses the same containment logic as extraction, so a crafted relative path cannot
   * read outside the staging tree.
   */
  async resolveWorkingPath(workspaceId: string, relativePath: string): Promise<string> {
    await this.#store.read(workspaceId);
    const layout = this.#store.layoutFor(workspaceId);
    return resolveArchiveMemberPath(layout.workingPath, relativePath);
  }

  /** Deletes the workspace. The original source is never touched. */
  async discard(workspaceId: string): Promise<{ discarded: boolean; stagingPath: string }> {
    const layout = this.#store.layoutFor(workspaceId);
    const existed = await this.#store.exists(workspaceId);
    await this.#store.discard(workspaceId);
    this.#logger.info('workspace discarded', { workspaceId, existed });
    return { discarded: existed, stagingPath: layout.workingPath };
  }

  async listWorkspaces(): Promise<SC2WorkspaceDescriptor[]> {
    const states = await this.#store.list();
    return states.map((state) => toDescriptor(state, this.#store.layoutFor(state.id)));
  }

  /**
   * Recomputes the source hash and compares it to the value pinned at open time
   * (PLAN.md §9 commit step 2).
   *
   * Returns the comparison rather than throwing, so the commit flow can decide
   * whether the caller explicitly allowed divergence.
   */
  async checkSourceUnchanged(workspaceId: string): Promise<{ unchanged: boolean; expected: string; actual: string | null }> {
    const state = await this.#store.read(workspaceId);
    try {
      const source = await inspectSource(state.sourcePath, {
        documentKindHint: state.documentKind,
        maxArchiveBytes: this.#config.maxArchiveBytes,
        walkLimits: this.#walkLimits(),
      });
      return { unchanged: source.hash === state.sourceHash, expected: state.sourceHash, actual: source.hash };
    } catch {
      // The source was moved or deleted after opening. That is divergence, reported as
      // such rather than as an I/O failure the caller cannot interpret.
      return { unchanged: false, expected: state.sourceHash, actual: null };
    }
  }

  /** Absolute path of the staged tree, for messages and user-facing hints. */
  stagingPathFor(workspaceId: string): string {
    return path.resolve(this.#store.layoutFor(workspaceId).workingPath);
  }
}
