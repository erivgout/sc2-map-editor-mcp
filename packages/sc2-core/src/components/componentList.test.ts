import { describe, expect, it } from 'vitest';

import { SC2Error } from '../errors.js';
import { parseComponentList } from './componentList.js';

/**
 * Copied byte-for-byte from the unpacked `EditorTest.SC2Map` that ships with StarCraft II
 * (`maps/Test/`, editor build 93333). Keeping the real thing here — rather than a
 * paraphrase — is the point: PLAN.md §55 rule 1 says format behaviour must be checked
 * against real editor output, and the two easy mistakes (path as an attribute; a
 * trailing newline) are both visible only in a genuine sample.
 */
const REAL_COMPONENT_LIST =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<Components>\r\n' +
  '    <DataComponent Type="gada">GameData</DataComponent>\r\n' +
  '    <DataComponent Type="text" Locale="enUS">GameText</DataComponent>\r\n' +
  '    <DataComponent Type="info">DocumentInfo</DataComponent>\r\n' +
  '    <DataComponent Type="mapi">MapInfo</DataComponent>\r\n' +
  '    <DataComponent Type="trig">Triggers</DataComponent>\r\n' +
  '    <DataComponent Type="terr">t3Terrain.xml</DataComponent>\r\n' +
  '    <DataComponent Type="plob">Objects</DataComponent>\r\n' +
  '    <DataComponent Type="attr">Attributes</DataComponent>\r\n' +
  '    <DataComponent Type="aiai">CustomAI</DataComponent>\r\n' +
  '    <DataComponent Type="regi">Regions</DataComponent>\r\n' +
  '</Components>';

/** The subset of that map's file listing the resolver needs. */
const REAL_STAGED_PATHS = [
  'Attributes',
  'ComponentList.SC2Components',
  'CustomAI',
  'DocumentInfo',
  'MapInfo',
  'Objects',
  'Regions',
  'Triggers',
  't3Terrain.xml',
  'Base.SC2Data/GameData/UnitData.xml',
  'Base.SC2Data/GameData/AbilData.xml',
  'enUS.SC2Data/LocalizedData/GameStrings.txt',
  'enUS.SC2Data/LocalizedData/ObjectStrings.txt',
];

describe('parseComponentList', () => {
  it('reads every component from a real editor-produced file', () => {
    const list = parseComponentList(REAL_COMPONENT_LIST, REAL_STAGED_PATHS);

    expect(list.components).toHaveLength(10);
    expect(list.components.map((component) => component.typeCode)).toEqual([
      'gada', 'text', 'info', 'mapi', 'trig', 'terr', 'plob', 'attr', 'aiai', 'regi',
    ]);
  });

  it('takes the path from the element text, not from an attribute', () => {
    const list = parseComponentList(REAL_COMPONENT_LIST, REAL_STAGED_PATHS);
    const gameData = list.components.find((component) => component.typeCode === 'gada');

    expect(gameData?.path).toBe('GameData');
  });

  it('reads the Locale attribute and collects the document locales', () => {
    const list = parseComponentList(REAL_COMPONENT_LIST, REAL_STAGED_PATHS);

    expect(list.components.find((component) => component.typeCode === 'text')?.locale).toBe('enUS');
    expect(list.locales).toEqual(['enUS']);
  });

  it('resolves a logical directory name into the SC2Data layer that holds it', () => {
    const list = parseComponentList(REAL_COMPONENT_LIST, REAL_STAGED_PATHS);
    const gameData = list.components.find((component) => component.typeCode === 'gada');

    // "GameData" is not a path — it names a directory inside each *.SC2Data layer.
    expect([...(gameData?.resolvedPaths ?? [])].sort()).toEqual([
      'Base.SC2Data/GameData/AbilData.xml',
      'Base.SC2Data/GameData/UnitData.xml',
    ]);
    expect(gameData?.exists).toBe(true);
  });

  it('resolves the text component to LocalizedData in its own locale layer', () => {
    const list = parseComponentList(REAL_COMPONENT_LIST, REAL_STAGED_PATHS);
    const text = list.components.find((component) => component.typeCode === 'text');

    expect([...(text?.resolvedPaths ?? [])].sort()).toEqual([
      'enUS.SC2Data/LocalizedData/GameStrings.txt',
      'enUS.SC2Data/LocalizedData/ObjectStrings.txt',
    ]);
  });

  it('resolves components that name a real file at the document root', () => {
    const list = parseComponentList(REAL_COMPONENT_LIST, REAL_STAGED_PATHS);

    expect(list.components.find((component) => component.typeCode === 'terr')?.resolvedPaths).toEqual(['t3Terrain.xml']);
    expect(list.components.find((component) => component.typeCode === 'info')?.resolvedPaths).toEqual(['DocumentInfo']);
  });

  it('reports declared-but-absent components instead of hiding them', () => {
    const list = parseComponentList(REAL_COMPONENT_LIST, ['DocumentInfo']);

    expect(list.missing.length).toBeGreaterThan(0);
    expect(list.missing.map((component) => component.typeCode)).toContain('gada');
  });

  it('never claims a component is writable', () => {
    // PLAN.md §11: being able to read a file is not being able to serialise it safely.
    const list = parseComponentList(REAL_COMPONENT_LIST, REAL_STAGED_PATHS);
    expect(list.components.every((component) => !component.writable)).toBe(true);
  });

  it('passes through an unrecognised type code rather than dropping it', () => {
    const list = parseComponentList(
      '<Components><DataComponent Type="zzzz">Mystery</DataComponent></Components>',
      [],
    );

    expect(list.components[0]?.typeCode).toBe('zzzz');
    expect(list.components[0]?.description).toBeNull();
  });

  it('rejects a file whose root element is not <Components>', () => {
    expect(() => parseComponentList('<NotComponents/>', [])).toThrow(SC2Error);
  });

  it('rejects a component entry with no Type attribute', () => {
    expect(() => parseComponentList('<Components><DataComponent>X</DataComponent></Components>', [])).toThrow(SC2Error);
  });

  it('matches paths case-insensitively, as SC2 archives do', () => {
    const list = parseComponentList('<Components><DataComponent Type="terr">t3Terrain.xml</DataComponent></Components>', [
      'T3TERRAIN.XML',
    ]);
    expect(list.components[0]?.resolvedPaths).toEqual(['T3TERRAIN.XML']);
  });
});
