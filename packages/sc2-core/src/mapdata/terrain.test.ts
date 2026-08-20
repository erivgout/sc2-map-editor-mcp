import { describe, expect, it } from 'vitest';

import {
  CELL_FLAGS_FILENAME,
  HEIGHT_MAP_FILENAME,
  SYNC_CLIFF_LEVEL_FILENAME,
  SYNC_HEIGHT_MAP_FILENAME,
  SYNC_TEXTURE_INFO_FILENAME,
  TEXTURE_MASKS_FILENAME,
  inspectTerrainFiles,
  parseTerrainDescriptor,
  patchTerrainBinary,
  readTerrainCell,
  readTerrainVertex,
  setTerrainCellFlags,
  setTerrainCellTexture,
  setTerrainCliffCell,
  setTerrainVertexHeight,
} from './terrain.js';

const DESCRIPTOR =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<terrain version="115">\r\n' +
  '    <heightMap tileSet="Test" dim="3 3 " offset="0 0 0 " scale="1 1 1 ">\r\n' +
  '        <vertData quantizeBias="1" quantizeScale="0.001" standardHeight="8" name="t3HeightMap"/>\r\n' +
  '        <masks name="t3TextureMasks"/>\r\n' +
  '        <textureSetList num="8"><textureSet i="0" name="Test"/></textureSetList>\r\n' +
  '        <textureList num="64"><texture i="0" name="Ground"/><texture i="1" name="Rock"/></textureList>\r\n' +
  '        <blockTextureSetList num="0"/>\r\n' +
  '        <cliffCellList num="1" numOccupied="0"/>\r\n' +
  '    </heightMap>\r\n' +
  '</terrain>\r\n';

function heightMap(): Buffer {
  const buffer = Buffer.alloc(32 + 6 * 9);
  buffer.write('HMAP', 0, 'ascii');
  buffer.writeUInt32LE(101, 4);
  buffer.writeUInt32LE(3, 8);
  buffer.writeUInt32LE(3, 12);
  for (let index = 0; index < 9; index += 1) {
    buffer.writeUInt16LE(9000, 32 + index * 6);
    buffer.writeUInt16LE(1000, 34 + index * 6);
    buffer.writeUInt16LE(1, 36 + index * 6);
  }
  return buffer;
}

function syncHeightMap(): Buffer {
  const buffer = Buffer.alloc(64 + 4 * 9);
  buffer.write('SMAP', 0, 'ascii');
  buffer.writeUInt32LE(102, 4);
  buffer.writeUInt32LE(3, 8);
  buffer.writeUInt32LE(3, 12);
  for (let index = 0; index < 9; index += 1) buffer.writeUInt16LE(2048, 64 + index * 4);
  return buffer;
}

function cellFlags(): Buffer {
  const buffer = Buffer.alloc(32 + 4);
  buffer.write('LFCT', 0, 'ascii');
  buffer.writeUInt32LE(102, 4);
  buffer.writeUInt32LE(2, 24);
  buffer.writeUInt32LE(2, 28);
  return buffer;
}

function textureMasks(): Buffer {
  const buffer = Buffer.alloc(64 + 8 * 2048);
  buffer.write('MASK', 0, 'ascii');
  buffer.writeUInt32LE(102, 4);
  buffer.writeUInt32LE(64, 12);
  buffer.writeUInt32LE(64, 16);
  return buffer;
}

function syncCliff(): Buffer {
  const buffer = Buffer.alloc(32 + 2 * 4);
  buffer.write('CLIF', 0, 'ascii');
  buffer.writeUInt32LE(100, 4);
  for (let index = 0; index < 4; index += 1) buffer.writeUInt16LE(64, 32 + index * 2);
  return buffer;
}

function syncTexture(): Buffer {
  const names = Buffer.from('Ground\0Rock\0\0\0\0\0\0\0', 'utf8');
  const buffer = Buffer.alloc(20 + names.length + 8 * 4);
  buffer.write('RTXT', 0, 'ascii');
  buffer.writeUInt32LE(101, 4);
  buffer.writeUInt32LE(2, 8);
  buffer.writeUInt32LE(2, 12);
  buffer.writeUInt32LE(1, 16);
  names.copy(buffer, 20);
  return buffer;
}

describe('terrain codecs', () => {
  const descriptor = parseTerrainDescriptor(DESCRIPTOR);

  it('reads and writes render and synchronized vertex heights together', () => {
    const outcome = setTerrainVertexHeight(descriptor, heightMap(), syncHeightMap(), 1, 2, 10.5);
    const nextHeight = outcome.files.find((file) => file.path === HEIGHT_MAP_FILENAME)?.content as Uint8Array;
    const nextSync = outcome.files.find((file) => file.path === SYNC_HEIGHT_MAP_FILENAME)?.content as Uint8Array;
    const vertex = readTerrainVertex(descriptor, nextHeight, nextSync, 1, 2);
    expect(vertex.worldHeight).toBeCloseTo(10.5, 3);
    expect(vertex.syncHeight).toBeCloseTo(10.5, 3);
    expect(vertex.mask).toBe(1);
  });

  it('writes cell flags as one exact byte', () => {
    const outcome = setTerrainCellFlags(descriptor, cellFlags(), 1, 0, 0xa5);
    const nextFlags = outcome.files[0]?.content as Uint8Array;
    expect(readTerrainCell(descriptor, nextFlags, textureMasks(), syncCliff(), syncTexture(), 1, 0).flags).toBe(0xa5);
  });

  it('writes all eight texture weights and the synchronized texture index', () => {
    const outcome = setTerrainCellTexture(descriptor, textureMasks(), syncTexture(), 0, 1, [0, 15, 2, 3, 4, 5, 6, 7]);
    const nextMasks = outcome.files.find((file) => file.path === TEXTURE_MASKS_FILENAME)?.content as Uint8Array;
    const nextSync = outcome.files.find((file) => file.path === SYNC_TEXTURE_INFO_FILENAME)?.content as Uint8Array;
    const cell = readTerrainCell(descriptor, cellFlags(), nextMasks, syncCliff(), nextSync, 0, 1);
    expect(cell.textureWeights).toEqual([0, 15, 2, 3, 4, 5, 6, 7]);
    expect(cell.textureIndex).toBe(1);
  });

  it('creates a descriptor cliff cell and updates its synchronized 2x2 area', () => {
    const outcome = setTerrainCliffCell(DESCRIPTOR, syncCliff(), 0, 0, {
      flags: 1,
      cliffId: 0,
      variation: 2,
      cliffLevel: 5,
    });
    const xml = outcome.files.find((file) => file.path === 't3Terrain.xml')?.content as string;
    const sync = outcome.files.find((file) => file.path === SYNC_CLIFF_LEVEL_FILENAME)?.content as Uint8Array;
    expect(xml).toContain('<cliffCellList num="1" numOccupied="1">');
    expect(xml).toContain('<cc i="0" f="1" cid="0" cvar="2"/>');
    expect(Buffer.from(sync).readUInt16LE(32)).toBe(80);
    expect(readTerrainCell(parseTerrainDescriptor(xml), cellFlags(), textureMasks(), sync, syncTexture(), 0, 0).descriptorCliff).toEqual({
      index: 0,
      flags: 1,
      cliffId: 0,
      variation: 2,
    });
  });

  it('supports validated byte patches for advanced terrain components', () => {
    const source = cellFlags();
    const outcome = patchTerrainBinary(CELL_FLAGS_FILENAME, source, 32, Uint8Array.of(7), descriptor);
    const result = Buffer.from(outcome.files[0]?.content as Uint8Array);
    expect(result[32]).toBe(7);
    expect(result.subarray(0, 32)).toEqual(source.subarray(0, 32));
  });

  it('validates the complete required terrain set', () => {
    const files = new Map<string, Uint8Array>([
      [HEIGHT_MAP_FILENAME, heightMap()],
      [CELL_FLAGS_FILENAME, cellFlags()],
      [TEXTURE_MASKS_FILENAME, textureMasks()],
      [SYNC_HEIGHT_MAP_FILENAME, syncHeightMap()],
      [SYNC_CLIFF_LEVEL_FILENAME, syncCliff()],
      [SYNC_TEXTURE_INFO_FILENAME, syncTexture()],
    ]);
    expect(inspectTerrainFiles(DESCRIPTOR, files).issues).toEqual([]);
  });

  it('rejects corrupted versions and out-of-bounds edits', () => {
    const corrupted = heightMap();
    corrupted.writeUInt32LE(999, 4);
    const files = new Map<string, Uint8Array>([
      [HEIGHT_MAP_FILENAME, corrupted],
      [CELL_FLAGS_FILENAME, cellFlags()],
      [TEXTURE_MASKS_FILENAME, textureMasks()],
      [SYNC_HEIGHT_MAP_FILENAME, syncHeightMap()],
      [SYNC_CLIFF_LEVEL_FILENAME, syncCliff()],
      [SYNC_TEXTURE_INFO_FILENAME, syncTexture()],
    ]);
    expect(inspectTerrainFiles(DESCRIPTOR, files).issues).toEqual([
      expect.objectContaining({ severity: 'error', path: HEIGHT_MAP_FILENAME, message: expect.stringContaining('unsupported version 999') }),
    ]);
    expect(() => setTerrainCellFlags(descriptor, cellFlags(), 2, 0, 1)).toThrow(/outside/);
    expect(() => patchTerrainBinary(CELL_FLAGS_FILENAME, cellFlags(), 0, Uint8Array.of(0), descriptor)).toThrow(/allow_header=true/);
  });
});
