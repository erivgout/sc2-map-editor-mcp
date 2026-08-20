import { SC2Error } from '../errors.js';
import { XmlEditor } from '../xml/edit.js';
import { attributeValue, childElements, parseXml, type XmlElement } from '../xml/parse.js';

export const MAP_INFO_FILENAME = 'MapInfo';
export const ATTRIBUTES_FILENAME = 'Attributes';

export interface MapInfoPlayer {
  readonly controller: number;
  readonly controlType: number;
  readonly team: number;
  readonly aiName: string;
  readonly colorIndex: number;
  readonly startLocation: number;
  readonly resourceFlags: number;
  readonly aiPersonality: string;
}

export interface ParsedMapInfo {
  readonly version: number;
  readonly width: number;
  readonly height: number;
  readonly players: readonly MapInfoPlayer[];
}

interface LocatedPlayer extends MapInfoPlayer {
  readonly start: number;
  readonly end: number;
}

interface LocatedMapInfo extends ParsedMapInfo {
  readonly playerCountOffset: number;
  readonly playersEnd: number;
  readonly players: readonly LocatedPlayer[];
}

class BinaryReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  position = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  require(length: number): void {
    if (length < 0 || this.position + length > this.bytes.byteLength) {
      throw new SC2Error('SC2_PARSE_ERROR', `MapInfo ended unexpectedly at byte ${this.position}.`, {
        path: MAP_INFO_FILENAME,
        recoverable: false,
      });
    }
  }

  skip(length: number): void {
    this.require(length);
    this.position += length;
  }

  u8(): number {
    this.require(1);
    return this.view.getUint8(this.position++);
  }

  u16(): number {
    this.require(2);
    const value = this.view.getUint16(this.position, true);
    this.position += 2;
    return value;
  }

  u32(): number {
    this.require(4);
    const value = this.view.getUint32(this.position, true);
    this.position += 4;
    return value;
  }

  i32(): number {
    this.require(4);
    const value = this.view.getInt32(this.position, true);
    this.position += 4;
    return value;
  }

  cstring(): string {
    const start = this.position;
    while (this.position < this.bytes.byteLength && this.bytes[this.position] !== 0) this.position += 1;
    this.require(1);
    const value = new TextDecoder().decode(this.bytes.subarray(start, this.position));
    this.position += 1;
    return value;
  }

  lpstring(): string {
    const length = this.u16();
    this.require(length);
    const value = new TextDecoder().decode(this.bytes.subarray(this.position, this.position + length));
    this.position += length;
    return value;
  }
}

function boundedCount(value: number, maximum: number, label: string): number {
  if (value > maximum) {
    throw new SC2Error('SC2_PARSE_ERROR', `${label} ${value} exceeds the supported maximum ${maximum}.`, {
      path: MAP_INFO_FILENAME,
      recoverable: false,
    });
  }
  return value;
}

function skipDwordArray(reader: BinaryReader, label: string): void {
  reader.skip(boundedCount(reader.u32(), 256, label) * 4);
}

function skipBitSet(reader: BinaryReader, label: string): void {
  reader.u32();
  const innerCount = boundedCount(reader.u32(), 256, label);
  reader.skip(Math.ceil(innerCount / 8));
}

function locateMapInfo(content: Uint8Array): LocatedMapInfo {
  const reader = new BinaryReader(content);
  reader.require(8);
  if (
    content[0] !== 0x49 ||
    content[1] !== 0x70 ||
    content[2] !== 0x61 ||
    content[3] !== 0x4d
  ) {
    throw new SC2Error('SC2_PARSE_ERROR', 'MapInfo has the wrong magic signature.', {
      path: MAP_INFO_FILENAME,
      recoverable: false,
    });
  }
  reader.position = 4;
  const version = reader.u32();
  if (version !== 39) {
    throw new SC2Error('SC2_UNSUPPORTED_OPERATION', `MapInfo player editing currently supports version 39, not ${version}.`, {
      path: MAP_INFO_FILENAME,
      recoverable: false,
      suggestedAction: 'Save the map with Galaxy Editor 5.0.16 or add a version-specific MapInfo reader.',
    });
  }

  reader.skip(8); // integrity hash
  const width = reader.u32();
  const height = reader.u32();
  const localeMode = reader.u32();
  if (localeMode === 2) reader.cstring();
  const previewImageType = reader.u32();
  if (previewImageType === 2) reader.cstring();
  reader.cstring(); // minimap image
  reader.cstring(); // hover image
  reader.skip(8); // minimap resolution, difficulty
  reader.cstring(); // fog mask style
  reader.cstring(); // map description
  reader.skip(20); // playable bounds, base height
  reader.u32(); // loading screen type
  reader.cstring(); // loading image
  reader.lpstring(); // loading bar
  reader.skip(24); // scale, anchor, offsets, dimensions
  reader.cstring(); // custom layout
  reader.lpstring(); // layout locale key
  reader.lpstring(); // reserved version 39 string
  reader.skip(24); // flags and simulation fields
  reader.skip(1); // speed-below mode
  const authorCount = boundedCount(reader.u32(), 999, 'MapInfo author count');
  for (let index = 0; index < authorCount; index += 1) {
    reader.cstring();
    reader.skip(12);
  }
  reader.lpstring(); // loading music

  const playerCountOffset = reader.position;
  const playerCount = boundedCount(reader.u32(), 16, 'MapInfo player count');
  const players: LocatedPlayer[] = [];
  for (let index = 0; index < playerCount; index += 1) {
    const start = reader.position;
    const controller = reader.u8();
    const controlType = reader.i32();
    if (controlType < 0 || controlType > 4) {
      throw new SC2Error('SC2_PARSE_ERROR', `MapInfo player ${index} has invalid control type ${controlType}.`, {
        path: MAP_INFO_FILENAME,
        recoverable: false,
      });
    }
    const team = reader.i32();
    const aiName = reader.cstring();
    const colorIndex = reader.i32();
    const startLocation = reader.i32();
    const resourceFlags = reader.u32();
    const aiPersonality = reader.cstring();
    players.push({
      start,
      end: reader.position,
      controller,
      controlType,
      team,
      aiName,
      colorIndex,
      startLocation,
      resourceFlags,
      aiPersonality,
    });
  }
  const playersEnd = reader.position;

  skipDwordArray(reader, 'MapInfo start-location array');
  skipBitSet(reader, 'MapInfo alliance bitset');
  skipDwordArray(reader, 'MapInfo team-slot array');
  const teamCount = boundedCount(reader.u32(), 255, 'MapInfo team count');
  reader.skip(teamCount * 4);
  skipBitSet(reader, 'MapInfo enemy bitset');
  const lightingType = reader.u32();
  if (lightingType === 1 || lightingType === 3) reader.skip(8);
  else if (lightingType === 2) reader.skip(4);
  reader.skip(20); // camera type and rectangle

  if (reader.position !== content.byteLength) {
    throw new SC2Error('SC2_PARSE_ERROR', `MapInfo has ${content.byteLength - reader.position} trailing byte(s).`, {
      path: MAP_INFO_FILENAME,
      recoverable: false,
    });
  }

  return { version, width, height, playerCountOffset, playersEnd, players };
}

export function parseMapInfo(content: Uint8Array): ParsedMapInfo {
  const parsed = locateMapInfo(content);
  return {
    version: parsed.version,
    width: parsed.width,
    height: parsed.height,
    players: parsed.players.map(({ start: _start, end: _end, ...player }) => player),
  };
}

function syntheticUserEntry(controller: number): Uint8Array {
  const content = new Uint8Array(23);
  const view = new DataView(content.buffer);
  content[0] = controller;
  view.setInt32(1, 1, true);
  view.setInt32(5, -1, true);
  return content;
}

function userEntry(content: Uint8Array, template: LocatedPlayer | undefined, controller: number): Uint8Array {
  if (template === undefined) return syntheticUserEntry(controller);
  const entry = Uint8Array.from(content.subarray(template.start, template.end));
  const view = new DataView(entry.buffer);
  entry[0] = controller;
  view.setInt32(1, 1, true);
  view.setInt32(5, -1, true);
  return entry;
}

export interface SetMapPlayerSlotsOptions {
  readonly maxPlayers: number;
  readonly removeComputerPlayers?: boolean;
}

export interface MapInfoMutationOutcome {
  readonly content: Uint8Array;
  readonly before: ParsedMapInfo;
  readonly after: ParsedMapInfo;
  readonly summary: readonly string[];
}

export function setMapPlayerSlots(content: Uint8Array, options: SetMapPlayerSlotsOptions): MapInfoMutationOutcome {
  if (!Number.isInteger(options.maxPlayers) || options.maxPlayers < 1 || options.maxPlayers > 14) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', 'maxPlayers must be an integer from 1 through 14.', {
      path: MAP_INFO_FILENAME,
      recoverable: true,
    });
  }
  const located = locateMapInfo(content);
  const before = parseMapInfo(content);
  const template = located.players.find((player) => player.controlType === 1);
  const neutral = located.players.filter((player) => player.controlType === 3);
  const computers = located.players.filter((player) => player.controlType === 2);
  const hostile = located.players.filter((player) => player.controlType === 4);
  const preservedComputers = options.removeComputerPlayers === true ? [] : computers;
  const entries = [
    ...neutral.map((player) => content.subarray(player.start, player.end)),
    ...Array.from({ length: options.maxPlayers }, (_, index) => userEntry(content, template, index + 1)),
    ...preservedComputers.map((player) => content.subarray(player.start, player.end)),
    ...hostile.map((player) => content.subarray(player.start, player.end)),
  ];
  if (entries.length > 16) {
    throw new SC2Error('SC2_LIMIT_EXCEEDED', `The requested slot layout would contain ${entries.length} MapInfo players.`, {
      path: MAP_INFO_FILENAME,
      recoverable: true,
      suggestedAction: 'Remove computer players or request fewer human slots.',
    });
  }

  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, entries.length, true);
  const output = new Uint8Array(
    content.subarray(0, located.playerCountOffset).byteLength +
      count.byteLength +
      entries.reduce((total, entry) => total + entry.byteLength, 0) +
      content.subarray(located.playersEnd).byteLength,
  );
  let offset = 0;
  for (const part of [content.subarray(0, located.playerCountOffset), count, ...entries, content.subarray(located.playersEnd)]) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  const after = parseMapInfo(output);
  return {
    content: output,
    before,
    after,
    summary: [
      `set MapInfo human player slots to 1-${options.maxPlayers}`,
      options.removeComputerPlayers === true
        ? `removed ${computers.length} computer player slot(s)`
        : `preserved ${computers.length} computer player slot(s)`,
    ],
  };
}

function valueChild(parent: XmlElement, childName: string): string | null {
  const child = childElements(parent, childName)[0];
  return child === undefined ? null : (attributeValue(child, 'Value') ?? null);
}

export interface AttributeSlotsMutationOutcome {
  readonly content: string;
  readonly summary: readonly string[];
}

/** Keeps the Player attribute defaults aligned with zero-based MapInfo human slots. */
export function setPlayerAttributeSlots(source: string, maxPlayers: number): AttributeSlotsMutationOutcome {
  if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 14) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', 'maxPlayers must be an integer from 1 through 14.', {
      path: ATTRIBUTES_FILENAME,
      recoverable: true,
    });
  }
  const document = parseXml(source, { path: ATTRIBUTES_FILENAME });
  if (document.root?.name !== 'Attributes') {
    throw new SC2Error('SC2_PARSE_ERROR', 'Attributes must have an <Attributes> root.', {
      path: ATTRIBUTES_FILENAME,
      recoverable: false,
    });
  }
  const playerAttribute = childElements(document.root, 'Attribute').find(
    (attribute) => valueChild(attribute, 'Type') === 'Player',
  );
  if (playerAttribute === undefined) {
    throw new SC2Error('SC2_NOT_FOUND', 'Attributes has no Player attribute definition.', {
      path: ATTRIBUTES_FILENAME,
      recoverable: false,
    });
  }
  const editor = new XmlEditor(source);
  const present = new Set<number>();
  let valueId = '1';
  for (const entry of childElements(playerAttribute, 'Default')) {
    const slotElement = childElements(entry, 'Slot')[0];
    const valueElement = childElements(entry, 'Value')[0];
    const slotText = slotElement === undefined ? null : attributeValue(slotElement, 'Id');
    const slot = slotText === null ? Number.NaN : Number(slotText);
    if (valueElement !== undefined) valueId = attributeValue(valueElement, 'Id') ?? valueId;
    if (!Number.isInteger(slot)) continue;
    if (slot >= maxPlayers) editor.removeElement(entry, `remove Player attribute default for slot ${slot}`);
    else present.add(slot);
  }
  for (let slot = 0; slot < maxPlayers; slot += 1) {
    if (present.has(slot)) continue;
    editor.appendChild(
      playerAttribute,
      `<Default>${editor.newline}            <Slot Id="${slot}"/>${editor.newline}            <Value Id="${valueId}"/>${editor.newline}        </Default>`,
      `add Player attribute default for slot ${slot}`,
    );
  }
  const content = editor.apply();
  parseXml(content, { path: ATTRIBUTES_FILENAME });
  return { content, summary: [`set Attributes Player defaults to slots 0-${maxPlayers - 1}`] };
}
