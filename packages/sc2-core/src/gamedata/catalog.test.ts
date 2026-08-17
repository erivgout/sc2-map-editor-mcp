import { describe, expect, it } from 'vitest';

import { SC2Error } from '../errors.js';
import { parseCatalogFile, walkFields } from './catalog.js';
import { domainFromElementName, isKnownDomain } from './domains.js';
import { CatalogIndex } from './store.js';

/**
 * Shapes taken from `Base.SC2Data/GameData/UnitData.xml` in the editor-produced
 * `EditorTest.SC2Map` that ships with StarCraft II — including the `parent` attribute, the
 * numeric and token array indices, and the bare `Link` with no index.
 */
const UNIT_DATA =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<Catalog>\r\n' +
  '    <CUnit id="BroodlingDefault">\r\n' +
  '        <LifeMax value="30"/>\r\n' +
  '        <Speed value="4"/>\r\n' +
  '        <Race value="Zerg"/>\r\n' +
  '    </CUnit>\r\n' +
  '    <CUnit id="Broodling2" parent="BroodlingDefault">\r\n' +
  '        <LifeMax value="45"/>\r\n' +
  '        <FlagArray index="ArmySelect" value="1"/>\r\n' +
  '        <WeaponArray index="0" Link="BroodlingWeapon"/>\r\n' +
  '        <AbilArray Link="stop"/>\r\n' +
  '    </CUnit>\r\n' +
  '</Catalog>\r\n';

const WEAPON_DATA =
  '<Catalog>\r\n' +
  '    <CWeaponLegacy id="BroodlingWeapon">\r\n' +
  '        <DisplayEffect value="BroodlingWeaponDamage"/>\r\n' +
  '    </CWeaponLegacy>\r\n' +
  '</Catalog>\r\n';

const ABIL_DATA =
  '<Catalog>\r\n' +
  '    <CAbilEffectInstant id="TestInstant">\r\n' +
  '        <Effect value="BroodlingWeaponDamage"/>\r\n' +
  '    </CAbilEffectInstant>\r\n' +
  '</Catalog>\r\n';

function buildIndex(): CatalogIndex {
  return CatalogIndex.build([
    { path: 'Base.SC2Data/GameData/UnitData.xml', content: UNIT_DATA },
    { path: 'Base.SC2Data/GameData/WeaponData.xml', content: WEAPON_DATA },
    { path: 'Base.SC2Data/GameData/AbilData.xml', content: ABIL_DATA },
  ]);
}

describe('domainFromElementName', () => {
  it('takes the longest matching domain prefix', () => {
    expect(domainFromElementName('CUnit')).toBe('Unit');
    // The element name is the concrete type; the domain is a prefix of it.
    expect(domainFromElementName('CAbilEffectInstant')).toBe('Abil');
    expect(domainFromElementName('CWeaponLegacy')).toBe('Weapon');
    expect(domainFromElementName('CValidatorUnitCompareVital')).toBe('Validator');
    expect(domainFromElementName('CRequirementCountUnit')).toBe('Requirement');
  });

  it('prefers ActorSupport over Actor, since longest wins', () => {
    expect(domainFromElementName('CActorSupport')).toBe('ActorSupport');
    expect(domainFromElementName('CActorUnit')).toBe('Actor');
  });

  it('returns null rather than guessing for an unknown prefix', () => {
    expect(domainFromElementName('CTotallyMadeUp')).toBeNull();
    expect(domainFromElementName('Catalog')).toBeNull();
    expect(domainFromElementName('')).toBeNull();
  });

  it('agrees with the exported domain list', () => {
    expect(isKnownDomain('Unit')).toBe(true);
    expect(isKnownDomain('NotADomain')).toBe(false);
  });
});

describe('parseCatalogFile', () => {
  it('reads entries with their type, id, and parent', () => {
    const file = parseCatalogFile(UNIT_DATA, 'Base.SC2Data/GameData/UnitData.xml');

    expect(file.entries).toHaveLength(2);
    expect(file.entries[1]).toMatchObject({ ctype: 'CUnit', domain: 'Unit', id: 'Broodling2', parent: 'BroodlingDefault' });
  });

  it('distinguishes value fields, Link fields, and array indices', () => {
    const file = parseCatalogFile(UNIT_DATA, 'UnitData.xml');
    const fields = [...walkFields(file.entries[1]!.fields)];
    const byPath = new Map(fields.map((entry) => [entry.path, entry.field]));

    expect(byPath.get('LifeMax')?.value).toBe('45');
    // Array elements are addressed by their index, numeric or token.
    expect(byPath.get('FlagArray[ArmySelect]')?.value).toBe('1');
    expect(byPath.get('WeaponArray[0]')?.link).toBe('BroodlingWeapon');
    // A Link with no index is a plain field, not an array element.
    expect(byPath.get('AbilArray')?.link).toBe('stop');
  });

  it('records spans that slice back to the exact declaration', () => {
    const file = parseCatalogFile(UNIT_DATA, 'UnitData.xml');
    const entry = file.entries[1]!;
    const sliced = UNIT_DATA.slice(entry.span.start, entry.span.end);

    // This is what Phase 8 will splice: the object's bytes and nothing else.
    expect(sliced.startsWith('<CUnit id="Broodling2"')).toBe(true);
    expect(sliced.endsWith('</CUnit>')).toBe(true);
  });

  it('reports 1-based line numbers', () => {
    const file = parseCatalogFile(UNIT_DATA, 'UnitData.xml');
    expect(file.entries[0]?.line).toBe(3);
  });

  it('rejects a file that is not a catalog', () => {
    expect(() => parseCatalogFile('<NotACatalog/>', 'x.xml')).toThrow(SC2Error);
  });

  it('reports non-entry elements rather than dropping them silently', () => {
    const file = parseCatalogFile('<Catalog><Something/></Catalog>', 'x.xml');
    expect(file.unrecognizedElements).toEqual(['Something']);
    expect(file.entries).toEqual([]);
  });
});

describe('CatalogIndex', () => {
  it('indexes entries by domain and id', () => {
    const index = buildIndex();

    expect(index.get('Unit', 'Broodling2')?.ctype).toBe('CUnit');
    expect(index.get('Weapon', 'BroodlingWeapon')?.ctype).toBe('CWeaponLegacy');
    // The domain is the prefix, not the concrete type.
    expect(index.get('Abil', 'TestInstant')?.ctype).toBe('CAbilEffectInstant');
    expect(index.get('CAbilEffectInstant', 'TestInstant')).toBeNull();
  });

  it('counts domains actually present', () => {
    expect(buildIndex().domains()).toEqual([
      { domain: 'Abil', count: 1 },
      { domain: 'Unit', count: 2 },
      { domain: 'Weapon', count: 1 },
    ]);
  });

  it('turns a broken file into a diagnostic instead of failing the whole index', () => {
    const index = CatalogIndex.build([
      { path: 'good.xml', content: UNIT_DATA },
      { path: 'broken.xml', content: '<Catalog><CUnit id="Oops">' },
    ]);

    // One broken catalog must not make the other forty unusable.
    expect(index.get('Unit', 'Broodling2')).not.toBeNull();
    expect(index.diagnostics.some((entry) => entry.severity === 'error' && entry.path === 'broken.xml')).toBe(true);
  });

  it('warns about a duplicate id and keeps the later definition', () => {
    const index = CatalogIndex.build([
      { path: 'a.xml', content: '<Catalog><CUnit id="Dup"><LifeMax value="1"/></CUnit></Catalog>' },
      { path: 'b.xml', content: '<Catalog><CUnit id="Dup"><LifeMax value="2"/></CUnit></Catalog>' },
    ]);

    expect(index.get('Unit', 'Dup')?.sourcePath).toBe('b.xml');
    expect(index.diagnostics.some((entry) => entry.message.includes('Duplicate catalog id'))).toBe(true);
  });

  it('warns about an entry whose domain it does not recognise, without dropping the file', () => {
    const index = CatalogIndex.build([{ path: 'x.xml', content: '<Catalog><CMadeUpThing id="X"/></Catalog>' }]);
    expect(index.diagnostics.some((entry) => entry.message.includes('does not recognise'))).toBe(true);
  });
});

describe('CatalogIndex.search', () => {
  it('matches ids case-insensitively', () => {
    expect(buildIndex().search({ query: 'brood' }).total).toBe(3);
  });

  it('puts prefix matches first, then sorts deterministically', () => {
    const results = buildIndex().search({ query: 'brood' }).results;
    // "BroodlingDefault"/"Broodling2" start with the query; "BroodlingWeapon" does too,
    // so ordering falls through to domain then id — and must be stable across calls.
    expect(results.map((entry) => `${entry.domain}/${entry.id}`)).toEqual([
      'Unit/Broodling2',
      'Unit/BroodlingDefault',
      'Weapon/BroodlingWeapon',
    ]);
  });

  it('filters by domain', () => {
    const search = buildIndex().search({ query: 'brood', domains: ['Weapon'] });
    expect(search.total).toBe(1);
    expect(search.results[0]?.id).toBe('BroodlingWeapon');
  });

  it('paginates without losing or repeating entries', () => {
    const index = buildIndex();
    const first = index.search({ limit: 2, offset: 0 });
    const second = index.search({ limit: 2, offset: 2 });

    expect(first.results).toHaveLength(2);
    expect(first.total).toBe(4);
    const ids = [...first.results, ...second.results].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('CatalogIndex.resolve', () => {
  it('walks the parent chain and lets the nearest definition win', () => {
    const resolved = buildIndex().resolve('Unit', 'Broodling2');

    expect(resolved.parentChain).toEqual(['BroodlingDefault']);
    const byPath = new Map(resolved.fields.map((field) => [field.path, field]));

    // Overridden on the child.
    expect(byPath.get('LifeMax')?.value).toBe('45');
    expect(byPath.get('LifeMax')?.definedBy).toBe('Unit/Broodling2');
    // Inherited from the parent, and said so — which is what decides whether editing it
    // is safe (PLAN.md §45).
    expect(byPath.get('Speed')?.value).toBe('4');
    expect(byPath.get('Speed')?.definedBy).toBe('Unit/BroodlingDefault');
  });

  it('reports a parent it cannot find as unresolved, not as absent', () => {
    const index = CatalogIndex.build([
      { path: 'x.xml', content: '<Catalog><CUnit id="Child" parent="LivesInADependency"><LifeMax value="1"/></CUnit></Catalog>' },
    ]);
    const resolved = index.resolve('Unit', 'Child');

    expect(resolved.unresolvedParents).toEqual(['LivesInADependency']);
    expect(resolved.parentChain).toEqual([]);
  });

  it('stops on a parent cycle instead of looping', () => {
    const index = CatalogIndex.build([
      { path: 'x.xml', content: '<Catalog><CUnit id="A" parent="B"/><CUnit id="B" parent="A"/></Catalog>' },
    ]);
    const resolved = index.resolve('Unit', 'A');

    expect(resolved.unresolvedParents).toEqual(['A (cycle)']);
  });

  it('throws SC2_NOT_FOUND with a usable suggestion for an unknown object', () => {
    let thrown: unknown;
    try {
      buildIndex().resolve('Unit', 'NoSuchUnit');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SC2Error);
    expect((thrown as SC2Error).code).toBe('SC2_NOT_FOUND');
    // "Not in this document" is not "does not exist", and the message has to say so.
    expect((thrown as SC2Error).details.suggestedAction).toContain('dependency');
  });
});

describe('CatalogIndex.findReferences', () => {
  it('finds Link references, value references, and parent links', () => {
    const references = buildIndex().findReferences('Weapon', 'BroodlingWeapon');

    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({ from: 'Unit/Broodling2', fieldPath: 'WeaponArray[0]', via: 'Link' });
  });

  it('reports a parent link as a reference', () => {
    const references = buildIndex().findReferences('Unit', 'BroodlingDefault');
    expect(references.some((reference) => reference.via === 'parent' && reference.from === 'Unit/Broodling2')).toBe(true);
  });

  it('matches across domains, because SC2 references are untyped strings', () => {
    // Both a weapon and an ability point at the same effect id. Being over-inclusive is
    // deliberate: a false negative here breaks the map.
    const references = buildIndex().findReferences('Effect', 'BroodlingWeaponDamage');

    expect(references.map((reference) => reference.from).sort()).toEqual(['Abil/TestInstant', 'Weapon/BroodlingWeapon']);
  });

  it('returns nothing for an unreferenced object', () => {
    expect(buildIndex().findReferences('Unit', 'Broodling2')).toEqual([]);
  });
});
