/**
 * Generated document fixtures (PLAN.md §38).
 *
 * These are **project-authored placeholders**, not real editor output. They contain no
 * Blizzard content, so they are safe to commit and to generate in CI (PLAN.md §3,
 * §55 rule 9).
 *
 * What they are good for: exercising staging, path handling, file listing, hashing,
 * and transaction machinery — anything that treats document contents as opaque bytes.
 *
 * What they are NOT good for: validating parsers or codecs. PLAN.md §55 rule 1 is
 * explicit that format behaviour must be verified against real self-authored editor
 * output. A parser that passes only against these fixtures has proven nothing.
 */

import path from 'node:path';

import { writeTree, type TempDir } from './temp.js';

/**
 * A minimal unpacked document skeleton.
 *
 * CRLF endings are deliberate: SC2 editor output uses them, and losing them is one of
 * the ways a "lossless" writer quietly stops being lossless (PLAN.md §12).
 */
export const MINIMAL_DOCUMENT: Readonly<Record<string, string>> = Object.freeze({
  DocumentInfo:
    '<?xml version="1.0" encoding="utf-8"?>\r\n<DocInfo>\r\n' +
    '    <Name>\r\n        <Value>Test Document</Value>\r\n    </Name>\r\n' +
    '    <ModType>\r\n        <Value>Interface</Value>\r\n    </ModType>\r\n' +
    '    <Dependencies>\r\n' +
    '        <Value>bnet:Void Multi (Mod)/0.0/999,file:Mods/VoidMulti.SC2Mod</Value>\r\n' +
    '    </Dependencies>\r\n' +
    '</DocInfo>\r\n',
  // Shape verified against the unpacked EditorTest.SC2Map that ships with StarCraft II:
  // the path is the element's TEXT CONTENT, not an attribute, and the file has NO
  // trailing newline. Both details are exactly what a lossless writer must preserve.
  'ComponentList.SC2Components':
    '<?xml version="1.0" encoding="utf-8"?>\r\n<Components>\r\n' +
    '    <DataComponent Type="gada">GameData</DataComponent>\r\n' +
    '    <DataComponent Type="text" Locale="enUS">GameText</DataComponent>\r\n' +
    '    <DataComponent Type="info">DocumentInfo</DataComponent>\r\n' +
    '</Components>',
  // A two-level parent chain plus a shared weapon, so inheritance resolution and
  // reference finding have something real to work on. Field shapes match observed editor
  // output: `value=` scalars, `Link=` references, and `index=` array elements.
  'Base.SC2Data/GameData/UnitData.xml':
    '<?xml version="1.0" encoding="utf-8"?>\r\n<Catalog>\r\n' +
    '    <CUnit id="TestMarineBase">\r\n' +
    '        <LifeMax value="45"/>\r\n' +
    '        <Speed value="2.25"/>\r\n' +
    '    </CUnit>\r\n' +
    '    <CUnit id="TestMarine" parent="TestMarineBase">\r\n' +
    '        <LifeMax value="60"/>\r\n' +
    '        <WeaponArray index="0" Link="TestRifle"/>\r\n' +
    '    </CUnit>\r\n' +
    '    <CUnit id="TestReaper" parent="TestMarineBase">\r\n' +
    '        <WeaponArray index="0" Link="TestRifle"/>\r\n' +
    '    </CUnit>\r\n' +
    '</Catalog>\r\n',
  // Weapon -> Effect -> Amount, wired the way real editor output does it. Two details
  // taken from the shipped EditorTest.SC2Map: the weapon names its effect through
  // `Effect value=` (not `Link=`), and the damage lives on a separate CEffectDamage.
  'Base.SC2Data/GameData/WeaponData.xml':
    '<?xml version="1.0" encoding="utf-8"?>\r\n<Catalog>\r\n' +
    '    <CWeaponLegacy id="TestRifle">\r\n' +
    '        <Effect value="TestRifleDamage"/>\r\n' +
    '    </CWeaponLegacy>\r\n' +
    '</Catalog>\r\n',
  'Base.SC2Data/GameData/EffectData.xml':
    '<?xml version="1.0" encoding="utf-8"?>\r\n<Catalog>\r\n' +
    '    <CEffectDamage id="TestRifleDamage">\r\n' +
    '        <Amount value="5"/>\r\n' +
    '    </CEffectDamage>\r\n' +
    '</Catalog>\r\n',
  'Base.SC2Data/LibTest.galaxy': 'void TestInit () {\n    // fixture marker\n}\n',
  'enUS.SC2Data/LocalizedData/GameStrings.txt': 'Unit/Name/TestMarine=Test Marine\r\n',
});

/** Writes {@link MINIMAL_DOCUMENT} into `<temp>/<name>` and returns the directory path. */
export async function writeMinimalDocument(temp: TempDir, name = 'TestMap.SC2Map'): Promise<string> {
  const documentPath = path.join(temp.path, 'source', name);
  await writeTree(documentPath, { ...MINIMAL_DOCUMENT });
  return documentPath;
}
