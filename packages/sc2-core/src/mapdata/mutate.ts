/**
 * Writing the Regions and Objects components (PLAN.md §27, §28).
 *
 * Both are XML, so edits go through {@link XmlEditor} and touch only the bytes they
 * address — the rest of a 26 KB Objects file comes back byte-identical.
 *
 * Shapes here follow real editor output rather than a guess: `<region id="N">` with a
 * `<shape type="circle">` carrying `<center>`/`<radius>`, and `<ObjectUnit Id="…"
 * Position="x,y,z">` with `<Flag Index="…" Value="…"/>` children. Positions stay as text
 * because the file's own precision is meaningful and reformatting them would be a silent
 * change (PLAN.md §12).
 */

import { SC2Error } from '../errors.js';
import { XmlEditor, indentationBefore } from '../xml/edit.js';
import { attributeValue, childElements, escapeAttribute, parseXml, type XmlElement } from '../xml/parse.js';
import { OBJECTS_FILENAME, REGIONS_FILENAME, typeAttributeFor } from './objects.js';

/** Largest value SC2 ids are observed to occupy: they are positive signed 32-bit. */
const MAX_ID = 2_147_483_647;

export interface MutationOutcome {
  readonly content: string;
  readonly summary: string[];
}

/** The indentation one level in from `element`, matching whatever the file already uses. */
function childIndent(source: string, parent: XmlElement): string {
  const firstChild = childElements(parent)[0];
  if (firstChild !== undefined) return indentationBefore(source, firstChild.span.start);
  return indentationBefore(source, parent.span.start) + '    ';
}

/**
 * Allocates an id that is free in this document.
 *
 * Deterministic on purpose — `max + 1` rather than a random draw — so the same edit applied
 * twice produces the same bytes. Falls back to scanning for a gap only when the top of the
 * range is already taken, which no real map comes close to.
 */
function allocateId(used: ReadonlySet<number>, start: number): number {
  let candidate = 0;
  for (const value of used) if (value > candidate) candidate = value;
  candidate = Math.max(candidate + 1, start);

  if (candidate <= MAX_ID) return candidate;
  for (let probe = start; probe <= MAX_ID; probe += 1) {
    if (!used.has(probe)) return probe;
  }
  throw new SC2Error('SC2_UNSUPPORTED_OPERATION', 'No free id remains in this document.', { recoverable: false });
}

function parseRoot(source: string, expected: string, filename: string): XmlElement {
  const document = parseXml(source, { path: filename });
  if (document.root?.name !== expected) {
    throw new SC2Error('SC2_PARSE_ERROR', `${filename} must have a <${expected}> root element.`, {
      path: filename,
      recoverable: false,
      context: { foundRoot: document.root?.name ?? null },
    });
  }
  return document.root;
}

// ---------------------------------------------------------------------------- regions

export interface RegionShape {
  /** `circle` and `rect` are what the editor writes; anything else is passed through. */
  readonly type: string;
  /** Shape parameters as text, e.g. `{ center: '10,20', radius: '5' }`. */
  readonly values: Readonly<Record<string, string>>;
}

export interface CreateRegionInput {
  readonly name: string;
  readonly shape: RegionShape;
  /** `<invisible/>`-style childless markers to carry. */
  readonly markers?: readonly string[] | undefined;
}

function usedRegionIds(root: XmlElement): Set<number> {
  const used = new Set<number>();
  for (const element of childElements(root, 'region')) {
    const parsed = Number.parseInt(attributeValue(element, 'id') ?? '', 10);
    if (Number.isSafeInteger(parsed)) used.add(parsed);
  }
  return used;
}

function findRegion(root: XmlElement, id: string): XmlElement | null {
  for (const element of childElements(root, 'region')) {
    if (attributeValue(element, 'id') === id) return element;
  }
  return null;
}

function renderRegion(id: number, input: CreateRegionInput, indent: string, newline: string): string {
  const inner = indent + '    ';
  const shapeInner = inner + '    ';
  const lines = [
    `<region id="${id}">`,
    `${inner}<name value="${escapeAttribute(input.name)}"/>`,
    ...(input.markers ?? []).map((marker) => `${inner}<${marker}/>`),
    `${inner}<shape type="${escapeAttribute(input.shape.type)}">`,
    ...Object.entries(input.shape.values).map(([key, value]) => `${shapeInner}<${key} value="${escapeAttribute(value)}"/>`),
    `${inner}</shape>`,
    `${indent}</region>`,
  ];
  return lines.join(newline);
}

export function createRegion(source: string, input: CreateRegionInput): MutationOutcome {
  const root = parseRoot(source, 'Regions', REGIONS_FILENAME);
  // Region ids are small and sequential in editor output, so they start at 1.
  const id = allocateId(usedRegionIds(root), 1);

  const editor = new XmlEditor(source);
  const indent = childIndent(source, root);
  editor.appendChild(root, renderRegion(id, input, indent, editor.newline), `create region ${id}`);

  return {
    content: editor.apply(),
    summary: [`created region ${id} "${input.name}" as ${input.shape.type}`],
  };
}

export interface UpdateRegionInput {
  readonly name?: string | undefined;
  readonly shape?: RegionShape | undefined;
}

export function updateRegion(source: string, id: string, input: UpdateRegionInput): MutationOutcome {
  const root = parseRoot(source, 'Regions', REGIONS_FILENAME);
  const region = findRegion(root, id);
  if (region === null) {
    throw new SC2Error('SC2_NOT_FOUND', `${REGIONS_FILENAME} has no region with id ${id}.`, {
      path: REGIONS_FILENAME,
      objectId: id,
      recoverable: true,
    });
  }

  const editor = new XmlEditor(source);
  const summary: string[] = [];

  if (input.name !== undefined) {
    const nameElement = childElements(region, 'name')[0];
    if (nameElement === undefined) {
      editor.appendChild(region, `<name value="${escapeAttribute(input.name)}"/>`, 'set region name');
    } else {
      editor.setAttributeValue(nameElement, 'value', input.name);
    }
    summary.push(`set region ${id} name = ${input.name}`);
  }

  if (input.shape !== undefined) {
    const shapeElement = childElements(region, 'shape')[0];
    if (shapeElement === undefined) {
      throw new SC2Error('SC2_UNSUPPORTED_OPERATION', `Region ${id} has no <shape> to update.`, {
        path: REGIONS_FILENAME,
        objectId: id,
        recoverable: true,
        suggestedAction: 'Delete the region and create it again with the shape you want.',
      });
    }

    const currentType = attributeValue(shapeElement, 'type');
    if (currentType !== input.shape.type) {
      // Changing the shape kind means different parameter children; refuse rather than
      // leave a circle carrying a rectangle's fields.
      throw new SC2Error('SC2_UNSUPPORTED_OPERATION', `Region ${id} is a "${currentType ?? '?'}"; changing it to "${input.shape.type}" is not supported.`, {
        path: REGIONS_FILENAME,
        objectId: id,
        recoverable: true,
        suggestedAction: 'Delete the region and create it again with the shape you want.',
      });
    }

    for (const [key, value] of Object.entries(input.shape.values)) {
      const child = childElements(shapeElement, key)[0];
      if (child === undefined) {
        editor.appendChild(shapeElement, `<${key} value="${escapeAttribute(value)}"/>`, `set ${key}`);
      } else {
        editor.setAttributeValue(child, 'value', value);
      }
      summary.push(`set region ${id} ${key} = ${value}`);
    }
  }

  if (editor.isEmpty) return { content: source, summary: [] };
  return { content: editor.apply(), summary };
}

export function deleteRegion(source: string, id: string): MutationOutcome {
  const root = parseRoot(source, 'Regions', REGIONS_FILENAME);
  const region = findRegion(root, id);
  if (region === null) {
    throw new SC2Error('SC2_NOT_FOUND', `${REGIONS_FILENAME} has no region with id ${id}.`, {
      path: REGIONS_FILENAME,
      objectId: id,
      recoverable: true,
    });
  }

  const editor = new XmlEditor(source);
  editor.removeElement(region, `delete region ${id}`);
  return { content: editor.apply(), summary: [`deleted region ${id}`] };
}

// ---------------------------------------------------------------------------- objects

export interface PlaceObjectInput {
  /** `ObjectUnit`, `ObjectPoint`, `ObjectDoodad`, … */
  readonly kind: string;
  /** Catalog or doodad type. Points do not carry one. */
  readonly type?: string | undefined;
  /** `x,y,z` exactly as it should be written. */
  readonly position: string;
  readonly rotation?: string | undefined;
  readonly scale?: string | undefined;
  readonly variation?: string | undefined;
  readonly flags?: Readonly<Record<string, string>> | undefined;
  /** Anything else this model does not name, e.g. `Player`. */
  readonly attributes?: Readonly<Record<string, string>> | undefined;
}

const POSITION_PATTERN = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;

function usedObjectIds(root: XmlElement): Set<number> {
  const used = new Set<number>();
  for (const element of childElements(root)) {
    const parsed = Number.parseInt(attributeValue(element, 'Id') ?? '', 10);
    if (Number.isSafeInteger(parsed)) used.add(parsed);
  }
  return used;
}

function findObject(root: XmlElement, id: string): XmlElement | null {
  for (const element of childElements(root)) {
    if (attributeValue(element, 'Id') === id) return element;
  }
  return null;
}

export function placeObject(source: string, input: PlaceObjectInput): MutationOutcome {
  if (!POSITION_PATTERN.test(input.position)) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `Position must be "x,y,z"; got "${input.position}".`, {
      path: OBJECTS_FILENAME,
      recoverable: true,
    });
  }

  const root = parseRoot(source, 'PlacedObjects', OBJECTS_FILENAME);
  const id = allocateId(usedObjectIds(root), 1);

  const attributes = [`Id="${id}"`];
  if (input.variation !== undefined) attributes.push(`Variation="${escapeAttribute(input.variation)}"`);
  attributes.push(`Position="${escapeAttribute(input.position)}"`);
  if (input.rotation !== undefined) attributes.push(`Rotation="${escapeAttribute(input.rotation)}"`);
  if (input.scale !== undefined) attributes.push(`Scale="${escapeAttribute(input.scale)}"`);
  // Units name their type with `UnitType`; points and doodads use `Type`.
  if (input.type !== undefined) {
    attributes.push(`${typeAttributeFor(input.kind)}="${escapeAttribute(input.type)}"`);
  }
  for (const [name, value] of Object.entries(input.attributes ?? {})) {
    attributes.push(`${name}="${escapeAttribute(value)}"`);
  }

  const editor = new XmlEditor(source);
  const flags = Object.entries(input.flags ?? {});
  const indent = childIndent(source, root);

  const rendered =
    flags.length === 0
      ? `<${input.kind} ${attributes.join(' ')}/>`
      : [
          `<${input.kind} ${attributes.join(' ')}>`,
          ...flags.map(([index, value]) => `${indent}    <Flag Index="${escapeAttribute(index)}" Value="${escapeAttribute(value)}"/>`),
          `${indent}</${input.kind}>`,
        ].join(editor.newline);

  editor.appendChild(root, rendered, `place ${input.kind} ${id}`);

  return {
    content: editor.apply(),
    summary: [`placed ${input.kind} ${id}${input.type === undefined ? '' : ` (${input.type})`} at ${input.position}`],
  };
}

export interface UpdateObjectInput {
  readonly position?: string | undefined;
  readonly rotation?: string | undefined;
  readonly scale?: string | undefined;
}

export function updateObject(source: string, id: string, input: UpdateObjectInput): MutationOutcome {
  if (input.position !== undefined && !POSITION_PATTERN.test(input.position)) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `Position must be "x,y,z"; got "${input.position}".`, {
      path: OBJECTS_FILENAME,
      recoverable: true,
    });
  }

  const root = parseRoot(source, 'PlacedObjects', OBJECTS_FILENAME);
  const object = findObject(root, id);
  if (object === null) {
    throw new SC2Error('SC2_NOT_FOUND', `${OBJECTS_FILENAME} has no object with Id ${id}.`, {
      path: OBJECTS_FILENAME,
      objectId: id,
      recoverable: true,
    });
  }

  const editor = new XmlEditor(source);
  const summary: string[] = [];

  for (const [name, value] of [
    ['Position', input.position],
    ['Rotation', input.rotation],
    ['Scale', input.scale],
  ] as const) {
    if (value === undefined) continue;
    const previous = attributeValue(object, name);
    if (previous === value) continue;
    if (previous === undefined) editor.addAttribute(object, name, value);
    else editor.setAttributeValue(object, name, value);
    summary.push(`set object ${id} ${name} = ${value}`);
  }

  if (editor.isEmpty) return { content: source, summary: [] };
  return { content: editor.apply(), summary };
}

export function deleteObject(source: string, id: string): MutationOutcome {
  const root = parseRoot(source, 'PlacedObjects', OBJECTS_FILENAME);
  const object = findObject(root, id);
  if (object === null) {
    throw new SC2Error('SC2_NOT_FOUND', `${OBJECTS_FILENAME} has no object with Id ${id}.`, {
      path: OBJECTS_FILENAME,
      objectId: id,
      recoverable: true,
    });
  }

  const kind = object.name;
  const editor = new XmlEditor(source);
  editor.removeElement(object, `delete object ${id}`);
  return { content: editor.apply(), summary: [`deleted ${kind} ${id}`] };
}
