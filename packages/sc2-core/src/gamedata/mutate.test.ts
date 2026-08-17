import { describe, expect, it } from 'vitest';

import { SC2Error } from '../errors.js';
import { parseCatalogFile } from './catalog.js';
import { lookupField, nextArrayIndex, parseFieldPath } from './fieldPath.js';
import { applyCatalogPatches, cloneCatalogEntry, createCatalogEntry, deleteCatalogEntry, findEntryElement } from './mutate.js';
import { parseXml } from '../xml/parse.js';

/** Shapes and formatting taken from real editor output, including CRLF and a comment. */
const CATALOG =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<Catalog>\r\n' +
  '    <!-- keep me -->\r\n' +
  '    <CUnit id="Marine">\r\n' +
  '        <LifeMax value="45"/>\r\n' +
  '        <FlagArray index="ArmySelect" value="1"/>\r\n' +
  '        <WeaponArray index="0" Link="GaussRifle"/>\r\n' +
  '    </CUnit>\r\n' +
  '    <CUnit id="Reaper" parent="Marine">\r\n' +
  '        <Speed value="3.75"/>\r\n' +
  '    </CUnit>\r\n' +
  '</Catalog>\r\n';

const PATH = 'Base.SC2Data/GameData/UnitData.xml';

describe('parseFieldPath', () => {
  it('parses plain, array, and nested paths', () => {
    expect(parseFieldPath('LifeMax')).toEqual([{ name: 'LifeMax', index: null }]);
    expect(parseFieldPath('FlagArray[ArmySelect]')).toEqual([{ name: 'FlagArray', index: 'ArmySelect' }]);
    expect(parseFieldPath('CardLayouts[0].LayoutButtons[3]')).toEqual([
      { name: 'CardLayouts', index: '0' },
      { name: 'LayoutButtons', index: '3' },
    ]);
  });

  it('rejects malformed paths rather than half-parsing them', () => {
    for (const bad of ['', '  ', '1Bad', 'A[unclosed', 'A..B', 'A/B']) {
      expect(() => parseFieldPath(bad), bad).toThrow(SC2Error);
    }
  });
});

describe('lookupField and nextArrayIndex', () => {
  it('distinguishes array elements by index', () => {
    const entry = findEntryElement(parseXml(CATALOG).root!, 'Unit', 'Marine')!;

    expect(lookupField(entry, parseFieldPath('FlagArray[ArmySelect]')).element).not.toBeNull();
    // A different index is a different field, not the same one.
    expect(lookupField(entry, parseFieldPath('FlagArray[Missing]')).element).toBeNull();
    expect(lookupField(entry, parseFieldPath('FlagArray')).element).toBeNull();
  });

  it('reports the parent when a field does not exist yet, so it can be created', () => {
    const entry = findEntryElement(parseXml(CATALOG).root!, 'Unit', 'Marine')!;
    const lookup = lookupField(entry, parseFieldPath('Sight'));

    expect(lookup.element).toBeNull();
    expect(lookup.parent.name).toBe('CUnit');
  });

  it('finds the next free numeric index, ignoring token-indexed siblings', () => {
    const entry = findEntryElement(parseXml(CATALOG).root!, 'Unit', 'Marine')!;
    expect(nextArrayIndex(entry, 'WeaponArray')).toBe(1);
    // FlagArray is token-indexed, so it has no numeric positions at all.
    expect(nextArrayIndex(entry, 'FlagArray')).toBe(0);
  });
});

describe('applyCatalogPatches', () => {
  it('sets an existing value and changes nothing else', () => {
    const outcome = applyCatalogPatches(CATALOG, 'Unit', 'Marine', [{ op: 'set', path: 'LifeMax', value: '125' }], PATH);

    expect(outcome.content).toBe(CATALOG.replace('<LifeMax value="45"/>', '<LifeMax value="125"/>'));
    expect(outcome.summary).toEqual(['set Unit/Marine.LifeMax@value: 45 -> 125']);
    expect(outcome.content).toContain('keep me');
  });

  it('creates a field that does not exist yet, at sibling indentation', () => {
    const outcome = applyCatalogPatches(CATALOG, 'Unit', 'Marine', [{ op: 'set', path: 'Sight', value: '11' }], PATH);

    expect(outcome.content).toContain('        <WeaponArray index="0" Link="GaussRifle"/>\r\n        <Sight value="11"/>\r\n');
    expect(outcome.summary[0]).toContain('created');
  });

  it('reports a set to the current value as a no-op instead of manufacturing a diff', () => {
    const outcome = applyCatalogPatches(CATALOG, 'Unit', 'Marine', [{ op: 'set', path: 'LifeMax', value: '45' }], PATH);

    expect(outcome.content).toBe(CATALOG);
    expect(outcome.summary).toEqual([]);
    expect(outcome.noOps[0]).toContain('already 45');
  });

  it('sets a Link on an array element addressed by index', () => {
    const outcome = applyCatalogPatches(
      CATALOG,
      'Unit',
      'Marine',
      [{ op: 'set_link', path: 'WeaponArray[0]', value: 'RailRifle' }],
      PATH,
    );

    expect(outcome.content).toContain('<WeaponArray index="0" Link="RailRifle"/>');
  });

  it('appends a new array element with the next free index', () => {
    const outcome = applyCatalogPatches(
      CATALOG,
      'Unit',
      'Marine',
      [{ op: 'append_array', path: 'WeaponArray', link: 'SecondWeapon' }],
      PATH,
    );

    expect(outcome.content).toContain('<WeaponArray index="1" Link="SecondWeapon"/>');
    expect(outcome.summary[0]).toContain('WeaponArray[1]');
  });

  it('rejects append_array when the path carries an index', () => {
    expect(() =>
      applyCatalogPatches(CATALOG, 'Unit', 'Marine', [{ op: 'append_array', path: 'WeaponArray[0]', link: 'X' }], PATH),
    ).toThrow(SC2Error);
  });

  it('removes a field and its whole line', () => {
    const outcome = applyCatalogPatches(CATALOG, 'Unit', 'Marine', [{ op: 'remove', path: 'LifeMax' }], PATH);

    expect(outcome.content).not.toContain('LifeMax');
    // No blank indented line left behind.
    expect(outcome.content).toContain('<CUnit id="Marine">\r\n        <FlagArray');
  });

  it('treats removing an absent field as a no-op', () => {
    const outcome = applyCatalogPatches(CATALOG, 'Unit', 'Marine', [{ op: 'remove', path: 'NotThere' }], PATH);

    expect(outcome.content).toBe(CATALOG);
    expect(outcome.noOps).toHaveLength(1);
  });

  it('applies several patches in one pass', () => {
    const outcome = applyCatalogPatches(
      CATALOG,
      'Unit',
      'Marine',
      [
        { op: 'set', path: 'LifeMax', value: '125' },
        { op: 'set', path: 'Sight', value: '11' },
        { op: 'append_array', path: 'WeaponArray', link: 'Second' },
      ],
      PATH,
    );

    expect(outcome.content).toContain('<LifeMax value="125"/>');
    expect(outcome.content).toContain('<Sight value="11"/>');
    expect(outcome.content).toContain('<WeaponArray index="1" Link="Second"/>');
    // Still valid, and the other object is untouched.
    expect(parseCatalogFile(outcome.content, PATH).entries).toHaveLength(2);
    expect(outcome.content).toContain('<CUnit id="Reaper" parent="Marine">');
  });

  it('refuses a path whose intermediate segment does not exist', () => {
    expect(() =>
      applyCatalogPatches(CATALOG, 'Unit', 'Marine', [{ op: 'set', path: 'Missing[0].Inner', value: 'x' }], PATH),
    ).toThrow(SC2Error);
  });

  it('refuses to patch an object the file does not declare', () => {
    expect(() => applyCatalogPatches(CATALOG, 'Unit', 'Ghost', [{ op: 'set', path: 'LifeMax', value: '1' }], PATH)).toThrow(
      SC2Error,
    );
  });

  it('escapes a value containing markup characters', () => {
    const outcome = applyCatalogPatches(
      CATALOG,
      'Unit',
      'Marine',
      [{ op: 'set', path: 'LifeMax', value: 'a & b' }],
      PATH,
    );
    expect(outcome.content).toContain('<LifeMax value="a &amp; b"/>');
  });
});

describe('cloneCatalogEntry', () => {
  it('copies the declaration byte-for-byte under a new id', () => {
    const outcome = cloneCatalogEntry(CATALOG, 'Unit', 'Marine', 'RailMarine', PATH);
    const cloned = parseCatalogFile(outcome.content, PATH).entries.find((entry) => entry.id === 'RailMarine');

    expect(cloned?.ctype).toBe('CUnit');
    // Every field came along, including ones nothing here interprets.
    expect(outcome.content).toContain('<CUnit id="RailMarine">\r\n        <LifeMax value="45"/>');
    expect(outcome.content).toContain('<WeaponArray index="0" Link="GaussRifle"/>\r\n    </CUnit>\r\n    <CUnit id="Reaper"');
  });

  it('places the clone immediately after the original, keeping the diff local', () => {
    const outcome = cloneCatalogEntry(CATALOG, 'Unit', 'Marine', 'RailMarine', PATH);
    const marineIndex = outcome.content.indexOf('id="Marine"');
    const cloneIndex = outcome.content.indexOf('id="RailMarine"');
    const reaperIndex = outcome.content.indexOf('id="Reaper"');

    expect(marineIndex).toBeLessThan(cloneIndex);
    expect(cloneIndex).toBeLessThan(reaperIndex);
  });

  it('can retarget the clone\'s parent', () => {
    const outcome = cloneCatalogEntry(CATALOG, 'Unit', 'Reaper', 'FastReaper', PATH, { newParent: 'Marine2' });
    expect(outcome.content).toContain('<CUnit id="FastReaper" parent="Marine2">');
  });

  it('adds a parent attribute when the original had none', () => {
    const outcome = cloneCatalogEntry(CATALOG, 'Unit', 'Marine', 'ChildMarine', PATH, { newParent: 'Marine' });
    expect(outcome.content).toContain('<CUnit id="ChildMarine" parent="Marine">');
  });

  it('refuses to clone onto an id that already exists', () => {
    expect(() => cloneCatalogEntry(CATALOG, 'Unit', 'Marine', 'Reaper', PATH)).toThrow(SC2Error);
  });
});

describe('createCatalogEntry', () => {
  it('adds an empty entry with a parent', () => {
    const outcome = createCatalogEntry(CATALOG, 'CUnit', 'NewUnit', PATH, { parent: 'Marine' });

    expect(outcome.content).toContain('<CUnit id="NewUnit" parent="Marine"/>');
    expect(parseCatalogFile(outcome.content, PATH).entries).toHaveLength(3);
  });

  it('refuses a duplicate id', () => {
    expect(() => createCatalogEntry(CATALOG, 'CUnit', 'Marine', PATH)).toThrow(SC2Error);
  });

  it('refuses a file that is not a catalog', () => {
    expect(() => createCatalogEntry('<NotACatalog/>', 'CUnit', 'X', PATH)).toThrow(SC2Error);
  });
});

describe('deleteCatalogEntry', () => {
  it('removes the entry and leaves the rest intact', () => {
    const outcome = deleteCatalogEntry(CATALOG, 'Unit', 'Reaper', PATH);
    const remaining = parseCatalogFile(outcome.content, PATH).entries;

    expect(remaining.map((entry) => entry.id)).toEqual(['Marine']);
    expect(outcome.content).toContain('keep me');
  });

  it('refuses to delete something the file does not declare', () => {
    expect(() => deleteCatalogEntry(CATALOG, 'Unit', 'Ghost', PATH)).toThrow(SC2Error);
  });
});
