/**
 * Catalog field addressing (PLAN.md §18).
 *
 * Fields are named the way they read in the data: `LifeMax`, `FlagArray[ArmySelect]`,
 * `WeaponArray[0]`, `CardLayouts[0].LayoutButtons[3]`. Array elements are always
 * bracketed, whether the index is a number or a token, so a path is unambiguous.
 *
 * XPath is deliberately not the public addressing scheme. It would let a caller express
 * things the data model cannot represent, and it makes the safety analysis ("which object
 * does this touch?") impossible to do reliably.
 */

import { SC2Error } from '../errors.js';
import { childElements, type XmlElement } from '../xml/parse.js';

export interface FieldPathSegment {
  readonly name: string;
  /** `null` when the segment addresses a plain field rather than an array element. */
  readonly index: string | null;
}

const SEGMENT_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]]*)\])?$/;

/**
 * Parses a field path into segments.
 *
 * @throws SC2Error `SC2_INVALID_ARGUMENT` for anything malformed — a path that "sort of"
 * parses would silently address the wrong field.
 */
export function parseFieldPath(fieldPath: string): FieldPathSegment[] {
  if (typeof fieldPath !== 'string' || fieldPath.trim() === '') {
    throw new SC2Error('SC2_INVALID_ARGUMENT', 'Field path must be a non-empty string.', { recoverable: true });
  }

  const segments: FieldPathSegment[] = [];
  for (const rawSegment of fieldPath.split('.')) {
    const match = SEGMENT_PATTERN.exec(rawSegment);
    if (match === null) {
      throw new SC2Error(
        'SC2_INVALID_ARGUMENT',
        `Not a valid field path segment: "${rawSegment}" in "${fieldPath}".`,
        {
          recoverable: true,
          suggestedAction: 'Use names like "LifeMax", "FlagArray[ArmySelect]", or "CardLayouts[0].LayoutButtons[1]".',
        },
      );
    }
    segments.push({ name: match[1] ?? '', index: match[2] ?? null });
  }

  return segments;
}

export function formatFieldPath(segments: readonly FieldPathSegment[]): string {
  return segments.map((segment) => (segment.index === null ? segment.name : `${segment.name}[${segment.index}]`)).join('.');
}

/** Matches an element against one path segment. */
function matchesSegment(element: XmlElement, segment: FieldPathSegment): boolean {
  if (element.name !== segment.name) return false;
  const index = element.attributes.find((attribute) => attribute.name === 'index')?.value ?? null;
  return index === segment.index;
}

export interface FieldLookup {
  /** The addressed element, or `null` when it does not exist yet. */
  readonly element: XmlElement | null;
  /** The element that would hold it — where a `set` on a missing field creates it. */
  readonly parent: XmlElement;
  /** Segments resolved so far; shorter than the request when the path breaks partway. */
  readonly resolvedSegments: FieldPathSegment[];
}

/**
 * Walks a field path from a catalog entry element.
 *
 * Returns the deepest parent it reached rather than failing outright, so a caller can
 * distinguish "the field does not exist yet" (createable) from "the path is wrong"
 * (an intermediate segment is missing).
 */
export function lookupField(entryElement: XmlElement, segments: readonly FieldPathSegment[]): FieldLookup {
  let parent = entryElement;
  const resolved: FieldPathSegment[] = [];

  for (const [index, segment] of segments.entries()) {
    const match = childElements(parent).find((child) => matchesSegment(child, segment));
    if (match === undefined) return { element: null, parent, resolvedSegments: resolved };

    resolved.push(segment);
    if (index === segments.length - 1) return { element: match, parent, resolvedSegments: resolved };
    parent = match;
  }

  return { element: null, parent, resolvedSegments: resolved };
}

/**
 * The next free numeric index in an array field.
 *
 * SC2 array fields indexed by number are dense and zero-based; appending means taking
 * `max + 1`. Token-indexed entries (`FlagArray[ArmySelect]`) are ignored here — they are
 * not positional and cannot be appended to.
 */
export function nextArrayIndex(parent: XmlElement, fieldName: string): number {
  let highest = -1;
  for (const child of childElements(parent, fieldName)) {
    const index = child.attributes.find((attribute) => attribute.name === 'index')?.value;
    if (index === undefined) continue;
    const parsed = Number.parseInt(index, 10);
    if (Number.isSafeInteger(parsed) && parsed > highest) highest = parsed;
  }
  return highest + 1;
}
