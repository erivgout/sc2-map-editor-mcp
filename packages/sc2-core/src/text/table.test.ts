import { describe, expect, it } from 'vitest';

import { SC2Error } from '../errors.js';
import { findTextTables, localesFrom } from './service.js';
import { UTF8_BOM, applyTextEdits, displayNameKey, parseTextKey, parseTextTable } from './table.js';

/**
 * Byte-shaped like the real `GameStrings.txt` from the editor-produced map that ships with
 * StarCraft II: UTF-8 BOM, CRLF endings, trailing newline, and a value containing both `=`
 * and markup.
 */
const TABLE =
  UTF8_BOM +
  'Unit/Name/Marine=Marine\r\n' +
  'Unit/Name/Reaper=Reaper\r\n' +
  'Abil/TargetMessage/attack=<IMG path="Assets\\Textures\\x.dds" alignment="absolutemiddle"/>   To Attack\r\n';

const PATH = 'enUS.SC2Data/LocalizedData/GameStrings.txt';

describe('parseTextTable', () => {
  it('reads entries and records the BOM and line ending convention', () => {
    const table = parseTextTable(TABLE, PATH);

    expect(table.entries).toHaveLength(3);
    expect(table.hasBom).toBe(true);
    expect(table.newline).toBe('\r\n');
    expect(table.endsWithNewline).toBe(true);
  });

  it('splits on the FIRST equals sign, so values may contain more', () => {
    const table = parseTextTable(TABLE, PATH);
    const entry = table.byKey.get('Abil/TargetMessage/attack');

    // Splitting on every '=' would truncate this at the first attribute.
    expect(entry?.value).toBe('<IMG path="Assets\\Textures\\x.dds" alignment="absolutemiddle"/>   To Attack');
  });

  it('records offsets that slice back to the exact value', () => {
    const table = parseTextTable(TABLE, PATH);
    const entry = table.byKey.get('Unit/Name/Marine')!;

    expect(TABLE.slice(entry.valueStart, entry.valueEnd)).toBe('Marine');
    expect(TABLE.slice(entry.start, entry.end)).toBe('Unit/Name/Marine=Marine');
  });

  it('reports 1-based line numbers', () => {
    expect(parseTextTable(TABLE, PATH).byKey.get('Unit/Name/Reaper')?.line).toBe(2);
  });

  it('keeps the last definition of a duplicate key and reports the duplication', () => {
    const table = parseTextTable('A=one\r\nA=two\r\n', PATH);

    expect(table.byKey.get('A')?.value).toBe('two');
    expect(table.duplicateKeys).toEqual(['A']);
  });

  it('records lines that are not key/value pairs rather than discarding them', () => {
    const table = parseTextTable('// a comment\r\nA=one\r\n', PATH);

    expect(table.unparsedLines).toEqual([{ line: 1, text: '// a comment' }]);
    expect(table.entries).toHaveLength(1);
  });

  it('handles a file with no BOM and LF endings', () => {
    const table = parseTextTable('A=one\nB=two', PATH);

    expect(table.hasBom).toBe(false);
    expect(table.newline).toBe('\n');
    expect(table.endsWithNewline).toBe(false);
    expect(table.byKey.get('B')?.value).toBe('two');
  });
});

describe('applyTextEdits', () => {
  it('updates a value in place, preserving the BOM and everything else', () => {
    const table = parseTextTable(TABLE, PATH);
    const outcome = applyTextEdits(table, [{ op: 'set', key: 'Unit/Name/Marine', value: 'Rail Marine' }]);

    expect(outcome.content).toBe(TABLE.replace('Unit/Name/Marine=Marine', 'Unit/Name/Marine=Rail Marine'));
    expect(outcome.content.startsWith(UTF8_BOM)).toBe(true);
    expect(outcome.summary[0]).toContain('"Marine" -> "Rail Marine"');
  });

  it('keeps an edited key in its original position', () => {
    const table = parseTextTable(TABLE, PATH);
    const outcome = applyTextEdits(table, [{ op: 'set', key: 'Unit/Name/Marine', value: 'X' }]);
    const edited = parseTextTable(outcome.content, PATH);

    expect(edited.entries.map((entry) => entry.key)).toEqual(table.entries.map((entry) => entry.key));
  });

  it('appends a new key at the end, matching the file line ending', () => {
    const table = parseTextTable(TABLE, PATH);
    const outcome = applyTextEdits(table, [{ op: 'set', key: 'Unit/Name/Ghost', value: 'Ghost' }]);

    expect(outcome.content.endsWith('Unit/Name/Ghost=Ghost\r\n')).toBe(true);
    expect(parseTextTable(outcome.content, PATH).entries).toHaveLength(4);
  });

  it('adds a line ending first when the file lacks a trailing newline', () => {
    const table = parseTextTable('A=one', PATH);
    const outcome = applyTextEdits(table, [{ op: 'set', key: 'B', value: 'two' }]);

    // Without this, the new entry would be glued onto the previous line.
    expect(outcome.content).toBe('A=one\nB=two');
  });

  it('reports setting a value to what it already holds as a no-op', () => {
    const table = parseTextTable(TABLE, PATH);
    const outcome = applyTextEdits(table, [{ op: 'set', key: 'Unit/Name/Marine', value: 'Marine' }]);

    expect(outcome.content).toBe(TABLE);
    expect(outcome.summary).toEqual([]);
    expect(outcome.noOps).toHaveLength(1);
  });

  it('deletes a key and its whole line', () => {
    const table = parseTextTable(TABLE, PATH);
    const outcome = applyTextEdits(table, [{ op: 'delete', key: 'Unit/Name/Reaper' }]);

    expect(outcome.content).not.toContain('Reaper');
    // No blank line left where it was.
    expect(outcome.content).toContain('Unit/Name/Marine=Marine\r\nAbil/TargetMessage/attack=');
  });

  it('treats deleting an absent key as a no-op', () => {
    const table = parseTextTable(TABLE, PATH);
    const outcome = applyTextEdits(table, [{ op: 'delete', key: 'Not/There' }]);

    expect(outcome.content).toBe(TABLE);
    expect(outcome.noOps).toHaveLength(1);
  });

  it('applies several edits at once without offsets shifting under each other', () => {
    const table = parseTextTable(TABLE, PATH);
    const outcome = applyTextEdits(table, [
      { op: 'set', key: 'Unit/Name/Marine', value: 'A much longer name than before' },
      { op: 'set', key: 'Unit/Name/Reaper', value: 'R' },
      { op: 'set', key: 'Unit/Name/New', value: 'N' },
    ]);

    const edited = parseTextTable(outcome.content, PATH);
    expect(edited.byKey.get('Unit/Name/Marine')?.value).toBe('A much longer name than before');
    expect(edited.byKey.get('Unit/Name/Reaper')?.value).toBe('R');
    expect(edited.byKey.get('Unit/Name/New')?.value).toBe('N');
    expect(edited.byKey.get('Abil/TargetMessage/attack')?.value).toContain('To Attack');
  });

  it('refuses a value containing a newline, which would split the entry in two', () => {
    const table = parseTextTable(TABLE, PATH);
    expect(() => applyTextEdits(table, [{ op: 'set', key: 'A', value: 'one\ntwo' }])).toThrow(SC2Error);
  });

  it('refuses a key containing an equals sign', () => {
    const table = parseTextTable(TABLE, PATH);
    expect(() => applyTextEdits(table, [{ op: 'set', key: 'A=B', value: 'x' }])).toThrow(SC2Error);
  });

  it('refuses to add the same new key twice in one request', () => {
    const table = parseTextTable(TABLE, PATH);
    expect(() =>
      applyTextEdits(table, [
        { op: 'set', key: 'New', value: 'one' },
        { op: 'set', key: 'New', value: 'two' },
      ]),
    ).toThrow(SC2Error);
  });
});

describe('key helpers', () => {
  it('splits a well-formed key', () => {
    expect(parseTextKey('Unit/Name/Marine')).toEqual({ category: 'Unit', field: 'Name', objectId: 'Marine' });
  });

  it('returns null for a key that does not have three parts', () => {
    expect(parseTextKey('NotAKey')).toBeNull();
  });

  it('builds the conventional display-name key', () => {
    expect(displayNameKey('Unit', 'RailMarine')).toBe('Unit/Name/RailMarine');
  });
});

describe('findTextTables', () => {
  const files = [
    { relativePath: 'enUS.SC2Data/LocalizedData/GameStrings.txt', size: 100 },
    { relativePath: 'enUS.SC2Data/LocalizedData/ObjectStrings.txt', size: 50 },
    { relativePath: 'deDE.SC2Data/LocalizedData/GameStrings.txt', size: 80 },
    { relativePath: 'Base.SC2Data/GameData/UnitData.xml', size: 10 },
    { relativePath: 'DocumentInfo', size: 5 },
    { relativePath: 'enUS.SC2Data/LocalizedData/notes.md', size: 5 },
  ];

  it('finds only the localized .txt tables', () => {
    expect(findTextTables(files).map((table) => table.path)).toEqual([
      'deDE.SC2Data/LocalizedData/GameStrings.txt',
      'enUS.SC2Data/LocalizedData/GameStrings.txt',
      'enUS.SC2Data/LocalizedData/ObjectStrings.txt',
    ]);
  });

  it('derives the locale and table name from the path', () => {
    const table = findTextTables(files).find((candidate) => candidate.locale === 'deDE');
    expect(table?.table).toBe('GameStrings');
  });

  it('lists locales, excluding the non-localized Base layer', () => {
    expect(localesFrom(findTextTables(files))).toEqual(['deDE', 'enUS']);
  });
});
