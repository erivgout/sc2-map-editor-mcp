import { SC2Error } from '../errors.js';
import { XmlEditor, indentationBefore } from '../xml/edit.js';
import { attributeValue, childElements, firstChild, parseXml, type XmlElement } from '../xml/parse.js';
import { TERRAIN_FILENAME } from './objects.js';

export const HEIGHT_MAP_FILENAME = 't3HeightMap';
export const CELL_FLAGS_FILENAME = 't3CellFlags';
export const TEXTURE_MASKS_FILENAME = 't3TextureMasks';
export const SYNC_HEIGHT_MAP_FILENAME = 't3SyncHeightMap';
export const SYNC_CLIFF_LEVEL_FILENAME = 't3SyncCliffLevel';
export const SYNC_TEXTURE_INFO_FILENAME = 't3SyncTextureInfo';

export const TERRAIN_BINARY_FILENAMES = Object.freeze([
  HEIGHT_MAP_FILENAME,
  CELL_FLAGS_FILENAME,
  TEXTURE_MASKS_FILENAME,
  SYNC_HEIGHT_MAP_FILENAME,
  SYNC_CLIFF_LEVEL_FILENAME,
  SYNC_TEXTURE_INFO_FILENAME,
  't3VertCol',
  't3Water',
  't3HardTile',
  't3FluffDoodad',
] as const);

export type TerrainBinaryFilename = (typeof TERRAIN_BINARY_FILENAMES)[number];

export interface TerrainDescriptor {
  readonly version: number;
  readonly width: number;
  readonly height: number;
  readonly offset: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
  readonly quantizeBias: number;
  readonly quantizeScale: number;
  readonly standardHeight: number;
  readonly textureSets: readonly string[];
  readonly textures: readonly string[];
  readonly blockTextureSets: readonly number[];
  readonly cliffCells: ReadonlyMap<number, TerrainCliffCell>;
}

export interface TerrainCliffCell {
  readonly index: number;
  readonly flags: number;
  readonly cliffId: number;
  readonly variation: number;
}

export interface TerrainVertex {
  readonly x: number;
  readonly y: number;
  readonly heightBaseRaw: number;
  readonly heightAdjustmentRaw: number;
  readonly mask: number;
  readonly worldHeight: number;
  readonly syncHeightRaw: number;
  readonly syncHeight: number;
  readonly syncSecondaryRaw: number;
}

export interface TerrainCell {
  readonly x: number;
  readonly y: number;
  readonly flags: number;
  readonly cliffRaw: number;
  readonly cliffLevel: number;
  readonly cliffCellX: number;
  readonly cliffCellY: number;
  readonly descriptorCliff: TerrainCliffCell | null;
  readonly textureWeights: readonly number[];
  readonly textureIndex: number;
  readonly textureField: number;
  readonly activeTextureSet: number;
}

export interface TerrainBinaryMutationOutcome {
  readonly files: readonly { readonly path: string; readonly content: Uint8Array | string }[];
  readonly summary: readonly string[];
}

export interface TerrainValidationIssue {
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly message: string;
}

interface HeightMapHeader {
  readonly width: number;
  readonly height: number;
}

interface GridHeader extends HeightMapHeader {
  readonly dataOffset: number;
}

interface TextureMasksHeader extends GridHeader {
  readonly layerSize: number;
}

interface SyncTextureHeader extends GridHeader {
  readonly version: number;
  readonly setCount: number;
  readonly names: readonly string[];
  readonly cellSize: number;
}

function terrainError(path: string, message: string): never {
  throw new SC2Error('SC2_PARSE_ERROR', `${path}: ${message}`, { path, recoverable: false });
}

function finiteNumber(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) terrainError(TERRAIN_FILENAME, `${label} must be a finite number.`);
  return parsed;
}

function numberList(value: string | undefined, count: number, fallback: readonly number[], label: string): number[] {
  if (value === undefined) return [...fallback];
  const values = value.trim().split(/\s+/).map(Number);
  if (values.length !== count || values.some((entry) => !Number.isFinite(entry))) {
    terrainError(TERRAIN_FILENAME, `${label} must contain ${count} finite numbers.`);
  }
  return values;
}

function requiredChild(parent: XmlElement, name: string): XmlElement {
  const child = firstChild(parent, name);
  if (child === null) terrainError(TERRAIN_FILENAME, `<${parent.name}> is missing <${name}>.`);
  return child;
}

function indexedStrings(parent: XmlElement | null, childName: string, count: number): string[] {
  const result = Array.from({ length: count }, () => '');
  if (parent === null) return result;
  for (const child of childElements(parent, childName)) {
    const index = Number.parseInt(attributeValue(child, 'i') ?? '', 10);
    if (!Number.isInteger(index) || index < 0 || index >= count) continue;
    result[index] = attributeValue(child, 'name') ?? '';
  }
  return result;
}

export function parseTerrainDescriptor(source: string): TerrainDescriptor {
  const document = parseXml(source, { path: TERRAIN_FILENAME });
  if (document.root?.name !== 'terrain') terrainError(TERRAIN_FILENAME, 'root element must be <terrain>.');
  const root = document.root;
  const heightMap = requiredChild(root, 'heightMap');
  const dimensions = numberList(attributeValue(heightMap, 'dim'), 2, [0, 0], 'heightMap dim');
  const width = dimensions[0] ?? 0;
  const height = dimensions[1] ?? 0;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    terrainError(TERRAIN_FILENAME, 'heightMap dimensions must be integers of at least 2 by 2.');
  }

  const vertData = requiredChild(heightMap, 'vertData');
  const textureSets = indexedStrings(firstChild(heightMap, 'textureSetList'), 'textureSet', 8);
  const textures = indexedStrings(firstChild(heightMap, 'textureList'), 'texture', 64);
  const blockTextureSets: number[] = [];
  const blockList = firstChild(heightMap, 'blockTextureSetList');
  if (blockList !== null) {
    for (const entry of childElements(blockList, 'blockTextureSet')) {
      const index = Number.parseInt(attributeValue(entry, 'i') ?? '', 10);
      const tileSet = Number.parseInt(attributeValue(entry, 'tileSet') ?? '', 10);
      if (Number.isInteger(index) && index >= 0 && Number.isInteger(tileSet) && tileSet >= 0) blockTextureSets[index] = tileSet;
    }
  }

  const cliffCells = new Map<number, TerrainCliffCell>();
  const cliffList = firstChild(heightMap, 'cliffCellList');
  if (cliffList !== null) {
    for (const entry of childElements(cliffList, 'cc')) {
      const index = Number.parseInt(attributeValue(entry, 'i') ?? '', 10);
      const flags = Number.parseInt(attributeValue(entry, 'f') ?? '0', 10);
      const cliffId = Number.parseInt(attributeValue(entry, 'cid') ?? '0', 10);
      const variation = Number.parseInt(attributeValue(entry, 'cvar') ?? '0', 10);
      if ([index, flags, cliffId, variation].every(Number.isInteger) && index >= 0) {
        cliffCells.set(index, { index, flags, cliffId, variation });
      }
    }
  }

  const offset = numberList(attributeValue(heightMap, 'offset'), 3, [0, 0, 0], 'heightMap offset');
  const scale = numberList(attributeValue(heightMap, 'scale'), 3, [1, 1, 1], 'heightMap scale');
  return {
    version: finiteNumber(attributeValue(root, 'version'), 115, 'terrain version'),
    width,
    height,
    offset: [offset[0] ?? 0, offset[1] ?? 0, offset[2] ?? 0],
    scale: [scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1],
    quantizeBias: finiteNumber(attributeValue(vertData, 'quantizeBias'), 0, 'quantizeBias'),
    quantizeScale: finiteNumber(attributeValue(vertData, 'quantizeScale'), 0.1, 'quantizeScale'),
    standardHeight: finiteNumber(attributeValue(vertData, 'standardHeight'), 8, 'standardHeight'),
    textureSets,
    textures,
    blockTextureSets,
    cliffCells,
  };
}

function bufferFrom(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function expectMagic(buffer: Buffer, path: string, magic: string): void {
  if (buffer.length < 8) terrainError(path, 'file is shorter than its 8-byte header.');
  const actual = buffer.toString('ascii', 0, 4);
  if (actual !== magic) terrainError(path, `expected magic ${magic}, found ${JSON.stringify(actual)}.`);
}

function expectExactLength(buffer: Buffer, path: string, expected: number): void {
  if (buffer.length !== expected) terrainError(path, `expected ${expected} bytes, found ${buffer.length}.`);
}

function parseHeightMapHeader(bytes: Uint8Array, descriptor?: TerrainDescriptor): HeightMapHeader {
  const buffer = bufferFrom(bytes);
  expectMagic(buffer, HEIGHT_MAP_FILENAME, 'HMAP');
  if (buffer.readUInt32LE(4) !== 101) terrainError(HEIGHT_MAP_FILENAME, `unsupported version ${buffer.readUInt32LE(4)}.`);
  if (buffer.length < 32) terrainError(HEIGHT_MAP_FILENAME, 'file is shorter than its 32-byte header.');
  const width = buffer.readUInt32LE(8);
  const height = buffer.readUInt32LE(12);
  if (descriptor !== undefined && (width !== descriptor.width || height !== descriptor.height)) {
    terrainError(HEIGHT_MAP_FILENAME, `dimensions ${width}x${height} do not match ${TERRAIN_FILENAME} ${descriptor.width}x${descriptor.height}.`);
  }
  expectExactLength(buffer, HEIGHT_MAP_FILENAME, 32 + 6 * width * height);
  return { width, height };
}

function parseCellFlagsHeader(bytes: Uint8Array, descriptor?: TerrainDescriptor): GridHeader {
  const buffer = bufferFrom(bytes);
  expectMagic(buffer, CELL_FLAGS_FILENAME, 'LFCT');
  const version = buffer.readUInt32LE(4);
  if (version < 101 || version > 102) terrainError(CELL_FLAGS_FILENAME, `modern grid version 101 or 102 is required, found ${version}.`);
  if (buffer.length < 32) terrainError(CELL_FLAGS_FILENAME, 'file is shorter than its 32-byte modern header.');
  const width = buffer.readUInt32LE(24);
  const height = buffer.readUInt32LE(28);
  if (descriptor !== undefined && (width !== descriptor.width - 1 || height !== descriptor.height - 1)) {
    terrainError(CELL_FLAGS_FILENAME, `dimensions ${width}x${height} do not match the terrain cell grid.`);
  }
  expectExactLength(buffer, CELL_FLAGS_FILENAME, 32 + width * height);
  return { width, height, dataOffset: 32 };
}

function parseTextureMasksHeader(bytes: Uint8Array): TextureMasksHeader {
  const buffer = bufferFrom(bytes);
  expectMagic(buffer, TEXTURE_MASKS_FILENAME, 'MASK');
  if (buffer.length < 64) terrainError(TEXTURE_MASKS_FILENAME, 'file is shorter than its 64-byte header.');
  const version = buffer.readUInt32LE(4);
  if (version !== 102) terrainError(TEXTURE_MASKS_FILENAME, `writable tiled version 102 is required, found ${version}.`);
  if (buffer.readUInt32LE(8) !== 0) terrainError(TEXTURE_MASKS_FILENAME, 'reserved header field must be zero.');
  const width = buffer.readUInt32LE(12);
  const height = buffer.readUInt32LE(16);
  if (width === 0 || height === 0 || width > 2048 || height > 2048 || width % 64 !== 0 || height % 64 !== 0) {
    terrainError(TEXTURE_MASKS_FILENAME, `invalid tiled dimensions ${width}x${height}.`);
  }
  const layerSize = Math.ceil(width / 64) * Math.ceil(height / 64) * 2048;
  expectExactLength(buffer, TEXTURE_MASKS_FILENAME, 64 + 8 * layerSize);
  return { width, height, dataOffset: 64, layerSize };
}

function parseSyncHeightHeader(bytes: Uint8Array, descriptor?: TerrainDescriptor): GridHeader {
  const buffer = bufferFrom(bytes);
  expectMagic(buffer, SYNC_HEIGHT_MAP_FILENAME, 'SMAP');
  if (buffer.readUInt32LE(4) !== 102) terrainError(SYNC_HEIGHT_MAP_FILENAME, `writable version 102 is required, found ${buffer.readUInt32LE(4)}.`);
  if (buffer.length < 64) terrainError(SYNC_HEIGHT_MAP_FILENAME, 'file is shorter than its 64-byte header.');
  const width = buffer.readUInt32LE(8);
  const height = buffer.readUInt32LE(12);
  if (descriptor !== undefined && (width !== descriptor.width || height !== descriptor.height)) {
    terrainError(SYNC_HEIGHT_MAP_FILENAME, `dimensions ${width}x${height} do not match ${TERRAIN_FILENAME}.`);
  }
  expectExactLength(buffer, SYNC_HEIGHT_MAP_FILENAME, 64 + 4 * width * height);
  return { width, height, dataOffset: 64 };
}

function parseSyncCliffHeader(bytes: Uint8Array, descriptor?: TerrainDescriptor): GridHeader {
  const buffer = bufferFrom(bytes);
  expectMagic(buffer, SYNC_CLIFF_LEVEL_FILENAME, 'CLIF');
  if (buffer.length < 32) terrainError(SYNC_CLIFF_LEVEL_FILENAME, 'file is shorter than its 32-byte header.');
  const width = descriptor?.width === undefined ? Math.sqrt((buffer.length - 32) / 2) : descriptor.width - 1;
  const height = descriptor?.height === undefined ? width : descriptor.height - 1;
  if (!Number.isInteger(width) || !Number.isInteger(height)) terrainError(SYNC_CLIFF_LEVEL_FILENAME, 'grid dimensions cannot be derived.');
  expectExactLength(buffer, SYNC_CLIFF_LEVEL_FILENAME, 32 + 2 * width * height);
  return { width, height, dataOffset: 32 };
}

function readCString(buffer: Buffer, offset: number, path: string): { value: string; next: number } {
  const end = buffer.indexOf(0, offset);
  if (end === -1) terrainError(path, 'unterminated texture name string.');
  return { value: buffer.toString('utf8', offset, end), next: end + 1 };
}

function parseSyncTextureHeader(bytes: Uint8Array, descriptor?: TerrainDescriptor): SyncTextureHeader {
  const buffer = bufferFrom(bytes);
  expectMagic(buffer, SYNC_TEXTURE_INFO_FILENAME, 'RTXT');
  const version = buffer.readUInt32LE(4);
  if (version > 101) terrainError(SYNC_TEXTURE_INFO_FILENAME, `unsupported version ${version}.`);
  if (buffer.length < (version >= 101 ? 20 : 16)) terrainError(SYNC_TEXTURE_INFO_FILENAME, 'file is shorter than its header.');
  const width = buffer.readUInt32LE(8);
  const height = buffer.readUInt32LE(12);
  if (descriptor !== undefined && (width !== descriptor.width - 1 || height !== descriptor.height - 1)) {
    terrainError(SYNC_TEXTURE_INFO_FILENAME, `dimensions ${width}x${height} do not match the terrain cell grid.`);
  }
  const setCount = version >= 101 ? buffer.readUInt32LE(16) : 1;
  if (setCount > 8) terrainError(SYNC_TEXTURE_INFO_FILENAME, `texture-set count ${setCount} exceeds 8.`);
  let cursor = version >= 101 ? 20 : 16;
  const names: string[] = [];
  for (let index = 0; index < setCount * 8; index += 1) {
    const read = readCString(buffer, cursor, SYNC_TEXTURE_INFO_FILENAME);
    names.push(read.value);
    cursor = read.next;
  }
  const cellSize = version >= 101 ? 8 : 4;
  expectExactLength(buffer, SYNC_TEXTURE_INFO_FILENAME, cursor + cellSize * width * height);
  return { version, width, height, setCount, names, dataOffset: cursor, cellSize };
}

function assertCoordinate(x: number, y: number, width: number, height: number, label: string): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `${label} coordinate (${x}, ${y}) is outside 0..${width - 1}, 0..${height - 1}.`, {
      recoverable: true,
      context: { x, y, width, height },
    });
  }
}

function heightCellOffset(header: HeightMapHeader, x: number, y: number): number {
  assertCoordinate(x, y, header.width, header.height, 'Terrain vertex');
  return 32 + 6 * (y * header.width + x);
}

function syncGridOffset(header: GridHeader, x: number, y: number, bytesPerCell: number): number {
  assertCoordinate(x, y, header.width, header.height, 'Terrain cell');
  return header.dataOffset + bytesPerCell * (y * header.width + x);
}

export function readTerrainVertex(
  descriptor: TerrainDescriptor,
  heightMapBytes: Uint8Array,
  syncHeightBytes: Uint8Array,
  x: number,
  y: number,
): TerrainVertex {
  const heightHeader = parseHeightMapHeader(heightMapBytes, descriptor);
  const syncHeader = parseSyncHeightHeader(syncHeightBytes, descriptor);
  const heightMap = bufferFrom(heightMapBytes);
  const syncMap = bufferFrom(syncHeightBytes);
  const offset = heightCellOffset(heightHeader, x, y);
  const syncOffset = syncGridOffset(syncHeader, x, y, 4);
  const heightBaseRaw = heightMap.readUInt16LE(offset);
  const heightAdjustmentRaw = heightMap.readUInt16LE(offset + 2);
  const base = heightBaseRaw * descriptor.quantizeScale - descriptor.quantizeBias;
  const adjustment = heightAdjustmentRaw * descriptor.quantizeScale - descriptor.quantizeBias;
  const worldHeight = base * descriptor.scale[2] + descriptor.offset[2] + adjustment;
  const syncHeightRaw = syncMap.readUInt16LE(syncOffset);
  return {
    x,
    y,
    heightBaseRaw,
    heightAdjustmentRaw,
    mask: heightMap.readUInt16LE(offset + 4),
    worldHeight,
    syncHeightRaw,
    syncHeight: syncHeightRaw / 256,
    syncSecondaryRaw: syncMap.readInt16LE(syncOffset + 2),
  };
}

function uint16(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 0xffff) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `${label} ${value} is outside the uint16 range.`, { recoverable: true });
  }
  return Math.round(value);
}

export function setTerrainVertexHeight(
  descriptor: TerrainDescriptor,
  heightMapBytes: Uint8Array,
  syncHeightBytes: Uint8Array,
  x: number,
  y: number,
  worldHeight: number,
  syncHeight = worldHeight,
): TerrainBinaryMutationOutcome {
  if (!Number.isFinite(worldHeight) || !Number.isFinite(syncHeight)) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', 'Terrain heights must be finite numbers.', { recoverable: true });
  }
  if (descriptor.quantizeScale <= 0 || descriptor.scale[2] === 0) {
    terrainError(TERRAIN_FILENAME, 'quantizeScale and vertical scale must be non-zero for height writes.');
  }
  const heightHeader = parseHeightMapHeader(heightMapBytes, descriptor);
  const syncHeader = parseSyncHeightHeader(syncHeightBytes, descriptor);
  const nextHeight = Buffer.from(heightMapBytes);
  const nextSync = Buffer.from(syncHeightBytes);
  const offset = heightCellOffset(heightHeader, x, y);
  const syncOffset = syncGridOffset(syncHeader, x, y, 4);
  const adjustmentRaw = uint16(descriptor.quantizeBias / descriptor.quantizeScale, 'zero adjustment');
  const adjustment = adjustmentRaw * descriptor.quantizeScale - descriptor.quantizeBias;
  const baseWorld = (worldHeight - descriptor.offset[2] - adjustment) / descriptor.scale[2];
  const baseRaw = uint16((baseWorld + descriptor.quantizeBias) / descriptor.quantizeScale, 'quantized height');
  const syncRaw = uint16(syncHeight * 256, 'synchronized height');

  nextHeight.writeUInt16LE(baseRaw, offset);
  nextHeight.writeUInt16LE(adjustmentRaw, offset + 2);
  nextSync.writeUInt16LE(syncRaw, syncOffset);

  return {
    files: [
      { path: HEIGHT_MAP_FILENAME, content: nextHeight },
      { path: SYNC_HEIGHT_MAP_FILENAME, content: nextSync },
    ],
    summary: [`set terrain vertex (${x}, ${y}) height to ${worldHeight} and synchronized height to ${syncHeight}`],
  };
}

function textureMaskOffset(header: TextureMasksHeader, layer: number, x: number, y: number): { offset: number; high: boolean } {
  assertCoordinate(x, y, header.width, header.height, 'Texture mask');
  if (!Number.isInteger(layer) || layer < 0 || layer >= 8) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `Texture layer ${layer} is outside 0..7.`, { recoverable: true });
  }
  const tilesX = Math.ceil(header.width / 64);
  const tileX = Math.floor(x / 64);
  const tileY = Math.floor(y / 64);
  const inTileX = x % 64;
  const inTileY = y % 64;
  return {
    offset: header.dataOffset + layer * header.layerSize + (tileY * tilesX + tileX) * 2048 + inTileY * 32 + Math.floor(inTileX / 2),
    high: inTileX % 2 === 0,
  };
}

function readTextureWeights(buffer: Buffer, header: TextureMasksHeader, x: number, y: number): number[] {
  const weights: number[] = [];
  for (let layer = 0; layer < 8; layer += 1) {
    const location = textureMaskOffset(header, layer, x, y);
    const packed = buffer[location.offset] ?? 0;
    weights.push(location.high ? packed >> 4 : packed & 0x0f);
  }
  return weights;
}

function writeTextureWeight(buffer: Buffer, header: TextureMasksHeader, layer: number, x: number, y: number, value: number): void {
  const location = textureMaskOffset(header, layer, x, y);
  const current = buffer[location.offset] ?? 0;
  buffer[location.offset] = location.high ? ((value & 0x0f) << 4) | (current & 0x0f) : (current & 0xf0) | (value & 0x0f);
}

function activeTextureSet(descriptor: TerrainDescriptor, x: number, y: number): number {
  const blockWidth = Math.floor((descriptor.width - 1) / 8);
  if (blockWidth <= 0) return 0;
  const blockIndex = Math.floor(y / 8) * blockWidth + Math.floor(x / 8);
  return descriptor.blockTextureSets[blockIndex] ?? 0;
}

export function readTerrainCell(
  descriptor: TerrainDescriptor,
  cellFlagsBytes: Uint8Array,
  textureMaskBytes: Uint8Array,
  syncCliffBytes: Uint8Array,
  syncTextureBytes: Uint8Array,
  x: number,
  y: number,
): TerrainCell {
  const flagsHeader = parseCellFlagsHeader(cellFlagsBytes, descriptor);
  const masksHeader = parseTextureMasksHeader(textureMaskBytes);
  const cliffHeader = parseSyncCliffHeader(syncCliffBytes, descriptor);
  const textureHeader = parseSyncTextureHeader(syncTextureBytes, descriptor);
  assertCoordinate(x, y, flagsHeader.width, flagsHeader.height, 'Terrain cell');
  const scaleX = masksHeader.width / flagsHeader.width;
  const scaleY = masksHeader.height / flagsHeader.height;
  if (!Number.isInteger(scaleX) || !Number.isInteger(scaleY)) terrainError(TEXTURE_MASKS_FILENAME, 'mask dimensions are not an integer multiple of terrain cells.');
  const maskX = Math.min(masksHeader.width - 1, x * scaleX + Math.floor(scaleX / 2));
  const maskY = Math.min(masksHeader.height - 1, y * scaleY + Math.floor(scaleY / 2));
  const cliffOffset = syncGridOffset(cliffHeader, x, y, 2);
  const textureOffset = syncGridOffset(textureHeader, x, y, textureHeader.cellSize);
  const cliffRaw = bufferFrom(syncCliffBytes).readUInt16LE(cliffOffset);
  const cliffCellX = Math.floor(x / 2);
  const cliffCellY = Math.floor(y / 2);
  const cliffGridWidth = Math.floor((descriptor.width - 1) / 2);
  return {
    x,
    y,
    flags: bufferFrom(cellFlagsBytes)[flagsHeader.dataOffset + y * flagsHeader.width + x] ?? 0,
    cliffRaw,
    cliffLevel: Math.min(15, (cliffRaw + 8) >> 4),
    cliffCellX,
    cliffCellY,
    descriptorCliff: descriptor.cliffCells.get(cliffCellY * cliffGridWidth + cliffCellX) ?? null,
    textureWeights: readTextureWeights(bufferFrom(textureMaskBytes), masksHeader, maskX, maskY),
    textureIndex: bufferFrom(syncTextureBytes).readUInt32LE(textureOffset) & 0xff,
    textureField: textureHeader.cellSize === 8 ? bufferFrom(syncTextureBytes).readUInt32LE(textureOffset + 4) : 0,
    activeTextureSet: activeTextureSet(descriptor, x, y),
  };
}

export function setTerrainCellFlags(
  descriptor: TerrainDescriptor,
  bytes: Uint8Array,
  x: number,
  y: number,
  flags: number,
): TerrainBinaryMutationOutcome {
  const header = parseCellFlagsHeader(bytes, descriptor);
  assertCoordinate(x, y, header.width, header.height, 'Terrain cell');
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `Cell flags ${flags} are outside 0..255.`, { recoverable: true });
  }
  const next = Buffer.from(bytes);
  next[header.dataOffset + y * header.width + x] = flags;
  return { files: [{ path: CELL_FLAGS_FILENAME, content: next }], summary: [`set terrain cell (${x}, ${y}) flags to ${flags}`] };
}

export function setTerrainCellTexture(
  descriptor: TerrainDescriptor,
  textureMaskBytes: Uint8Array,
  syncTextureBytes: Uint8Array,
  x: number,
  y: number,
  weights: readonly number[],
  textureIndex?: number,
): TerrainBinaryMutationOutcome {
  if (weights.length !== 8 || weights.some((value) => !Number.isInteger(value) || value < 0 || value > 15)) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', 'Texture weights must contain exactly 8 integers in the range 0..15.', { recoverable: true });
  }
  const masksHeader = parseTextureMasksHeader(textureMaskBytes);
  const syncHeader = parseSyncTextureHeader(syncTextureBytes, descriptor);
  assertCoordinate(x, y, syncHeader.width, syncHeader.height, 'Terrain cell');
  const scaleX = masksHeader.width / syncHeader.width;
  const scaleY = masksHeader.height / syncHeader.height;
  if (!Number.isInteger(scaleX) || !Number.isInteger(scaleY)) terrainError(TEXTURE_MASKS_FILENAME, 'mask dimensions are not an integer multiple of terrain cells.');

  let strongestLayer = 0;
  for (let layer = 1; layer < weights.length; layer += 1) {
    if ((weights[layer] ?? 0) > (weights[strongestLayer] ?? 0)) strongestLayer = layer;
  }
  const selectedTexture = textureIndex ?? activeTextureSet(descriptor, x, y) * 8 + strongestLayer;
  if (!Number.isInteger(selectedTexture) || selectedTexture < 0 || selectedTexture > 255) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `Texture index ${selectedTexture} is outside 0..255.`, { recoverable: true });
  }

  const nextMasks = Buffer.from(textureMaskBytes);
  for (let maskY = y * scaleY; maskY < (y + 1) * scaleY; maskY += 1) {
    for (let maskX = x * scaleX; maskX < (x + 1) * scaleX; maskX += 1) {
      for (let layer = 0; layer < 8; layer += 1) writeTextureWeight(nextMasks, masksHeader, layer, maskX, maskY, weights[layer] ?? 0);
    }
  }

  const nextSync = Buffer.from(syncTextureBytes);
  const syncOffset = syncGridOffset(syncHeader, x, y, syncHeader.cellSize);
  nextSync.writeUInt32LE(selectedTexture, syncOffset);
  return {
    files: [
      { path: TEXTURE_MASKS_FILENAME, content: nextMasks },
      { path: SYNC_TEXTURE_INFO_FILENAME, content: nextSync },
    ],
    summary: [`set terrain cell (${x}, ${y}) texture weights to [${weights.join(', ')}] and sync texture index to ${selectedTexture}`],
  };
}

function setOrAddAttribute(editor: XmlEditor, element: XmlElement, name: string, value: string): void {
  if (element.attributes.some((attribute) => attribute.name === name)) editor.setAttributeValue(element, name, value);
  else editor.addAttribute(element, name, value);
}

function cliffCellList(source: string): { descriptor: TerrainDescriptor; list: XmlElement; cells: XmlElement[] } {
  const descriptor = parseTerrainDescriptor(source);
  const document = parseXml(source, { path: TERRAIN_FILENAME });
  const root = document.root;
  if (root === null) terrainError(TERRAIN_FILENAME, 'root element is missing.');
  const heightMap = requiredChild(root, 'heightMap');
  const list = requiredChild(heightMap, 'cliffCellList');
  return { descriptor, list, cells: childElements(list, 'cc') };
}

export function setTerrainCliffCell(
  descriptorSource: string,
  syncCliffBytes: Uint8Array,
  x: number,
  y: number,
  input: { readonly flags: number; readonly cliffId: number; readonly variation: number; readonly cliffLevel: number },
): TerrainBinaryMutationOutcome {
  const parsed = cliffCellList(descriptorSource);
  const cliffWidth = Math.floor((parsed.descriptor.width - 1) / 2);
  const cliffHeight = Math.floor((parsed.descriptor.height - 1) / 2);
  assertCoordinate(x, y, cliffWidth, cliffHeight, 'Terrain cliff cell');
  for (const [name, value, maximum] of [
    ['flags', input.flags, 0xffffffff],
    ['cliffId', input.cliffId, 0xffff],
    ['variation', input.variation, 0xffff],
    ['cliffLevel', input.cliffLevel, 15],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > maximum) {
      throw new SC2Error('SC2_INVALID_ARGUMENT', `${name} ${value} is outside 0..${maximum}.`, { recoverable: true });
    }
  }

  const index = y * cliffWidth + x;
  const existing = parsed.cells.find((cell) => Number.parseInt(attributeValue(cell, 'i') ?? '', 10) === index);
  const shouldExist = input.flags !== 0 || input.cliffId !== 0;
  const editor = new XmlEditor(descriptorSource);
  let occupied = parsed.cells.length;

  if (existing !== undefined && !shouldExist) {
    editor.removeElement(existing, `remove terrain cliff cell ${index}`);
    occupied -= 1;
    setOrAddAttribute(editor, parsed.list, 'numOccupied', String(occupied));
  } else if (existing !== undefined) {
    setOrAddAttribute(editor, existing, 'f', String(input.flags));
    setOrAddAttribute(editor, existing, 'cid', String(input.cliffId));
    setOrAddAttribute(editor, existing, 'cvar', String(input.variation));
  } else if (shouldExist) {
    const rendered = `<cc i="${index}" f="${input.flags}" cid="${input.cliffId}" cvar="${input.variation}"/>`;
    occupied += 1;
    if (parsed.list.selfClosing) {
      const indent = indentationBefore(descriptorSource, parsed.list.span.start);
      const childIndent = `${indent}    `;
      const replacement = `<cliffCellList num="${cliffWidth * cliffHeight}" numOccupied="${occupied}">${editor.newline}${childIndent}${rendered}${editor.newline}${indent}</cliffCellList>`;
      editor.replaceElement(parsed.list, replacement, `create terrain cliff cell ${index}`);
    } else {
      editor.appendChild(parsed.list, rendered, `create terrain cliff cell ${index}`);
      setOrAddAttribute(editor, parsed.list, 'numOccupied', String(occupied));
    }
  }

  const syncHeader = parseSyncCliffHeader(syncCliffBytes, parsed.descriptor);
  const nextSync = Buffer.from(syncCliffBytes);
  const rawCliff = input.cliffLevel * 16;
  for (let cellY = y * 2; cellY < Math.min(syncHeader.height, y * 2 + 2); cellY += 1) {
    for (let cellX = x * 2; cellX < Math.min(syncHeader.width, x * 2 + 2); cellX += 1) {
      nextSync.writeUInt16LE(rawCliff, syncGridOffset(syncHeader, cellX, cellY, 2));
    }
  }

  const nextDescriptor = editor.apply();
  parseTerrainDescriptor(nextDescriptor);
  return {
    files: [
      { path: TERRAIN_FILENAME, content: nextDescriptor },
      { path: SYNC_CLIFF_LEVEL_FILENAME, content: nextSync },
    ],
    summary: [
      shouldExist ? `set terrain cliff cell (${x}, ${y}) to flags=${input.flags}, cliffId=${input.cliffId}, variation=${input.variation}` : `cleared terrain cliff cell (${x}, ${y})`,
      `set its synchronized 2x2 cell area to cliff level ${input.cliffLevel}`,
    ],
  };
}

function validateSimpleHeader(path: string, bytes: Uint8Array): void {
  const buffer = bufferFrom(bytes);
  const requirements: Readonly<Record<string, { magic: string; minimum: number; versions?: readonly number[] }>> = {
    t3VertCol: { magic: 'VTCL', minimum: 32, versions: [103, 104] },
    t3Water: { magic: 'WATR', minimum: 32, versions: [104, 105, 106, 107, 108, 109, 110] },
    t3HardTile: { magic: 'HRDT', minimum: 28 },
    t3FluffDoodad: { magic: 'DLFT', minimum: 28 },
  };
  const requirement = requirements[path];
  if (requirement === undefined) terrainError(path, 'unknown terrain component.');
  expectMagic(buffer, path, requirement.magic);
  if (buffer.length < requirement.minimum) terrainError(path, `file is shorter than ${requirement.minimum} bytes.`);
  const version = buffer.readUInt32LE(4);
  if (requirement.versions !== undefined && !requirement.versions.includes(version)) terrainError(path, `unsupported version ${version}.`);
  if ((path === 't3Water' || path === 't3HardTile' || path === 't3FluffDoodad') && buffer.length === requirement.minimum) {
    const countOffset = path === 't3Water' ? 8 : 24;
    if (buffer.readUInt32LE(countOffset) !== 0) terrainError(path, 'header declares entries but the file has no entry data.');
  }
}

export function validateTerrainBinary(path: string, bytes: Uint8Array, descriptor?: TerrainDescriptor): void {
  switch (path) {
    case HEIGHT_MAP_FILENAME:
      parseHeightMapHeader(bytes, descriptor);
      return;
    case CELL_FLAGS_FILENAME:
      parseCellFlagsHeader(bytes, descriptor);
      return;
    case TEXTURE_MASKS_FILENAME:
      parseTextureMasksHeader(bytes);
      return;
    case SYNC_HEIGHT_MAP_FILENAME:
      parseSyncHeightHeader(bytes, descriptor);
      return;
    case SYNC_CLIFF_LEVEL_FILENAME:
      parseSyncCliffHeader(bytes, descriptor);
      return;
    case SYNC_TEXTURE_INFO_FILENAME:
      parseSyncTextureHeader(bytes, descriptor);
      return;
    default:
      validateSimpleHeader(path, bytes);
  }
}

export function patchTerrainBinary(
  path: TerrainBinaryFilename,
  bytes: Uint8Array,
  offset: number,
  replacement: Uint8Array,
  descriptor?: TerrainDescriptor,
  allowHeader = false,
): TerrainBinaryMutationOutcome {
  if (!Number.isInteger(offset) || offset < 0 || offset + replacement.length > bytes.length) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `Patch range [${offset}, ${offset + replacement.length}) is outside ${path} (${bytes.length} bytes).`, {
      path,
      recoverable: true,
    });
  }
  if (!allowHeader && offset < 8) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', 'Patching terrain magic or version requires allow_header=true.', { path, recoverable: true });
  }
  const next = Buffer.from(bytes);
  Buffer.from(replacement).copy(next, offset);
  validateTerrainBinary(path, next, descriptor);
  return {
    files: [{ path, content: next }],
    summary: [`patched ${replacement.length} byte(s) in ${path} at offset ${offset}`],
  };
}

export function inspectTerrainFiles(
  descriptorSource: string,
  files: ReadonlyMap<string, Uint8Array>,
): { readonly descriptor: TerrainDescriptor; readonly issues: readonly TerrainValidationIssue[] } {
  const descriptor = parseTerrainDescriptor(descriptorSource);
  const issues: TerrainValidationIssue[] = [];
  const required = new Set<string>([
    HEIGHT_MAP_FILENAME,
    CELL_FLAGS_FILENAME,
    TEXTURE_MASKS_FILENAME,
    SYNC_HEIGHT_MAP_FILENAME,
    SYNC_CLIFF_LEVEL_FILENAME,
    SYNC_TEXTURE_INFO_FILENAME,
  ]);

  for (const path of TERRAIN_BINARY_FILENAMES) {
    const bytes = files.get(path);
    if (bytes === undefined) {
      if (required.has(path)) issues.push({ severity: 'error', path, message: `Required terrain component ${path} is missing.` });
      continue;
    }
    try {
      validateTerrainBinary(path, bytes, descriptor);
    } catch (error) {
      issues.push({ severity: 'error', path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { descriptor, issues };
}
