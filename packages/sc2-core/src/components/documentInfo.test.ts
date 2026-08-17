import { describe, expect, it } from 'vitest';

import { SC2Error } from '../errors.js';
import { parseDocumentInfo } from './documentInfo.js';

/**
 * Taken from the unpacked `EditorTest.SC2Map` that ships with StarCraft II. Note what it
 * does *not* contain: no `<Name>`, no `<Author>`. Real documents omit fields freely, which
 * is why every field in the model is nullable.
 */
const REAL_DOCUMENT_INFO =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<DocInfo>\r\n' +
  '    <ModType>\r\n        <Value>Interface</Value>\r\n    </ModType>\r\n' +
  '    <Icon>\r\n        <Value>c80[1].tga</Value>\r\n    </Icon>\r\n' +
  '    <Dependencies>\r\n' +
  '        <Value>bnet:Void Multi (Mod)/0.0/999,file:Mods/VoidMulti.SC2Mod</Value>\r\n' +
  '        <Value>bnet:Nova Covert Ops (Art Mod)/0.0/999,file:Mods/NovaStoryAssets.SC2Mod</Value>\r\n' +
  '        <Value>bnet:Co-op Mission/0.0/999,file:Mods/StarCoop/StarCoop.SC2Mod</Value>\r\n' +
  '    </Dependencies>\r\n' +
  '    <Screenshot>\r\n' +
  '        <File>\r\n            <Value>unknown[2].tga</Value>\r\n        </File>\r\n' +
  '        <CaptionId>\r\n            <Value>1</Value>\r\n        </CaptionId>\r\n' +
  '        <Flags>\r\n            <Value> </Value>\r\n        </Flags>\r\n' +
  '    </Screenshot>\r\n' +
  '</DocInfo>\r\n';

describe('parseDocumentInfo', () => {
  it('reads scalar fields out of their <Value> wrappers', () => {
    const info = parseDocumentInfo(REAL_DOCUMENT_INFO);

    expect(info.modType).toBe('Interface');
    expect(info.icon).toBe('c80[1].tga');
  });

  it('reports absent fields as null, not as empty strings', () => {
    // "not set" and "set to nothing" are different, and only one of them is a bug.
    const info = parseDocumentInfo(REAL_DOCUMENT_INFO);

    expect(info.name).toBeNull();
    expect(info.author).toBeNull();
    expect(info.description).toBeNull();
  });

  it('preserves a whitespace-only value rather than collapsing it to null', () => {
    const info = parseDocumentInfo(REAL_DOCUMENT_INFO);
    expect(info.screenshot?.flags).toBe(' ');
  });

  it('keeps dependencies in declaration order, which is resolution order', () => {
    const info = parseDocumentInfo(REAL_DOCUMENT_INFO);

    expect(info.dependencies.map((dependency) => dependency.name)).toEqual([
      'Void Multi (Mod)',
      'Nova Covert Ops (Art Mod)',
      'Co-op Mission',
    ]);
  });

  it('splits each dependency into its bnet identity and file fallback, keeping the raw text', () => {
    const info = parseDocumentInfo(REAL_DOCUMENT_INFO);
    const first = info.dependencies[0]!;

    expect(first.bnet).toBe('Void Multi (Mod)/0.0/999');
    expect(first.file).toBe('Mods/VoidMulti.SC2Mod');
    // The raw string is retained because exact spelling and order decide which archive
    // supplies a value (PLAN.md §25).
    expect(first.raw).toBe('bnet:Void Multi (Mod)/0.0/999,file:Mods/VoidMulti.SC2Mod');
  });

  it('handles a dependency with a file path containing slashes', () => {
    const info = parseDocumentInfo(REAL_DOCUMENT_INFO);
    expect(info.dependencies[2]?.file).toBe('Mods/StarCoop/StarCoop.SC2Mod');
  });

  it('reads the nested screenshot structure', () => {
    const info = parseDocumentInfo(REAL_DOCUMENT_INFO);

    expect(info.screenshot).toEqual({ file: 'unknown[2].tga', captionId: '1', flags: ' ' });
    expect(info.screenshotHowToPlay).toBeNull();
  });

  it('surfaces top-level elements it does not model instead of dropping them', () => {
    const info = parseDocumentInfo(
      '<DocInfo><SomethingNew><Value>42</Value></SomethingNew></DocInfo>',
    );

    // PLAN.md §47: unknown data must be preserved, not deleted.
    expect(info.unrecognizedFields).toEqual({ SomethingNew: '42' });
  });

  it('returns an empty dependency list when there are none', () => {
    const info = parseDocumentInfo('<DocInfo><Name><Value>Solo</Value></Name></DocInfo>');
    expect(info.dependencies).toEqual([]);
    expect(info.name).toBe('Solo');
  });

  it('rejects a file whose root element is not <DocInfo>', () => {
    expect(() => parseDocumentInfo('<NotDocInfo/>')).toThrow(SC2Error);
  });
});
