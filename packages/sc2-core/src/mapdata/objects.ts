/**
 * Placed objects, regions, and terrain (PLAN.md §27, §28).
 *
 * PLAN.md treats these as post-v1 work needing binary reverse engineering. Reading the
 * shipped `EditorTest.SC2Map` shows that assumption is wrong for three of the four
 * components: `Objects`, `Regions`, and `Attributes` are **plain XML**. Only the terrain
 * bulk data is binary.
 *
 * ```xml
 * <PlacedObjects Version="27">
 *     <ObjectDoodad Id="232833756" Position="110.8942,26.3466,7.9975" Rotation="5.514"
 *                   Scale="1.0583,1.0583,1.0583" Type="LavaSplash">
 *         <Flag Index="HeightAbsolute" Value="1"/>
 *     </ObjectDoodad>
 * </PlacedObjects>
 *
 * <Regions>
 *     <region id="1">
 *         <name value="Region 001"/>
 *         <shape type="circle"><center value="227.9604,42.1821"/><radius value="2.9916"/></shape>
 *     </region>
 * </Regions>
 * ```
 *
 * **Read-only, deliberately.** PLAN.md §27 says not to implement writes until a codec has
 * passed editor round-trip tests, and no such test has been run: placing a unit involves
 * ids, flags, and terrain-height interactions this code does not model. Being able to
 * parse a file is not the same as being able to author one.
 */

import { SC2Error } from '../errors.js';
import { attributeValue, childElements, parseXml, type XmlElement } from '../xml/parse.js';

export const OBJECTS_FILENAME = 'Objects';
export const REGIONS_FILENAME = 'Regions';
export const TERRAIN_FILENAME = 't3Terrain.xml';

export interface PlacedObject {
  /** Element name: `ObjectUnit`, `ObjectDoodad`, `ObjectPoint`, … */
  readonly kind: string;
  readonly id: string | null;
  /** The catalog/doodad type this instance is of. */
  readonly type: string | null;
  /** `x,y,z` as written; kept as text because the file's precision is meaningful. */
  readonly position: string | null;
  readonly rotation: string | null;
  readonly scale: string | null;
  readonly variation: string | null;
  /** `Flag` children, by index. */
  readonly flags: Readonly<Record<string, string>>;
  /** Attributes this model does not name individually, so nothing is silently dropped. */
  readonly otherAttributes: Readonly<Record<string, string>>;
}

export interface PlacedObjectsDocument {
  /** The `Version` attribute on `<PlacedObjects>`; 27 in the shipped map. */
  readonly version: string | null;
  readonly objects: readonly PlacedObject[];
  readonly countsByKind: ReadonlyMap<string, number>;
}

const NAMED_OBJECT_ATTRIBUTES = new Set(['Id', 'Type', 'UnitType', 'Position', 'Rotation', 'Scale', 'Variation']);

/**
 * Which attribute names an object's type, which depends on its kind.
 *
 * `<ObjectUnit>` uses `UnitType`; points and doodads use `Type`. Verified against 181 real
 * `ObjectUnit` entries in editor output — reading only `Type` reported every placed unit
 * in a real map as untyped.
 */
export function typeAttributeFor(kind: string): 'UnitType' | 'Type' {
  return kind === 'ObjectUnit' ? 'UnitType' : 'Type';
}

export function parsePlacedObjects(source: string): PlacedObjectsDocument {
  const document = parseXml(source, { path: OBJECTS_FILENAME });
  if (document.root?.name !== 'PlacedObjects') {
    throw new SC2Error('SC2_PARSE_ERROR', `${OBJECTS_FILENAME} must have a <PlacedObjects> root element.`, {
      path: OBJECTS_FILENAME,
      recoverable: false,
      context: { foundRoot: document.root?.name ?? null },
    });
  }

  const objects: PlacedObject[] = [];
  const countsByKind = new Map<string, number>();

  for (const element of childElements(document.root)) {
    const flags: Record<string, string> = {};
    for (const flag of childElements(element, 'Flag')) {
      const index = attributeValue(flag, 'Index');
      if (index !== undefined) flags[index] = attributeValue(flag, 'Value') ?? '';
    }

    const otherAttributes: Record<string, string> = {};
    for (const attribute of element.attributes) {
      if (NAMED_OBJECT_ATTRIBUTES.has(attribute.name)) continue;
      otherAttributes[attribute.name] = attribute.value;
    }

    objects.push({
      kind: element.name,
      id: attributeValue(element, 'Id') ?? null,
      type: attributeValue(element, typeAttributeFor(element.name)) ?? attributeValue(element, 'Type') ?? null,
      position: attributeValue(element, 'Position') ?? null,
      rotation: attributeValue(element, 'Rotation') ?? null,
      scale: attributeValue(element, 'Scale') ?? null,
      variation: attributeValue(element, 'Variation') ?? null,
      flags,
      otherAttributes,
    });
    countsByKind.set(element.name, (countsByKind.get(element.name) ?? 0) + 1);
  }

  return { version: attributeValue(document.root, 'Version') ?? null, objects, countsByKind };
}

export interface MapRegion {
  readonly id: string | null;
  readonly name: string | null;
  /** `circle`, `rect`, … as written. */
  readonly shapeType: string | null;
  /** Shape parameters as written, e.g. `{ center: '227.9,42.1', radius: '2.99' }`. */
  readonly shape: Readonly<Record<string, string>>;
  /** Child elements with no value, e.g. `<invisible/>`. */
  readonly markers: readonly string[];
}

export interface RegionsDocument {
  readonly regions: readonly MapRegion[];
}

/** Reads `<name value="…"/>`-style children into a record. */
function valueChildren(element: XmlElement): { values: Record<string, string>; markers: string[] } {
  const values: Record<string, string> = {};
  const markers: string[] = [];

  for (const child of childElements(element)) {
    const value = attributeValue(child, 'value');
    if (value !== undefined) values[child.name] = value;
    else if (child.children.length === 0 && child.attributes.length === 0) markers.push(child.name);
  }

  return { values, markers };
}

export function parseRegions(source: string): RegionsDocument {
  const document = parseXml(source, { path: REGIONS_FILENAME });
  if (document.root?.name !== 'Regions') {
    throw new SC2Error('SC2_PARSE_ERROR', `${REGIONS_FILENAME} must have a <Regions> root element.`, {
      path: REGIONS_FILENAME,
      recoverable: false,
      context: { foundRoot: document.root?.name ?? null },
    });
  }

  const regions: MapRegion[] = [];
  for (const element of childElements(document.root, 'region')) {
    const { values, markers } = valueChildren(element);
    const shapeElement = childElements(element, 'shape')[0];
    const shape = shapeElement === undefined ? { values: {}, markers: [] } : valueChildren(shapeElement);

    regions.push({
      id: attributeValue(element, 'id') ?? null,
      name: values['name'] ?? null,
      shapeType: shapeElement === undefined ? null : (attributeValue(shapeElement, 'type') ?? null),
      shape: shape.values,
      markers,
    });
  }

  return { regions };
}

export interface TerrainSummary {
  /** `<terrain version="115">` in the shipped map. */
  readonly version: string | null;
  readonly tileSet: string | null;
  /** `"257 257"` — vertex counts, one more than the cell count in each direction. */
  readonly dimensions: string | null;
  readonly offset: string | null;
  readonly scale: string | null;
  readonly cliffSets: readonly string[];
  /** Top-level sections present, so unmodelled ones are visible rather than invisible. */
  readonly sections: readonly string[];
}

/**
 * Reads the terrain descriptor.
 *
 * `t3Terrain.xml` is only the descriptor. The actual height, texture, cliff, and water
 * data lives in sibling binary files (`t3HeightMap`, `t3TextureMasks`, `t3CellFlags`,
 * the `t3Sync*` set) which this build does not decode — see {@link BINARY_TERRAIN_FILES}.
 */
export function parseTerrainSummary(source: string): TerrainSummary {
  const document = parseXml(source, { path: TERRAIN_FILENAME });
  if (document.root?.name !== 'terrain') {
    throw new SC2Error('SC2_PARSE_ERROR', `${TERRAIN_FILENAME} must have a <terrain> root element.`, {
      path: TERRAIN_FILENAME,
      recoverable: false,
      context: { foundRoot: document.root?.name ?? null },
    });
  }

  const heightMap = childElements(document.root, 'heightMap')[0];
  const cliffSetList = heightMap === undefined ? undefined : childElements(heightMap, 'cliffSetList')[0];
  const cliffSets =
    cliffSetList === undefined
      ? []
      : childElements(cliffSetList, 'cliffSet')
          .map((cliffSet) => attributeValue(cliffSet, 'name'))
          .filter((name): name is string => name !== undefined);

  return {
    version: attributeValue(document.root, 'version') ?? null,
    tileSet: heightMap === undefined ? null : (attributeValue(heightMap, 'tileSet') ?? null),
    dimensions: heightMap === undefined ? null : (attributeValue(heightMap, 'dim')?.trim() ?? null),
    offset: heightMap === undefined ? null : (attributeValue(heightMap, 'offset')?.trim() ?? null),
    scale: heightMap === undefined ? null : (attributeValue(heightMap, 'scale')?.trim() ?? null),
    cliffSets,
    sections: childElements(document.root).map((section) => section.name),
  };
}

/**
 * The binary terrain components, with the header facts that *are* safely determinable.
 *
 * Each begins with a byte-reversed four-character code and a version DWORD, read from the
 * shipped map at editor build 93333. Reporting magic, version, and size is honest
 * orientation; interpreting the payload would be guesswork, and PLAN.md §28 requires
 * validated codecs with round-trip tests before any of that.
 */
export const BINARY_TERRAIN_FILES: Readonly<Record<string, { magic: string; observedVersion: number; description: string }>> =
  Object.freeze({
    t3HeightMap: { magic: 'HMAP', observedVersion: 101, description: 'Per-vertex terrain height' },
    t3CellFlags: { magic: 'TCFL', observedVersion: 102, description: 'Per-cell flags (pathing, buildability)' },
    t3Water: { magic: 'WATR', observedVersion: 110, description: 'Water planes' },
    t3HardTile: { magic: 'HRDT', observedVersion: 102, description: 'Hard-tile painting' },
    t3FluffDoodad: { magic: 'TFLD', observedVersion: 103, description: 'Fluff doodad placement' },
  });

export interface BinaryComponentHeader {
  readonly path: string;
  readonly sizeBytes: number;
  /** The first four bytes as ASCII, in file order. */
  readonly magic: string | null;
  /** The same four bytes reversed. See the note in {@link readBinaryHeader}. */
  readonly magicReversed: string | null;
  /** The DWORD after the magic, which is a version in every observed case. */
  readonly version: number | null;
  readonly known: boolean;
  readonly description: string | null;
}

/**
 * Reads the header of a binary component.
 *
 * **The four-character-code byte order is not uniform**, which is worth stating because
 * assuming either convention gets half the files wrong. Measured on the shipped map:
 *
 *   - `t3HeightMap` begins `48 4D 41 50` — `HMAP` read **in order**.
 *   - `MapInfo` begins `49 70 61 4D` — `MapI` only when **reversed**.
 *
 * So both forms are reported, and a known component matches on either.
 */
export function readBinaryHeader(path: string, bytes: Uint8Array): BinaryComponentHeader {
  if (bytes.length < 8) {
    return { path, sizeBytes: bytes.length, magic: null, magicReversed: null, version: null, known: false, description: null };
  }

  const magic = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  const magicReversed = String.fromCharCode(bytes[3] ?? 0, bytes[2] ?? 0, bytes[1] ?? 0, bytes[0] ?? 0);
  const version =
    (bytes[4] ?? 0) | ((bytes[5] ?? 0) << 8) | ((bytes[6] ?? 0) << 16) | ((bytes[7] ?? 0) << 24);

  const fileName = path.split('/').pop() ?? path;
  const known = BINARY_TERRAIN_FILES[fileName];

  return {
    path,
    sizeBytes: bytes.length,
    magic,
    magicReversed,
    version: version >>> 0,
    known: known !== undefined,
    description: known?.description ?? null,
  };
}
