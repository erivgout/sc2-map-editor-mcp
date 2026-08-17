import { describe, expect, it } from 'vitest';

import { SC2Error } from '../errors.js';
import { createRegion, deleteObject, deleteRegion, placeObject, updateObject, updateRegion } from './mutate.js';
import { parsePlacedObjects, parseRegions } from './objects.js';

/** Shapes copied from real editor output, CRLF and all. */
const REGIONS =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<Regions>\r\n' +
  '    <region id="1">\r\n' +
  '        <name value="Region 001"/>\r\n' +
  '        <invisible/>\r\n' +
  '        <shape type="circle">\r\n' +
  '            <center value="227.9604,42.1821"/>\r\n' +
  '            <radius value="2.9916"/>\r\n' +
  '        </shape>\r\n' +
  '    </region>\r\n' +
  '    <region id="4">\r\n' +
  '        <name value="Region 004"/>\r\n' +
  '        <shape type="circle">\r\n' +
  '            <center value="174.3806,140.673"/>\r\n' +
  '            <radius value="2.5737"/>\r\n' +
  '        </shape>\r\n' +
  '    </region>\r\n' +
  '</Regions>\r\n';

const OBJECTS =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<PlacedObjects Version="27">\r\n' +
  '    <ObjectDoodad Id="232833756" Position="110.8942,26.3466,7.9975" Rotation="5.514" Scale="1,1,1" Type="LavaSplash">\r\n' +
  '        <Flag Index="HeightAbsolute" Value="1"/>\r\n' +
  '    </ObjectDoodad>\r\n' +
  '    <ObjectPoint Id="958681981" Position="23.5,22.5,0" Type="StartLoc"/>\r\n' +
  '</PlacedObjects>\r\n';

describe('regions', () => {
  it('creates a region with the next free id, matching the file\'s own shape', () => {
    const outcome = createRegion(REGIONS, {
      name: 'Spawn North',
      shape: { type: 'circle', values: { center: '10,20', radius: '5' } },
    });

    // Ids are sequential in editor output, and 4 is the highest already used.
    expect(outcome.summary).toEqual(['created region 5 "Spawn North" as circle']);
    expect(outcome.content).toContain('<region id="5">');
    expect(outcome.content).toContain('<name value="Spawn North"/>');
    expect(outcome.content).toContain('<shape type="circle">');
    expect(outcome.content).toContain('<center value="10,20"/>');

    const parsed = parseRegions(outcome.content);
    expect(parsed.regions).toHaveLength(3);
    const created = parsed.regions.find((region) => region.id === '5');
    expect(created?.shapeType).toBe('circle');
    expect(created?.shape).toEqual({ center: '10,20', radius: '5' });

    // Everything that was there before is untouched, byte for byte.
    expect(outcome.content).toContain(REGIONS.slice(REGIONS.indexOf('<region id="1">'), REGIONS.indexOf('<region id="4">')));
    expect(outcome.content.startsWith('<?xml version="1.0" encoding="utf-8"?>\r\n')).toBe(true);
    expect(outcome.content).toContain('\r\n');
  });

  it('carries childless markers through', () => {
    const outcome = createRegion(REGIONS, {
      name: 'Hidden',
      shape: { type: 'circle', values: { center: '1,2', radius: '3' } },
      markers: ['invisible'],
    });
    expect(outcome.content).toContain('<invisible/>');
    expect(parseRegions(outcome.content).regions.find((region) => region.id === '5')?.markers).toEqual(['invisible']);
  });

  it('moves and renames a region without disturbing its neighbours', () => {
    const outcome = updateRegion(REGIONS, '1', {
      name: 'Moved',
      shape: { type: 'circle', values: { center: '99.5,88.25' } },
    });

    const parsed = parseRegions(outcome.content);
    const region = parsed.regions.find((entry) => entry.id === '1');
    expect(region?.name).toBe('Moved');
    expect(region?.shape['center']).toBe('99.5,88.25');
    // The radius it did not mention is left exactly as it was.
    expect(region?.shape['radius']).toBe('2.9916');
    expect(parsed.regions.find((entry) => entry.id === '4')?.name).toBe('Region 004');
  });

  it('refuses to change a region to a different shape kind', () => {
    expect(() => updateRegion(REGIONS, '1', { shape: { type: 'rect', values: { quad: '1,2,3,4' } } })).toThrow(SC2Error);
  });

  it('deletes a region and leaves the rest parseable', () => {
    const outcome = deleteRegion(REGIONS, '1');
    const parsed = parseRegions(outcome.content);
    expect(parsed.regions.map((region) => region.id)).toEqual(['4']);
  });

  it('reports a region that is not there rather than doing nothing', () => {
    expect(() => deleteRegion(REGIONS, '99')).toThrow(SC2Error);
    expect(() => updateRegion(REGIONS, '99', { name: 'x' })).toThrow(SC2Error);
  });
});

describe('placed objects', () => {
  it('names a unit\'s type with UnitType, the way the editor does', () => {
    // Checked against 181 real ObjectUnit entries: units use UnitType, points and doodads
    // use Type. Writing Type on a unit produces an object the game cannot resolve.
    const outcome = placeObject(OBJECTS, {
      kind: 'ObjectUnit',
      type: 'Marine',
      position: '50.5,60.5,8',
      rotation: '1.5',
      attributes: { Player: '1' },
    });

    expect(outcome.content).toContain('<ObjectUnit Id="958681982" Position="50.5,60.5,8" Rotation="1.5" UnitType="Marine" Player="1"/>');

    const parsed = parsePlacedObjects(outcome.content);
    expect(parsed.objects).toHaveLength(3);
    const placed = parsed.objects.find((object) => object.id === '958681982');
    expect(placed?.kind).toBe('ObjectUnit');
    expect(placed?.type).toBe('Marine');
    expect(placed?.otherAttributes).toEqual({ Player: '1' });
    // The Version attribute and the existing objects survive untouched.
    expect(parsed.version).toBe('27');
    expect(outcome.content).toContain('<Flag Index="HeightAbsolute" Value="1"/>');
  });

  it('places an object with flags as a nested element', () => {
    const outcome = placeObject(OBJECTS, {
      kind: 'ObjectDoodad',
      type: 'Rock',
      position: '1,2,3',
      flags: { HeightAbsolute: '1' },
    });

    expect(outcome.content).toContain('<ObjectDoodad Id="958681982" Position="1,2,3" Type="Rock">');
    expect(parsePlacedObjects(outcome.content).objects.find((object) => object.id === '958681982')?.flags).toEqual({
      HeightAbsolute: '1',
    });
  });

  it('names a point\'s type with Type, and reads both conventions back', () => {
    const outcome = placeObject(OBJECTS, { kind: 'ObjectPoint', type: 'Normal', position: '3,4,0' });
    expect(outcome.content).toContain('<ObjectPoint Id="958681982" Position="3,4,0" Type="Normal"/>');

    const withUnit = placeObject(outcome.content, { kind: 'ObjectUnit', type: 'Zealot', position: '5,6,0' });
    const parsed = parsePlacedObjects(withUnit.content);
    expect(parsed.objects.find((object) => object.kind === 'ObjectPoint' && object.id === '958681982')?.type).toBe('Normal');
    expect(parsed.objects.find((object) => object.id === '958681983')?.type).toBe('Zealot');
    // UnitType must not also surface as an unmodelled leftover attribute.
    expect(parsed.objects.find((object) => object.id === '958681983')?.otherAttributes).toEqual({});
  });

  it('rejects a position that is not x,y,z', () => {
    for (const bad of ['1,2', 'a,b,c', '', '1,2,3,4']) {
      expect(() => placeObject(OBJECTS, { kind: 'ObjectPoint', position: bad }), bad).toThrow(SC2Error);
    }
  });

  it('moves an object and changes nothing else', () => {
    const outcome = updateObject(OBJECTS, '232833756', { position: '1,2,3' });
    expect(outcome.summary).toEqual(['set object 232833756 Position = 1,2,3']);

    const parsed = parsePlacedObjects(outcome.content);
    const moved = parsed.objects.find((object) => object.id === '232833756');
    expect(moved?.position).toBe('1,2,3');
    expect(moved?.rotation).toBe('5.514');
    expect(moved?.flags).toEqual({ HeightAbsolute: '1' });
  });

  it('treats setting a value it already has as no change at all', () => {
    const outcome = updateObject(OBJECTS, '232833756', { position: '110.8942,26.3466,7.9975' });
    expect(outcome.summary).toEqual([]);
    expect(outcome.content).toBe(OBJECTS);
  });

  it('deletes an object', () => {
    const outcome = deleteObject(OBJECTS, '232833756');
    expect(outcome.summary).toEqual(['deleted ObjectDoodad 232833756']);
    const parsed = parsePlacedObjects(outcome.content);
    expect(parsed.objects.map((object) => object.id)).toEqual(['958681981']);
  });

  it('reports an object that is not there', () => {
    expect(() => deleteObject(OBJECTS, '1')).toThrow(SC2Error);
    expect(() => updateObject(OBJECTS, '1', { position: '1,2,3' })).toThrow(SC2Error);
  });
});
