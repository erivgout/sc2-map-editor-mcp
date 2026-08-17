import { describe, expect, it } from 'vitest';

import { diffText, formatUnifiedDiff, looksBinary } from './diff.js';

describe('diffText', () => {
  it('reports no hunks for identical content', () => {
    const diff = diffText('a.xml', 'same\n', 'same\n');
    expect(diff.hunks).toEqual([]);
    expect(formatUnifiedDiff(diff)).toBe('');
  });

  it('finds a one-line change and counts it', () => {
    const diff = diffText('a.xml', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n');

    expect(diff.addedLines).toBe(1);
    expect(diff.removedLines).toBe(1);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]?.lines).toEqual([' one', '-two', '+TWO', ' three']);
  });

  it('handles a pure insertion', () => {
    const diff = diffText('a.xml', 'one\ntwo\n', 'one\ninserted\ntwo\n');
    expect(diff.addedLines).toBe(1);
    expect(diff.removedLines).toBe(0);
  });

  it('handles a pure deletion', () => {
    const diff = diffText('a.xml', 'one\ngone\ntwo\n', 'one\ntwo\n');
    expect(diff.addedLines).toBe(0);
    expect(diff.removedLines).toBe(1);
  });

  it('handles creation from nothing and deletion to nothing', () => {
    expect(diffText('a', '', 'a\nb\n').addedLines).toBe(2);
    expect(diffText('a', 'a\nb\n', '').removedLines).toBe(2);
  });

  it('produces a minimal edit script rather than replacing everything', () => {
    const before = Array.from({ length: 40 }, (_value, index) => `line ${index}`).join('\n');
    const after = before.replace('line 20', 'line twenty');
    const diff = diffText('a.xml', before, after);

    // A naive whole-file replacement would report 40/40. Myers finds the single line.
    expect(diff.addedLines).toBe(1);
    expect(diff.removedLines).toBe(1);
  });

  it('emits separate hunks for distant changes', () => {
    const before = Array.from({ length: 60 }, (_value, index) => `line ${index}`).join('\n');
    const after = before.replace('line 5', 'FIVE').replace('line 50', 'FIFTY');

    expect(diffText('a.xml', before, after).hunks).toHaveLength(2);
  });

  it('merges changes that are close together into one hunk', () => {
    const before = Array.from({ length: 20 }, (_value, index) => `line ${index}`).join('\n');
    const after = before.replace('line 5', 'FIVE').replace('line 7', 'SEVEN');

    expect(diffText('a.xml', before, after).hunks).toHaveLength(1);
  });

  it('reports binary content instead of diffing it', () => {
    const binary = 'abc\u0000def';
    const diff = diffText('minimap.tga', binary, `${binary}x`);

    expect(diff.binary).toBe(true);
    expect(diff.hunks).toEqual([]);
    expect(formatUnifiedDiff(diff)).toContain('Binary files differ');
  });

  it('refuses to diff a file above the line ceiling, and says so', () => {
    const huge = Array.from({ length: 50 }, (_value, index) => `line ${index}`).join('\n');
    const diff = diffText('big.xml', huge, `${huge}\nextra`, { maxLines: 10 });

    // Bounded work matters more than a perfect diff on a pathological input, but the
    // caller must be told rather than shown an empty result.
    expect(diff.truncated).toBe(true);
    expect(formatUnifiedDiff(diff)).toContain('too large to diff');
  });

  it('marks truncation when there are more hunks than the cap allows', () => {
    const before = Array.from({ length: 100 }, (_value, index) => `line ${index}`).join('\n');
    let after = before;
    for (const index of [5, 20, 35, 50, 65]) after = after.replace(`line ${index}`, `CHANGED ${index}`);

    const diff = diffText('a.xml', before, after, { maxHunks: 2 });
    expect(diff.hunks).toHaveLength(2);
    expect(diff.truncated).toBe(true);
    expect(formatUnifiedDiff(diff)).toContain('diff truncated');
  });

  it('is deterministic across repeated runs', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'a\nx\nc\ny\ne\n';
    const first = formatUnifiedDiff(diffText('a.xml', before, after));
    const second = formatUnifiedDiff(diffText('a.xml', before, after));

    expect(first).toBe(second);
  });

  it('treats CRLF and LF as the same line separator for hunk purposes', () => {
    // Line endings are compared byte-wise elsewhere (hashes); the diff is about content.
    const diff = diffText('a.xml', 'one\r\ntwo\r\n', 'one\r\nTWO\r\n');
    expect(diff.addedLines).toBe(1);
  });
});

describe('formatUnifiedDiff', () => {
  it('emits standard headers and hunk ranges', () => {
    const output = formatUnifiedDiff(diffText('Base.SC2Data/GameData/UnitData.xml', 'a\nb\nc\n', 'a\nB\nc\n'));

    expect(output).toContain('--- a/Base.SC2Data/GameData/UnitData.xml');
    expect(output).toContain('+++ b/Base.SC2Data/GameData/UnitData.xml');
    expect(output).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });
});

describe('looksBinary', () => {
  it('flags content containing a NUL byte', () => {
    expect(looksBinary('abc\u0000def')).toBe(true);
    expect(looksBinary('<Catalog></Catalog>')).toBe(false);
  });
});
