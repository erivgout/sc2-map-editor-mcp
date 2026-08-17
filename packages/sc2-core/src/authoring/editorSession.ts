/**
 * Multi-file catalog editing session (PLAN.md §19).
 *
 * High-level authoring touches several objects at once, and those objects live in
 * different files. This holds the in-flight contents of every file a composite operation
 * touches, so each successive step sees the previous step's result rather than a stale
 * copy read from disk.
 *
 * It produces a plan; it does not write. The transaction engine applies the plan
 * atomically, which is what makes a half-built unit impossible.
 */

import { SC2Error } from '../errors.js';
import {
  CatalogIndex,
  applyCatalogPatches,
  catalogKey,
  cloneCatalogEntry,
  createCatalogEntry,
  type CatalogPatch,
} from '../gamedata/index.js';

/** Reads a staged file by its archive-style path. */
export type FileReader = (relativePath: string) => Promise<string>;

export interface PlannedWrite {
  readonly path: string;
  readonly content: string;
}

/** An object this session created, so the caller can be told exactly what appeared. */
export interface CreatedObject {
  readonly domain: string;
  readonly id: string;
  readonly ctype: string;
  readonly path: string;
  /** What it was cloned from, when it was a clone. */
  readonly clonedFrom?: string;
}

export class CatalogEditSession {
  readonly #index: CatalogIndex;
  readonly #read: FileReader;
  readonly #files = new Map<string, string>();
  readonly #summary: string[] = [];
  readonly #created: CreatedObject[] = [];
  /** Objects created in this session, so later steps can find what disk does not have. */
  readonly #pending = new Map<string, { ctype: string; path: string }>();

  constructor(index: CatalogIndex, read: FileReader) {
    this.#index = index;
    this.#read = read;
  }

  get summary(): readonly string[] {
    return this.#summary;
  }

  get created(): readonly CreatedObject[] {
    return this.#created;
  }

  get writes(): PlannedWrite[] {
    return [...this.#files.entries()].map(([path, content]) => ({ path, content }));
  }

  /** Current contents of a file, reading it once and reusing the in-flight version after. */
  async #content(relativePath: string): Promise<string> {
    const existing = this.#files.get(relativePath);
    if (existing !== undefined) return existing;
    const source = await this.#read(relativePath);
    this.#files.set(relativePath, source);
    return source;
  }

  /** Where an object lives, whether it was already on disk or created in this session. */
  #locate(domain: string, id: string): { path: string; ctype: string } {
    const pending = this.#pending.get(catalogKey(domain, id));
    if (pending !== undefined) return pending;

    const entry = this.#index.get(domain, id);
    if (entry === null) {
      throw new SC2Error('SC2_NOT_FOUND', `No catalog object ${catalogKey(domain, id)} in this document.`, {
        objectId: catalogKey(domain, id),
        recoverable: true,
        suggestedAction:
          'Objects defined only in a dependency archive cannot be edited here; clone them into this document first.',
      });
    }
    return { path: entry.sourcePath, ctype: entry.ctype };
  }

  /** True when the document (or this session) already has the object. */
  has(domain: string, id: string): boolean {
    return this.#pending.has(catalogKey(domain, id)) || this.#index.get(domain, id) !== null;
  }

  async patch(domain: string, id: string, patches: readonly CatalogPatch[]): Promise<void> {
    if (patches.length === 0) return;
    const location = this.#locate(domain, id);
    const outcome = applyCatalogPatches(await this.#content(location.path), domain, id, patches, location.path);
    this.#files.set(location.path, outcome.content);
    this.#summary.push(...outcome.summary);
  }

  async clone(domain: string, sourceId: string, newId: string, options: { newParent?: string | undefined } = {}): Promise<CreatedObject> {
    if (this.has(domain, newId)) {
      throw new SC2Error('SC2_CONFLICT', `${catalogKey(domain, newId)} already exists.`, {
        objectId: catalogKey(domain, newId),
        recoverable: true,
        suggestedAction: 'Choose a different id.',
      });
    }

    const location = this.#locate(domain, sourceId);
    const outcome = cloneCatalogEntry(await this.#content(location.path), domain, sourceId, newId, location.path, options);
    this.#files.set(location.path, outcome.content);
    this.#summary.push(...outcome.summary);

    const created: CreatedObject = {
      domain,
      id: newId,
      ctype: location.ctype,
      path: location.path,
      clonedFrom: catalogKey(domain, sourceId),
    };
    this.#pending.set(catalogKey(domain, newId), { ctype: location.ctype, path: location.path });
    this.#created.push(created);
    return created;
  }

  async create(ctype: string, domain: string, newId: string, targetPath: string, options: { parent?: string | undefined } = {}): Promise<CreatedObject> {
    if (this.has(domain, newId)) {
      throw new SC2Error('SC2_CONFLICT', `${catalogKey(domain, newId)} already exists.`, {
        objectId: catalogKey(domain, newId),
        recoverable: true,
      });
    }

    const outcome = createCatalogEntry(await this.#content(targetPath), ctype, newId, targetPath, options);
    this.#files.set(targetPath, outcome.content);
    this.#summary.push(...outcome.summary);

    const created: CreatedObject = { domain, id: newId, ctype, path: targetPath };
    this.#pending.set(catalogKey(domain, newId), { ctype, path: targetPath });
    this.#created.push(created);
    return created;
  }

  note(line: string): void {
    this.#summary.push(line);
  }
}
