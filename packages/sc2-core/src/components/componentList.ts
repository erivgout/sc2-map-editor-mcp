/**
 * `ComponentList.SC2Components` (PLAN.md §11).
 *
 * Verified against the unpacked `EditorTest.SC2Map` shipped in a retail StarCraft II
 * installation (`maps/Test/`), editor build 93333. The real shape is:
 *
 * ```xml
 * <?xml version="1.0" encoding="utf-8"?>
 * <Components>
 *     <DataComponent Type="gada">GameData</DataComponent>
 *     <DataComponent Type="text" Locale="enUS">GameText</DataComponent>
 * </Components>
 * ```
 *
 * Two details worth stating, because both are easy to get wrong from prose descriptions:
 *
 * 1. The path is the element's **text content**, not an attribute.
 * 2. That path is a *logical* name, not a file path. `GameData` resolves to the
 *    `GameData` directory inside each `*.SC2Data` layer, and `GameText` to
 *    `<locale>.SC2Data/LocalizedData`. Only some components (`terr` → `t3Terrain.xml`,
 *    `info` → `DocumentInfo`) name a real file at the document root.
 */

import { SC2Error } from '../errors.js';
import { attributeValue, childElements, parseXml, textContent } from '../xml/parse.js';

export const COMPONENT_LIST_FILENAME = 'ComponentList.SC2Components';

/**
 * Four-character component type codes observed in real documents, with what they mean.
 *
 * Deliberately not exhaustive and not a closed set: an unknown code is reported as-is
 * rather than dropped (PLAN.md §11 "do not assume every document contains every
 * component", §47 "unknown data must be preserved").
 */
export const KNOWN_COMPONENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  gada: 'GameData catalogs',
  text: 'Localized text tables',
  info: 'DocumentInfo',
  mapi: 'MapInfo',
  trig: 'Triggers',
  terr: 'Terrain',
  plob: 'Placed objects',
  attr: 'Map attributes',
  aiai: 'Custom AI',
  regi: 'Regions',
  cutc: 'Cutscenes',
  bank: 'Bank list',
  prel: 'Preload list',
  layo: 'UI layout index',
});

export interface ComponentDescriptor {
  /** The `Type` attribute, e.g. `gada`. */
  readonly typeCode: string;
  /** Human-readable meaning, or `null` when the code is not one we recognise. */
  readonly description: string | null;
  /** The logical path from the element's text content. */
  readonly path: string;
  /** The `Locale` attribute, present on localized components. */
  readonly locale: string | null;
  /** Whether the component resolves to something that exists in the staged tree. */
  readonly exists: boolean;
  /** Paths in the staged tree this component resolves to. Empty when nothing matched. */
  readonly resolvedPaths: readonly string[];
  /**
   * Whether this build can *write* the component. Always false for now: reading a file
   * is not the same as being able to serialise it safely (PLAN.md §11).
   */
  readonly writable: boolean;
  /** Name of the parser that understands this component, or `null` if none does yet. */
  readonly parser: string | null;
}

export interface ComponentList {
  readonly components: readonly ComponentDescriptor[];
  /** Locales named by any `text` component, sorted. */
  readonly locales: readonly string[];
  /** Component entries whose files could not be found in the staged tree. */
  readonly missing: readonly ComponentDescriptor[];
}

/** Components this build has a reader for. Extended as phases land. */
const PARSERS: Readonly<Record<string, string>> = Object.freeze({
  info: 'documentInfo',
});

/**
 * Resolves a component entry to concrete paths in the staged tree.
 *
 * `stagedPaths` is the archive-style listing of the workspace. Matching is
 * case-insensitive because SC2 archives are.
 */
function resolveComponentPaths(component: { typeCode: string; path: string; locale: string | null }, stagedPaths: readonly string[]): string[] {
  const lowerPaths = stagedPaths.map((entry) => ({ original: entry, lower: entry.toLowerCase() }));
  const wanted = component.path.toLowerCase();

  // A component that names a real file at the document root, e.g. `terr` -> t3Terrain.xml.
  const exact = lowerPaths.filter((entry) => entry.lower === wanted);
  if (exact.length > 0) return exact.map((entry) => entry.original);

  // Otherwise it is a directory name inside one or more `*.SC2Data` layers. `GameData`
  // lives under `Base.SC2Data/GameData`, `GameText` under `<locale>.SC2Data/LocalizedData`.
  const directoryName = component.typeCode === 'text' ? 'localizeddata' : wanted;
  const matches = lowerPaths.filter((entry) => {
    const segments = entry.lower.split('/');
    if (segments.length < 2) return false;
    const layer = segments[0] ?? '';
    if (!layer.endsWith('.sc2data')) return false;
    if (segments[1] !== directoryName) return false;
    if (component.locale !== null) {
      // A locale-scoped component only claims files from its own layer.
      return layer === `${component.locale.toLowerCase()}.sc2data`;
    }
    return true;
  });

  return matches.map((entry) => entry.original);
}

/**
 * Parses a `ComponentList.SC2Components` document.
 *
 * @param source Raw file contents.
 * @param stagedPaths Archive-style listing of the workspace, used to resolve each entry.
 */
export function parseComponentList(source: string, stagedPaths: readonly string[] = []): ComponentList {
  const document = parseXml(source, { path: COMPONENT_LIST_FILENAME });

  if (document.root?.name !== 'Components') {
    throw new SC2Error('SC2_PARSE_ERROR', `${COMPONENT_LIST_FILENAME} must have a <Components> root element.`, {
      path: COMPONENT_LIST_FILENAME,
      recoverable: false,
      context: { foundRoot: document.root?.name ?? null },
    });
  }

  const components: ComponentDescriptor[] = [];

  for (const element of childElements(document.root, 'DataComponent')) {
    const typeCode = attributeValue(element, 'Type');
    if (typeCode === undefined || typeCode === '') {
      throw new SC2Error('SC2_PARSE_ERROR', 'A <DataComponent> entry has no Type attribute.', {
        path: COMPONENT_LIST_FILENAME,
        recoverable: false,
      });
    }

    const componentPath = textContent(element).trim();
    const locale = attributeValue(element, 'Locale') ?? null;
    const resolvedPaths = resolveComponentPaths({ typeCode, path: componentPath, locale }, stagedPaths);

    components.push({
      typeCode,
      description: KNOWN_COMPONENT_TYPES[typeCode] ?? null,
      path: componentPath,
      locale,
      exists: resolvedPaths.length > 0,
      resolvedPaths,
      // Writing is a separate capability from reading (PLAN.md §11); nothing is writable yet.
      writable: false,
      parser: PARSERS[typeCode] ?? null,
    });
  }

  const locales = [
    ...new Set(components.flatMap((component) => (component.locale === null ? [] : [component.locale]))),
  ].sort();

  return {
    components,
    locales,
    missing: components.filter((component) => !component.exists),
  };
}
