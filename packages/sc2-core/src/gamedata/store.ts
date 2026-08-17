/**
 * Catalog index and inheritance resolution (PLAN.md §17).
 *
 * Holds every catalog entry in one document, keyed by `(domain, id)`, and answers the
 * questions a model actually asks: what exists, what does this object inherit, and what
 * refers to it.
 *
 * Scope limit, stated loudly because it changes how results should be read: only the
 * **open document's own** catalogs are indexed. Dependency archives (`VoidMulti.SC2Mod`
 * and friends) are not loaded, so an object that exists only in a dependency is absent
 * here and a `parent` pointing into one resolves to "unresolved", not "broken". Every
 * result that could be misread as "does not exist" says which it is.
 */

import { SC2Error } from '../errors.js';
import { parseCatalogFile, walkFields, type CatalogEntry, type CatalogField, type CatalogLayer } from './catalog.js';

/** `Unit/Marine` — the canonical way to name an entry. */
export function catalogKey(domain: string, id: string): string {
  return `${domain}/${id}`;
}

export interface CatalogSearchQuery {
  /** Case-insensitive substring matched against the id. Omit to list everything. */
  readonly query?: string | undefined;
  /** Restrict to these domains. Omit for all. */
  readonly domains?: readonly string[] | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface CatalogObjectSummary {
  readonly domain: string | null;
  readonly id: string;
  readonly ctype: string;
  readonly parent: string | null;
  readonly sourcePath: string;
  readonly line: number;
  readonly fieldCount: number;
  readonly layer: CatalogLayer;
  readonly origin: string | null;
}

export interface ResolvedFieldValue {
  /** Addressable path, e.g. `LifeMax` or `FlagArray[ArmySelect]`. */
  readonly path: string;
  readonly value: string | null;
  readonly link: string | null;
  /** `Unit/Marine` — the entry in the parent chain this value actually came from. */
  readonly definedBy: string;
  readonly sourcePath: string;
  readonly line: number;
  readonly layer: CatalogLayer;
  readonly origin: string | null;
}

export interface ResolvedCatalogObject {
  readonly domain: string | null;
  readonly id: string;
  readonly ctype: string;
  /** From the object itself outward to the root ancestor. */
  readonly parentChain: readonly string[];
  /** Parents named but not found in this document, usually because they live in a dependency. */
  readonly unresolvedParents: readonly string[];
  /** Final effective values, nearest definition winning. */
  readonly fields: readonly ResolvedFieldValue[];
}

export interface CatalogReference {
  /** `Unit/Marine` — the entry containing the reference. */
  readonly from: string;
  readonly fromDomain: string | null;
  /** Field path within that entry. */
  readonly fieldPath: string;
  /** The referencing attribute: `Link` for a catalog link, `value` for a bare id. */
  readonly via: 'Link' | 'value' | 'parent';
  readonly sourcePath: string;
  readonly line: number;
}

export interface CatalogIndexStats {
  readonly fileCount: number;
  readonly entryCount: number;
  readonly domainCount: number;
  /** Entries whose element name matched no known domain. */
  readonly unknownDomainCount: number;
  /** Entries owned by the open document, i.e. the editable ones. */
  readonly documentEntryCount: number;
  /** Entries contributed by loaded dependencies. */
  readonly dependencyEntryCount: number;
  /** Names of the dependencies whose catalogs were loaded. */
  readonly loadedDependencies: readonly string[];
}

/** One parsed catalog file plus the diagnostics from reading it. */
export interface CatalogSource {
  readonly path: string;
  readonly content: string;
  /**
   * Which layer this file belongs to. Sources are supplied dependency-first, document
   * last, so the existing last-definition-wins rule gives the document priority — the
   * same order SC2 itself resolves in (PLAN.md §25).
   */
  readonly layer?: CatalogLayer | undefined;
  /** Dependency name, for reporting where an inherited value actually came from. */
  readonly origin?: string | null | undefined;
}

export interface CatalogIndexDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

/**
 * How deep `resolve` will follow `parent` links.
 *
 * Real chains are a handful deep; a limit this generous only ever fires on a cycle or on
 * data that is already wrong, and stopping is better than hanging.
 */
const MAX_PARENT_DEPTH = 64;

export class CatalogIndex {
  readonly #byKey = new Map<string, CatalogEntry>();
  /** Entries with no `id`: per-type default templates. Keyed by concrete type. */
  readonly #defaults = new Map<string, CatalogEntry>();
  readonly #all: CatalogEntry[] = [];
  readonly #diagnostics: CatalogIndexDiagnostic[] = [];
  #fileCount = 0;

  /**
   * Builds an index from already-read catalog files.
   *
   * A file that fails to parse becomes a diagnostic rather than an exception: one broken
   * catalog must not make the other forty unusable.
   */
  static build(sources: readonly CatalogSource[]): CatalogIndex {
    const index = new CatalogIndex();

    for (const source of sources) {
      index.#fileCount += 1;
      let file;
      try {
        file = parseCatalogFile(source.content, source.path, { layer: source.layer, origin: source.origin });
      } catch (error) {
        index.#diagnostics.push({
          severity: 'error',
          code: error instanceof SC2Error ? error.code : 'SC2_PARSE_ERROR',
          message: error instanceof Error ? error.message : 'Could not parse catalog file.',
          path: source.path,
        });
        continue;
      }

      for (const element of file.unrecognizedElements) {
        index.#diagnostics.push({
          severity: 'warning',
          code: 'SC2_UNSUPPORTED_COMPONENT',
          message: `Ignored a <${element}> element that does not look like a catalog entry.`,
          path: source.path,
        });
      }

      for (const entry of file.entries) {
        index.#all.push(entry);

        if (entry.id === null) {
          index.#defaults.set(entry.ctype, entry);
          continue;
        }
        if (entry.domain === null) {
          index.#diagnostics.push({
            severity: 'warning',
            code: 'SC2_UNSUPPORTED_COMPONENT',
            message: `Entry "${entry.id}" has type <${entry.ctype}>, whose catalog domain this build does not recognise.`,
            path: source.path,
          });
          continue;
        }

        const key = catalogKey(entry.domain, entry.id);
        const existing = index.#byKey.get(key);
        if (existing !== undefined) {
          // Duplicate ids are a real SC2 authoring error and a validation finding
          // (PLAN.md §31). Last definition wins, matching SC2's own load order.
          index.#diagnostics.push({
            severity: 'warning',
            code: 'SC2_BROKEN_REFERENCE',
            message: `Duplicate catalog id ${key}: also defined in ${existing.sourcePath}:${existing.line}. The later definition wins.`,
            path: source.path,
          });
        }
        index.#byKey.set(key, entry);
      }
    }

    return index;
  }

  get diagnostics(): readonly CatalogIndexDiagnostic[] {
    return this.#diagnostics;
  }

  stats(): CatalogIndexStats {
    return {
      fileCount: this.#fileCount,
      entryCount: this.#byKey.size,
      domainCount: this.domains().length,
      unknownDomainCount: this.#all.filter((entry) => entry.domain === null && entry.id !== null).length,
      documentEntryCount: [...this.#byKey.values()].filter((entry) => entry.layer === 'document').length,
      dependencyEntryCount: [...this.#byKey.values()].filter((entry) => entry.layer === 'dependency').length,
      loadedDependencies: [
        ...new Set(this.#all.flatMap((entry) => (entry.origin === null ? [] : [entry.origin]))),
      ].sort(),
    };
  }

  /** Domains actually present in this document, with entry counts. */
  domains(): { domain: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const entry of this.#byKey.values()) {
      if (entry.domain === null) continue;
      counts.set(entry.domain, (counts.get(entry.domain) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((left, right) => left.domain.localeCompare(right.domain));
  }

  get(domain: string, id: string): CatalogEntry | null {
    return this.#byKey.get(catalogKey(domain, id)) ?? null;
  }

  /** Every entry with this id, across domains. Useful when the caller does not know the domain. */
  findById(id: string): CatalogEntry[] {
    const lowered = id.toLowerCase();
    return this.#all.filter((entry) => entry.id?.toLowerCase() === lowered);
  }

  search(query: CatalogSearchQuery = {}): { total: number; results: CatalogObjectSummary[] } {
    const needle = query.query?.toLowerCase();
    const domainFilter = query.domains === undefined ? null : new Set(query.domains);

    const matched = [...this.#byKey.values()].filter((entry) => {
      if (domainFilter !== null && (entry.domain === null || !domainFilter.has(entry.domain))) return false;
      if (needle !== undefined && !(entry.id ?? '').toLowerCase().includes(needle)) return false;
      return true;
    });

    // Deterministic ordering: exact-prefix matches first, then alphabetical, so repeated
    // calls with the same query return the same page (PLAN.md §14).
    matched.sort((left, right) => {
      if (needle !== undefined) {
        const leftStarts = (left.id ?? '').toLowerCase().startsWith(needle);
        const rightStarts = (right.id ?? '').toLowerCase().startsWith(needle);
        if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
      }
      const byDomain = (left.domain ?? '').localeCompare(right.domain ?? '');
      return byDomain !== 0 ? byDomain : (left.id ?? '').localeCompare(right.id ?? '');
    });

    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;

    return {
      total: matched.length,
      results: matched.slice(offset, offset + limit).map((entry) => ({
        domain: entry.domain,
        id: entry.id ?? '',
        ctype: entry.ctype,
        parent: entry.parent,
        sourcePath: entry.sourcePath,
        line: entry.line,
        fieldCount: entry.fields.length,
        layer: entry.layer,
        origin: entry.origin,
      })),
    };
  }

  /**
   * Resolves an object's effective field values by walking its `parent` chain.
   *
   * Nearest definition wins: a field set on the object itself overrides the same field on
   * an ancestor. `definedBy` on every value records which entry supplied it, so a caller
   * can tell an inherited value from an overridden one — which is exactly what decides
   * whether editing it is safe (PLAN.md §45).
   */
  resolve(domain: string, id: string): ResolvedCatalogObject {
    const root = this.get(domain, id);
    if (root === null) {
      throw new SC2Error('SC2_NOT_FOUND', `No catalog object ${catalogKey(domain, id)} in this document.`, {
        objectId: catalogKey(domain, id),
        recoverable: true,
        suggestedAction:
          'Use sc2_search_catalog to find the right id. Objects defined only in a dependency archive are not indexed by this build.',
      });
    }

    const parentChain: string[] = [];
    const unresolvedParents: string[] = [];
    const chain: CatalogEntry[] = [root];
    const seen = new Set([catalogKey(domain, id)]);

    let current = root;
    for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
      const parentId = current.parent;
      if (parentId === null) break;

      const parentKey = catalogKey(domain, parentId);
      if (seen.has(parentKey)) {
        // A cycle is corrupt data. Stopping and saying so beats looping.
        unresolvedParents.push(`${parentId} (cycle)`);
        break;
      }
      seen.add(parentKey);

      const parentEntry = this.get(domain, parentId);
      if (parentEntry === null) {
        unresolvedParents.push(parentId);
        break;
      }

      parentChain.push(parentId);
      chain.push(parentEntry);
      current = parentEntry;
    }

    // Walk from the most distant ancestor inward so nearer definitions overwrite.
    const effective = new Map<string, ResolvedFieldValue>();
    for (const entry of [...chain].reverse()) {
      for (const { path, field } of walkFields(entry.fields)) {
        effective.set(path, {
          path,
          value: field.value,
          link: field.link,
          definedBy: catalogKey(entry.domain ?? domain, entry.id ?? ''),
          sourcePath: entry.sourcePath,
          line: entry.line,
          layer: entry.layer,
          origin: entry.origin,
        });
      }
    }

    return {
      domain: root.domain,
      id: root.id ?? id,
      ctype: root.ctype,
      parentChain,
      unresolvedParents,
      fields: [...effective.values()].sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  /**
   * Finds entries referring to `(domain, id)`.
   *
   * SC2 references are untyped strings, so a `Link="Marine"` on a unit field could name a
   * unit, an actor, or something else entirely. Rather than guess, this matches on the id
   * and reports where and how it was referenced, leaving interpretation to the caller.
   * That is deliberately over-inclusive: for a "safe to delete?" question, a false
   * positive costs a second look while a false negative breaks the map.
   */
  findReferences(domain: string, id: string): CatalogReference[] {
    const references: CatalogReference[] = [];
    const target = id.toLowerCase();

    for (const entry of this.#byKey.values()) {
      const from = catalogKey(entry.domain ?? '?', entry.id ?? '');

      if (entry.parent?.toLowerCase() === target && entry.domain === domain) {
        references.push({
          from,
          fromDomain: entry.domain,
          fieldPath: 'parent',
          via: 'parent',
          sourcePath: entry.sourcePath,
          line: entry.line,
        });
      }

      for (const { path, field } of walkFields(entry.fields)) {
        if (field.link?.toLowerCase() === target) {
          references.push({ from, fromDomain: entry.domain, fieldPath: path, via: 'Link', sourcePath: entry.sourcePath, line: entry.line });
        } else if (field.value?.toLowerCase() === target) {
          references.push({ from, fromDomain: entry.domain, fieldPath: path, via: 'value', sourcePath: entry.sourcePath, line: entry.line });
        }
      }
    }

    references.sort((left, right) => left.from.localeCompare(right.from) || left.fieldPath.localeCompare(right.fieldPath));
    return references;
  }

  /** The per-type default template, if the document defines one. */
  defaultsFor(ctype: string): CatalogEntry | null {
    return this.#defaults.get(ctype) ?? null;
  }

  /** Fields declared directly on the entry, with their addressable paths. */
  ownFields(entry: CatalogEntry): { path: string; field: CatalogField }[] {
    return [...walkFields(entry.fields)];
  }
}
