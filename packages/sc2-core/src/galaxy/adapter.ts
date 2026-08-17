/**
 * Galaxy language adapter (PLAN.md §7, §20).
 *
 * The one place allowed to touch `sc2-galaxy-lang`. Everything above talks to the stable
 * interfaces in this file, so a toolkit API change is contained here.
 *
 * **Loading is dynamic and optional.** The toolkit is vendored under `vendor/` (fetched by
 * `scripts/bootstrap.ps1`, gitignored, and needing its own build), so it is simply absent
 * on a fresh clone. A static import would make `pnpm install` fail there. Instead the
 * adapter probes for it once and reports unavailability, which feeds the existing
 * `capabilities.galaxy` flags — the same honesty model the MPQ sidecar uses.
 *
 * **What this does not claim:** type checking. `sc2-galaxy-lang` has a TypeChecker, but a
 * useful one needs the game's own native declarations (`natives.galaxy` and friends),
 * which live in the SC2 installation rather than in a map. Without them every call to a
 * built-in would be reported as an unresolved symbol — a wall of false errors. So this
 * adapter offers **syntax** diagnostics only, and says so.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pathExists } from '../fs/index.js';

/** Severity as this codebase models it, independent of the toolkit's own enum. */
export type GalaxyDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface GalaxyDiagnostic {
  readonly severity: GalaxyDiagnosticSeverity;
  readonly message: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  readonly code: number;
}

export type GalaxySymbolKind = 'function' | 'variable' | 'struct' | 'typedef' | 'include' | 'unknown';

export interface GalaxySymbol {
  readonly name: string;
  readonly kind: GalaxySymbolKind;
  /** 1-based line of the declaration. */
  readonly line: number;
  /** Character offset range of the whole declaration, for precise edits. */
  readonly start: number;
  readonly end: number;
}

export interface GalaxyParseResult {
  readonly path: string;
  readonly diagnostics: readonly GalaxyDiagnostic[];
  readonly symbols: readonly GalaxySymbol[];
  /** Files named by `include` directives. */
  readonly includes: readonly string[];
}

/** Minimal shape of the toolkit surface this adapter uses. */
interface ToolkitModule {
  Parser: new () => {
    parseFile(fileName: string, text: string): ToolkitSourceFile;
  };
  SyntaxKind: Record<string, number>;
  DiagnosticCategory: Record<string, number>;
}

interface ToolkitSourceFile {
  statements: ToolkitNode[];
  parseDiagnostics: ToolkitDiagnostic[];
  additionalSyntacticDiagnostics?: ToolkitDiagnostic[];
  lineMap: number[];
  text: string;
}

interface ToolkitNode {
  kind: number;
  pos?: number;
  end?: number;
  name?: { name?: string; pos?: number; end?: number };
  path?: { value?: string; text?: string };
}

interface ToolkitDiagnostic {
  messageText: string;
  category: number;
  code: number;
  start?: number;
  line?: number;
  col?: number;
}

export interface ToolkitProbe {
  readonly available: boolean;
  /** Why it is unavailable, in words a user can act on. */
  readonly reason?: string;
  /** Where it was loaded from, when available. */
  readonly modulePath?: string;
}

/**
 * Default location of the built toolkit, relative to this package.
 *
 * `vendor/sc2-galaxy-toolkit/packages/sc2-galaxy-lang/lib/src/index.js` — the `lib/src`
 * shape is the toolkit's own `tsc` output layout, not a choice made here.
 */
function defaultToolkitEntry(): string {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const repoRoot = path.resolve(packageRoot, '..', '..');
  return path.join(repoRoot, 'vendor', 'sc2-galaxy-toolkit', 'packages', 'sc2-galaxy-lang', 'lib', 'src', 'index.js');
}

let cachedModule: ToolkitModule | null = null;
let cachedProbe: ToolkitProbe | null = null;

/**
 * Loads the toolkit once, caching both success and failure.
 *
 * Never throws: absence is an expected state that must become a `false` capability flag
 * rather than a startup crash.
 */
export async function probeGalaxyToolkit(entryPath?: string): Promise<ToolkitProbe> {
  if (cachedProbe !== null && entryPath === undefined) return cachedProbe;

  const entry = entryPath ?? defaultToolkitEntry();

  if (!(await pathExists(entry))) {
    const probe: ToolkitProbe = {
      available: false,
      reason:
        'The vendored sc2-galaxy-toolkit is not built. Run scripts/bootstrap.ps1, then build it (pnpm install && pnpm --filter "sc2-galaxy-lang..." run build inside vendor/sc2-galaxy-toolkit).',
    };
    if (entryPath === undefined) cachedProbe = probe;
    return probe;
  }

  try {
    // A URL, so Windows paths import correctly.
    const imported = (await import(new URL(`file://${entry.replace(/\\/g, '/')}`).href)) as unknown as ToolkitModule;
    if (typeof imported.Parser !== 'function') {
      const probe: ToolkitProbe = {
        available: false,
        reason: 'The vendored sc2-galaxy-toolkit loaded but does not expose a Parser this adapter understands.',
      };
      if (entryPath === undefined) cachedProbe = probe;
      return probe;
    }

    const probe: ToolkitProbe = { available: true, modulePath: entry };
    if (entryPath === undefined) {
      cachedModule = imported;
      cachedProbe = probe;
    }
    return probe;
  } catch (error) {
    const probe: ToolkitProbe = {
      available: false,
      reason: `The vendored sc2-galaxy-toolkit could not be loaded: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
    if (entryPath === undefined) cachedProbe = probe;
    return probe;
  }
}

/** Converts a character offset to a 1-based line and column using the file's line map. */
function positionAt(lineMap: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = lineMap.length - 1;
  let line = 0;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const start = lineMap[middle] ?? 0;
    if (start <= offset) {
      line = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return { line: line + 1, column: offset - (lineMap[line] ?? 0) + 1 };
}

/**
 * Parses one Galaxy file.
 *
 * @throws Error when the toolkit is unavailable — callers must check {@link probeGalaxyToolkit}
 * first, and the tool layer does.
 */
export async function parseGalaxy(filePath: string, source: string): Promise<GalaxyParseResult> {
  const probe = await probeGalaxyToolkit();
  if (!probe.available || cachedModule === null) {
    throw new Error(probe.reason ?? 'The Galaxy toolkit is not available.');
  }

  const toolkit = cachedModule;
  const parser = new toolkit.Parser();
  const sourceFile = parser.parseFile(filePath, source);

  const errorCategory = toolkit.DiagnosticCategory['Error'];
  const warningCategory = toolkit.DiagnosticCategory['Warning'];

  const rawDiagnostics = [...sourceFile.parseDiagnostics, ...(sourceFile.additionalSyntacticDiagnostics ?? [])];
  const diagnostics: GalaxyDiagnostic[] = rawDiagnostics.map((diagnostic) => {
    // Prefer the toolkit's own line/col when it supplies them; fall back to the line map.
    const position =
      diagnostic.line !== undefined && diagnostic.col !== undefined
        ? { line: diagnostic.line + 1, column: diagnostic.col + 1 }
        : positionAt(sourceFile.lineMap, diagnostic.start ?? 0);

    return {
      severity:
        diagnostic.category === errorCategory ? 'error' : diagnostic.category === warningCategory ? 'warning' : 'info',
      message: diagnostic.messageText,
      line: position.line,
      column: position.column,
      code: diagnostic.code,
    };
  });

  const kinds = toolkit.SyntaxKind;
  const kindName = (kind: number): GalaxySymbolKind => {
    if (kind === kinds['FunctionDeclaration']) return 'function';
    if (kind === kinds['VariableDeclaration']) return 'variable';
    if (kind === kinds['StructDeclaration']) return 'struct';
    if (kind === kinds['TypedefDeclaration']) return 'typedef';
    if (kind === kinds['IncludeStatement']) return 'include';
    return 'unknown';
  };

  const symbols: GalaxySymbol[] = [];
  const includes: string[] = [];

  for (const statement of sourceFile.statements) {
    const kind = kindName(statement.kind);

    if (kind === 'include') {
      const included = statement.path?.value ?? statement.path?.text;
      if (included !== undefined) includes.push(included);
      continue;
    }

    const name = statement.name?.name;
    if (name === undefined || kind === 'unknown') continue;

    symbols.push({
      name,
      kind,
      line: positionAt(sourceFile.lineMap, statement.pos ?? 0).line,
      start: statement.pos ?? 0,
      end: statement.end ?? 0,
    });
  }

  symbols.sort((left, right) => left.start - right.start);
  return { path: filePath, diagnostics, symbols, includes };
}

/** Resets the cached probe. For tests. */
export function resetGalaxyToolkitCache(): void {
  cachedModule = null;
  cachedProbe = null;
}
