/**
 * GameData catalog parsing (PLAN.md §17).
 *
 * Verified against `Base.SC2Data/GameData/*.xml` in the unpacked `EditorTest.SC2Map`
 * shipped with StarCraft II. The shape is:
 *
 * ```xml
 * <Catalog>
 *     <CUnit id="Broodling2" parent="BroodlingDefault">
 *         <LifeMax value="500000"/>
 *         <FlagArray index="ArmySelect" value="1"/>
 *         <WeaponArray index="0" Link="AdeptNewWeapon"/>
 *         <AbilArray Link="stop"/>
 *     </CUnit>
 * </Catalog>
 * ```
 *
 * Field conventions, all observed in real data:
 *
 * - `value="…"` carries a scalar.
 * - `Link="…"` carries a reference to another catalog entry.
 * - `index="…"` makes the field an array element, keyed either by a number (`"0"`) or by
 *   a token (`"ArmySelect"`). The same element name repeats with different indices.
 * - Fields can also nest, holding child elements rather than attributes.
 *
 * Every entry and field keeps its source span, so Phase 8's mutations can splice bytes in
 * place rather than reserialising the file (PLAN.md §12).
 */

import { SC2Error } from '../errors.js';
import { attributeValue, childElements, parseXml, type XmlElement, type XmlSpan } from '../xml/parse.js';
import { domainFromElementName, isCatalogElementName } from './domains.js';

export interface CatalogField {
  /** Element name, e.g. `LifeMax` or `FlagArray`. */
  readonly name: string;
  /** The `index` attribute when present — this field is an array element. */
  readonly index: string | null;
  /** The `value` attribute when present. */
  readonly value: string | null;
  /** The `Link` attribute when present: a reference to another catalog entry. */
  readonly link: string | null;
  /** Attributes other than `index`, `value`, and `Link`. */
  readonly otherAttributes: Readonly<Record<string, string>>;
  /** Nested fields, for structured values. */
  readonly children: readonly CatalogField[];
  /** Span of the whole element in the source file. */
  readonly span: XmlSpan;
}

/**
 * Where a catalog entry came from.
 *
 * `document` entries live in the open workspace and can be edited. `dependency` entries
 * come from a loaded dependency archive: readable, inheritable from, and referenceable —
 * but outside the workspace, so nothing may write to them.
 */
export type CatalogLayer = 'document' | 'dependency';

export interface CatalogEntry {
  /** Concrete type from the element name, e.g. `CAbilEffectInstant`. */
  readonly ctype: string;
  /** Domain the concrete type belongs to, or `null` when unrecognised. */
  readonly domain: string | null;
  /** The `id` attribute. Entries without one are default-value templates. */
  readonly id: string | null;
  /** The `parent` attribute: the entry this one inherits from, within the same domain. */
  readonly parent: string | null;
  /** The `default` attribute, marking a template rather than a concrete object. */
  readonly isDefault: boolean;
  readonly fields: readonly CatalogField[];
  readonly span: XmlSpan;
  /** Archive-style path of the file this entry came from. */
  readonly sourcePath: string;
  readonly layer: CatalogLayer;
  /** Name of the dependency it came from, or `null` for the document itself. */
  readonly origin: string | null;
  /** 1-based line of the entry's opening tag, for human-facing output. */
  readonly line: number;
}

export interface CatalogFile {
  readonly path: string;
  readonly layer: CatalogLayer;
  readonly origin: string | null;
  readonly entries: readonly CatalogEntry[];
  /** Elements under `<Catalog>` that are not catalog entries. Reported, never dropped. */
  readonly unrecognizedElements: readonly string[];
}

const RESERVED_FIELD_ATTRIBUTES = new Set(['index', 'value', 'Link']);

function toField(element: XmlElement): CatalogField {
  const otherAttributes: Record<string, string> = {};
  for (const attribute of element.attributes) {
    if (RESERVED_FIELD_ATTRIBUTES.has(attribute.name)) continue;
    otherAttributes[attribute.name] = attribute.value;
  }

  return {
    name: element.name,
    index: attributeValue(element, 'index') ?? null,
    value: attributeValue(element, 'value') ?? null,
    link: attributeValue(element, 'Link') ?? null,
    otherAttributes,
    children: childElements(element).map(toField),
    span: element.span,
  };
}

/** Counts newlines before `offset`, for 1-based line numbers. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') line += 1;
  }
  return line;
}

/**
 * Parses one GameData catalog file.
 *
 * @param sourcePath Archive-style path, recorded on every entry so a caller can find it.
 * @throws SC2Error `SC2_PARSE_ERROR` when the file is not well-formed or is not a catalog.
 */
export function parseCatalogFile(
  source: string,
  sourcePath: string,
  provenance: { layer?: CatalogLayer | undefined; origin?: string | null | undefined } = {},
): CatalogFile {
  const layer = provenance.layer ?? 'document';
  const origin = provenance.origin ?? null;
  const document = parseXml(source, { path: sourcePath });

  if (document.root?.name !== 'Catalog') {
    throw new SC2Error('SC2_PARSE_ERROR', `${sourcePath} is not a GameData catalog: expected a <Catalog> root element.`, {
      path: sourcePath,
      recoverable: false,
      context: { foundRoot: document.root?.name ?? null },
    });
  }

  const entries: CatalogEntry[] = [];
  const unrecognizedElements: string[] = [];

  for (const element of childElements(document.root)) {
    if (!isCatalogElementName(element.name)) {
      unrecognizedElements.push(element.name);
      continue;
    }

    entries.push({
      ctype: element.name,
      domain: domainFromElementName(element.name),
      id: attributeValue(element, 'id') ?? null,
      parent: attributeValue(element, 'parent') ?? null,
      isDefault: attributeValue(element, 'default') === '1',
      fields: childElements(element).map(toField),
      span: element.span,
      sourcePath,
      layer,
      origin,
      line: lineAt(document.source, element.span.start),
    });
  }

  return { path: sourcePath, layer, origin, entries, unrecognizedElements };
}

/**
 * A field's addressable path, e.g. `LifeMax`, `FlagArray[ArmySelect]`, `WeaponArray[0]`.
 *
 * This is the form `sc2_patch_catalog_object` will accept, so it must be unambiguous:
 * arrays are always bracketed, even when indexed by a token rather than a number.
 * XPath is deliberately not the public addressing scheme (PLAN.md §18).
 */
export function fieldPath(field: CatalogField, prefix = ''): string {
  const base = field.index === null ? field.name : `${field.name}[${field.index}]`;
  return prefix === '' ? base : `${prefix}.${base}`;
}

/** Depth-first walk of a field tree, yielding each field with its addressable path. */
export function* walkFields(
  fields: readonly CatalogField[],
  prefix = '',
): Generator<{ path: string; field: CatalogField }> {
  for (const field of fields) {
    const currentPath = fieldPath(field, prefix);
    yield { path: currentPath, field };
    yield* walkFields(field.children, currentPath);
  }
}
