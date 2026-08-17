/**
 * Aggregate document validation (PLAN.md §31).
 *
 * One validator runs every specialised check and returns a per-category verdict. The
 * category set is fixed and always fully reported, because "no errors in triggers" and
 * "triggers were not checked" mean very different things to someone about to ship a map,
 * and a result that omits the difference invites the wrong conclusion.
 *
 * Every category is therefore one of:
 *   - `passed`    — checked, nothing wrong
 *   - `failed`    — checked, problems found
 *   - `unsupported` — **not checked at all**; this build cannot inspect it
 *   - `skipped`   — checkable in principle, not applicable to this document
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseComponentList, parseDocumentInfo, COMPONENT_LIST_FILENAME, DOCUMENT_INFO_FILENAME } from '../components/index.js';
import { SC2Error } from '../errors.js';
import type { WalkedFile } from '../fs/index.js';
import { CatalogIndex } from '../gamedata/index.js';
import { parseTextTable, findTextTables } from '../text/index.js';
import { parseXml } from '../xml/parse.js';

export type CheckStatus = 'passed' | 'failed' | 'unsupported' | 'skipped';

export const VALIDATION_CATEGORIES = [
  'archive',
  'components',
  'xml',
  'gamedata',
  'galaxy',
  'triggers',
  'localization',
  'references',
  'assets',
  'terrain',
] as const;

export type ValidationCategory = (typeof VALIDATION_CATEGORIES)[number];

export interface ValidationFinding {
  readonly category: ValidationCategory;
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly objectId?: string;
}

export interface CategoryResult {
  readonly status: CheckStatus;
  /** Why, when the status is `unsupported` or `skipped`. */
  readonly reason?: string;
  readonly errorCount: number;
  readonly warningCount: number;
}

export interface ValidationReport {
  /** False when any category reported an error. Warnings do not make a document invalid. */
  readonly valid: boolean;
  readonly errors: readonly ValidationFinding[];
  readonly warnings: readonly ValidationFinding[];
  readonly checks: Readonly<Record<ValidationCategory, CategoryResult>>;
  /** Categories reported as `unsupported`, restated so they are impossible to miss. */
  readonly notChecked: readonly ValidationCategory[];
}

export interface ValidateInput {
  /** Archive-style listing of the staged document. */
  readonly files: readonly WalkedFile[];
  /** Absolute path of the staged tree, for reading file contents. */
  readonly workingPath: string;
  readonly sourceKind: 'directory' | 'mpq';
  /** Locale to check display names against. */
  readonly defaultLocale: string;
  /** Cap on how many findings of one kind to record, so a broken document cannot flood. */
  readonly maxFindingsPerCategory?: number;
}

const DEFAULT_MAX_FINDINGS = 200;

/** Files worth parsing as XML during the `xml` check. */
function isXmlFile(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return (
    lower.endsWith('.xml') ||
    lower.endsWith('.sc2components') ||
    lower.endsWith('.sc2layout') ||
    lower === 'documentinfo'
  );
}

class FindingCollector {
  readonly #findings: ValidationFinding[] = [];
  readonly #counts = new Map<ValidationCategory, number>();
  readonly #limit: number;
  readonly #truncated = new Set<ValidationCategory>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  add(finding: ValidationFinding): void {
    const seen = this.#counts.get(finding.category) ?? 0;
    if (seen >= this.#limit) {
      this.#truncated.add(finding.category);
      return;
    }
    this.#counts.set(finding.category, seen + 1);
    this.#findings.push(finding);
  }

  get findings(): readonly ValidationFinding[] {
    return this.#findings;
  }

  /** Categories whose findings were capped, so the report can say so. */
  get truncatedCategories(): readonly ValidationCategory[] {
    return [...this.#truncated];
  }

  countFor(category: ValidationCategory, severity: 'error' | 'warning'): number {
    return this.#findings.filter((finding) => finding.category === category && finding.severity === severity).length;
  }
}

/**
 * Validates a staged document.
 *
 * Reads files itself rather than taking parsed models, so what it checks is what is
 * actually on disk right now — not a cached view that a mutation may have invalidated.
 */
export async function validateDocument(input: ValidateInput): Promise<ValidationReport> {
  const collector = new FindingCollector(input.maxFindingsPerCategory ?? DEFAULT_MAX_FINDINGS);
  const checks: Partial<Record<ValidationCategory, CategoryResult>> = {};

  const byPath = new Map(input.files.map((file) => [file.relativePath.toLowerCase(), file]));
  const read = async (relativePath: string): Promise<string> =>
    readFile(path.join(input.workingPath, ...relativePath.split('/')), 'utf8');

  // ---------------------------------------------------------------- archive
  if (input.sourceKind === 'mpq') {
    // Verifying a packed archive means reopening it through the MPQ helper, which this
    // build does not have. Saying "passed" would be a claim we cannot support.
    checks.archive = {
      status: 'unsupported',
      reason: 'Archive verification needs the sc2mpq helper, which is not available in this build.',
      errorCount: 0,
      warningCount: 0,
    };
  } else {
    if (input.files.length === 0) {
      collector.add({
        category: 'archive',
        severity: 'error',
        code: 'SC2_VALIDATION_FAILED',
        message: 'The staged document contains no files.',
      });
    }

    // Duplicate paths differing only in case are legal on disk but collide inside an MPQ.
    const seen = new Map<string, string>();
    for (const file of input.files) {
      const key = file.relativePath.toLowerCase();
      const previous = seen.get(key);
      if (previous !== undefined) {
        collector.add({
          category: 'archive',
          severity: 'error',
          code: 'SC2_VALIDATION_FAILED',
          message: `Two files differ only in case and would collide when packed: "${previous}" and "${file.relativePath}".`,
          path: file.relativePath,
        });
      }
      seen.set(key, file.relativePath);
    }
  }

  // ------------------------------------------------------------- components
  const componentFile = byPath.get(COMPONENT_LIST_FILENAME.toLowerCase());
  if (componentFile === undefined) {
    checks.components = {
      status: 'skipped',
      reason: `This document has no ${COMPONENT_LIST_FILENAME}.`,
      errorCount: 0,
      warningCount: 0,
    };
  } else {
    try {
      const list = parseComponentList(
        await read(componentFile.relativePath),
        input.files.map((file) => file.relativePath),
      );
      for (const missing of list.missing) {
        collector.add({
          category: 'components',
          severity: 'warning',
          code: 'SC2_UNSUPPORTED_COMPONENT',
          message: `Component "${missing.path}" (type ${missing.typeCode}) is declared but no matching files exist.`,
          path: COMPONENT_LIST_FILENAME,
        });
      }
    } catch (error) {
      collector.add({
        category: 'components',
        severity: 'error',
        code: error instanceof SC2Error ? error.code : 'SC2_PARSE_ERROR',
        message: error instanceof Error ? error.message : 'Could not parse the component list.',
        path: COMPONENT_LIST_FILENAME,
      });
    }
  }

  // -------------------------------------------------------------------- xml
  const xmlFiles = input.files.filter((file) => isXmlFile(file.relativePath));
  for (const file of xmlFiles) {
    try {
      parseXml(await read(file.relativePath), { path: file.relativePath });
    } catch (error) {
      collector.add({
        category: 'xml',
        severity: 'error',
        code: 'SC2_PARSE_ERROR',
        message: error instanceof Error ? error.message : 'XML is not well formed.',
        path: file.relativePath,
      });
    }
  }

  // The DocumentInfo parser is stricter than well-formedness; run it too.
  const documentInfoFile = byPath.get(DOCUMENT_INFO_FILENAME.toLowerCase());
  if (documentInfoFile !== undefined) {
    try {
      parseDocumentInfo(await read(documentInfoFile.relativePath));
    } catch (error) {
      collector.add({
        category: 'xml',
        severity: 'error',
        code: 'SC2_PARSE_ERROR',
        message: error instanceof Error ? error.message : 'DocumentInfo could not be parsed.',
        path: DOCUMENT_INFO_FILENAME,
      });
    }
  }

  // --------------------------------------------------------------- gamedata
  const catalogFiles = input.files.filter((file) => {
    const segments = file.relativePath.toLowerCase().split('/');
    return (
      segments.length >= 3 &&
      (segments[0] ?? '').endsWith('.sc2data') &&
      segments[1] === 'gamedata' &&
      file.relativePath.toLowerCase().endsWith('.xml')
    );
  });

  let index: CatalogIndex | null = null;
  if (catalogFiles.length === 0) {
    checks.gamedata = { status: 'skipped', reason: 'This document has no GameData catalogs.', errorCount: 0, warningCount: 0 };
    checks.references = { status: 'skipped', reason: 'No GameData to cross-reference.', errorCount: 0, warningCount: 0 };
  } else {
    const sources = [];
    for (const file of catalogFiles) {
      sources.push({ path: file.relativePath, content: await read(file.relativePath) });
    }
    index = CatalogIndex.build(sources);

    for (const diagnostic of index.diagnostics) {
      collector.add({
        category: 'gamedata',
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
        path: diagnostic.path,
      });
    }

    // ---------------------------------------------------------- references
    //
    // A `parent` that resolves to nothing in this document is only a *possible* problem:
    // it may live in a dependency archive, which this build does not load. Reporting it
    // as an error would cry wolf on every well-formed map, so it is a warning that says
    // exactly that.
    for (const domainEntry of index.domains()) {
      for (const summary of index.search({ domains: [domainEntry.domain], limit: 100_000 }).results) {
        if (summary.parent === null) continue;
        if (index.get(domainEntry.domain, summary.parent) !== null) continue;
        collector.add({
          category: 'references',
          severity: 'warning',
          code: 'SC2_BROKEN_REFERENCE',
          message: `${domainEntry.domain}/${summary.id} inherits from "${summary.parent}", which is not in this document. That is normal if it comes from a dependency, but nothing here can confirm it.`,
          path: summary.sourcePath,
          objectId: `${domainEntry.domain}/${summary.id}`,
        });
      }
    }
  }

  // ----------------------------------------------------------- localization
  const textTables = findTextTables(input.files.map((file) => ({ relativePath: file.relativePath, size: file.size })));
  if (textTables.length === 0) {
    checks.localization = { status: 'skipped', reason: 'This document has no localized text tables.', errorCount: 0, warningCount: 0 };
  } else {
    for (const table of textTables) {
      const parsed = parseTextTable(await read(table.path), table.path);
      for (const duplicate of parsed.duplicateKeys) {
        collector.add({
          category: 'localization',
          severity: 'warning',
          code: 'SC2_VALIDATION_FAILED',
          message: `Key "${duplicate}" is defined more than once; the last definition wins.`,
          path: table.path,
        });
      }
      for (const unparsed of parsed.unparsedLines) {
        collector.add({
          category: 'localization',
          severity: 'warning',
          code: 'SC2_PARSE_ERROR',
          message: `Line ${unparsed.line} is not a key=value pair: "${unparsed.text.slice(0, 80)}".`,
          path: table.path,
        });
      }
    }

    // Locale coverage: a key present in one locale but not another is a real gap.
    const locales = [...new Set(textTables.map((table) => table.locale))];
    if (locales.length > 1) {
      const keysByLocale = new Map<string, Set<string>>();
      for (const table of textTables) {
        const parsed = parseTextTable(await read(table.path), table.path);
        const existing = keysByLocale.get(table.locale) ?? new Set<string>();
        for (const key of parsed.byKey.keys()) existing.add(key);
        keysByLocale.set(table.locale, existing);
      }

      const reference = keysByLocale.get(input.defaultLocale) ?? keysByLocale.values().next().value ?? new Set<string>();
      for (const [locale, keys] of keysByLocale) {
        if (locale === input.defaultLocale) continue;
        for (const key of reference) {
          if (keys.has(key)) continue;
          collector.add({
            category: 'localization',
            severity: 'warning',
            code: 'SC2_VALIDATION_FAILED',
            message: `Key "${key}" exists in ${input.defaultLocale} but not in ${locale}.`,
          });
        }
      }
    }
  }

  // ----------------------------------------------------------------- assets
  // Only map-local asset *paths* referenced from GameData can be checked, and SC2 asset
  // references are untyped strings, so this is deliberately narrow: a `value` that looks
  // like a path into a directory the document has.
  if (index === null) {
    checks.assets = { status: 'skipped', reason: 'No GameData to scan for asset references.', errorCount: 0, warningCount: 0 };
  } else {
    const assetPaths = new Set(input.files.map((file) => file.relativePath.toLowerCase().replace(/\\/g, '/')));
    for (const domainEntry of index.domains()) {
      for (const summary of index.search({ domains: [domainEntry.domain], limit: 100_000 }).results) {
        const entry = index.get(domainEntry.domain, summary.id);
        if (entry === null) continue;
        for (const { field } of index.ownFields(entry)) {
          const value = field.value;
          if (value === undefined || value === null) continue;
          if (!/\.(dds|tga|m3|m3a|ogg|wav|mp3)$/i.test(value)) continue;
          const normalized = value.replace(/\\/g, '/').toLowerCase();
          if (assetPaths.has(normalized)) continue;
          collector.add({
            category: 'assets',
            severity: 'warning',
            code: 'SC2_BROKEN_REFERENCE',
            message: `${domainEntry.domain}/${summary.id} references asset "${value}", which is not in this document. That is normal for a stock Blizzard asset.`,
            path: entry.sourcePath,
            objectId: `${domainEntry.domain}/${summary.id}`,
          });
        }
      }
    }
  }

  // -------------------------------------------- categories this build cannot check
  checks.galaxy = {
    status: 'unsupported',
    reason: 'Galaxy parsing is not implemented in this build; scripts were not checked at all.',
    errorCount: 0,
    warningCount: 0,
  };
  checks.triggers = {
    status: 'unsupported',
    reason: 'Trigger parsing is not implemented in this build; triggers were not checked at all.',
    errorCount: 0,
    warningCount: 0,
  };
  checks.terrain = {
    status: 'unsupported',
    reason: 'Terrain codecs are not implemented in this build; terrain was not checked at all.',
    errorCount: 0,
    warningCount: 0,
  };

  // Fill in every category that ran, from the findings actually collected.
  for (const category of VALIDATION_CATEGORIES) {
    if (checks[category] !== undefined) continue;
    const errorCount = collector.countFor(category, 'error');
    const warningCount = collector.countFor(category, 'warning');
    checks[category] = {
      status: errorCount > 0 ? 'failed' : 'passed',
      errorCount,
      warningCount,
    };
  }

  for (const category of collector.truncatedCategories) {
    collector.add({
      category,
      severity: 'warning',
      code: 'SC2_LIMIT_EXCEEDED',
      message: `More ${category} findings exist than this report shows; the list was capped.`,
    });
  }

  const errors = collector.findings.filter((finding) => finding.severity === 'error');
  const warnings = collector.findings.filter((finding) => finding.severity === 'warning');

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    checks: checks as Record<ValidationCategory, CategoryResult>,
    notChecked: VALIDATION_CATEGORIES.filter((category) => checks[category]?.status === 'unsupported'),
  };
}
