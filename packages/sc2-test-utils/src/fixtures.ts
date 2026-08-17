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
    '<?xml version="1.0" encoding="utf-8"?>\r\n<DocInfo>\r\n    <Name>\r\n        <Value>Test Document</Value>\r\n    </Name>\r\n</DocInfo>\r\n',
  'ComponentList.SC2Components':
    '<?xml version="1.0" encoding="utf-8"?>\r\n<Components>\r\n    <DataComponent Type="gada" Path="Base.SC2Data"/>\r\n</Components>\r\n',
  'Base.SC2Data/GameData/UnitData.xml':
    '<?xml version="1.0" encoding="utf-8"?>\r\n<Catalog>\r\n    <CUnit id="TestMarine" parent="Marine">\r\n        <LifeMax value="45"/>\r\n    </CUnit>\r\n</Catalog>\r\n',
  'Base.SC2Data/LibTest.galaxy': 'void TestInit () {\n    // fixture marker\n}\n',
  'enUS.SC2Data/LocalizedData/GameStrings.txt': 'Unit/Name/TestMarine=Test Marine\r\n',
});

/** Writes {@link MINIMAL_DOCUMENT} into `<temp>/<name>` and returns the directory path. */
export async function writeMinimalDocument(temp: TempDir, name = 'TestMap.SC2Map'): Promise<string> {
  const documentPath = path.join(temp.path, 'source', name);
  await writeTree(documentPath, { ...MINIMAL_DOCUMENT });
  return documentPath;
}
