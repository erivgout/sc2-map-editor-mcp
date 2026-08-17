import { describe, expect, it } from 'vitest';

import { SC2Error } from '../errors.js';
import { TextEditBuffer, XmlEditor, detectNewline, indentationBefore } from './edit.js';
import { childElements, parseXml, type XmlElement } from './parse.js';

/**
 * Deliberately awkward: CRLF endings, a comment, an unusual attribute order, single
 * quotes, extra spacing, and no trailing newline. A "lossless" editor that normalises any
 * of these is not lossless (PLAN.md §12).
 */
const AWKWARD_SOURCE =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<Catalog>\r\n' +
  '    <!-- hand-written note the editor must not touch -->\r\n' +
  "    <CUnit parent='Base'   id=\"Marine\">\r\n" +
  '        <LifeMax value="45"/>\r\n' +
  '        <Speed value="2.25"/>\r\n' +
  '    </CUnit>\r\n' +
  '</Catalog>';

function unitElement(source: string): XmlElement {
  const document = parseXml(source);
  return childElements(document.root!, 'CUnit')[0]!;
}

describe('TextEditBuffer', () => {
  it('returns the source unchanged when there are no edits', () => {
    expect(new TextEditBuffer('hello').apply()).toBe('hello');
  });

  it('applies several edits without offsets shifting under each other', () => {
    const buffer = new TextEditBuffer('aaa bbb ccc');
    buffer.replace({ start: 0, end: 3 }, 'XXXXXX', 'first');
    buffer.replace({ start: 8, end: 11 }, 'Z', 'third');

    expect(buffer.apply()).toBe('XXXXXX bbb Z');
  });

  it('rejects overlapping edits rather than picking one', () => {
    const buffer = new TextEditBuffer('abcdef');
    buffer.replace({ start: 0, end: 4 }, 'X', 'one');
    buffer.replace({ start: 2, end: 6 }, 'Y', 'two');

    // Two operations rewriting the same bytes have contradictory intent.
    expect(() => buffer.apply()).toThrow(SC2Error);
  });

  it('allows edits that merely touch', () => {
    const buffer = new TextEditBuffer('abcdef');
    buffer.replace({ start: 0, end: 3 }, 'X', 'one');
    buffer.replace({ start: 3, end: 6 }, 'Y', 'two');

    expect(buffer.apply()).toBe('XY');
  });

  it('rejects a span outside the source', () => {
    const buffer = new TextEditBuffer('abc');
    expect(() => {
      buffer.replace({ start: 0, end: 99 }, 'X', 'bad');
    }).toThrow(SC2Error);
  });

  it('keeps insertions at one offset in the order they were added', () => {
    const buffer = new TextEditBuffer('ac');
    buffer.insert(1, 'b1', 'first');
    buffer.insert(1, 'b2', 'second');
    expect(buffer.apply()).toBe('ab1b2c');
  });
});

describe('newline and indentation detection', () => {
  it('detects the convention actually in use', () => {
    expect(detectNewline('a\r\nb')).toBe('\r\n');
    expect(detectNewline('a\nb')).toBe('\n');
    expect(detectNewline('no newlines')).toBe('\n');
  });

  it('reports the indentation of the line an offset sits on', () => {
    const source = 'a\n    <b/>\n';
    expect(indentationBefore(source, source.indexOf('<b/>'))).toBe('    ');
    // Not at the start of a line: there is content before it, so there is no indent.
    expect(indentationBefore('xx <b/>', 3)).toBe('');
  });
});

describe('XmlEditor losslessness', () => {
  it('changes one attribute value and leaves every other byte identical', () => {
    const editor = new XmlEditor(AWKWARD_SOURCE);
    editor.setAttributeValue(childElements(unitElement(AWKWARD_SOURCE), 'LifeMax')[0]!, 'value', '125');
    const result = editor.apply();

    expect(result).toBe(AWKWARD_SOURCE.replace('<LifeMax value="45"/>', '<LifeMax value="125"/>'));

    // Spelled out, because these are the things a reserialising writer destroys.
    expect(result).toContain('hand-written note the editor must not touch');
    expect(result).toContain("parent='Base'   id=\"Marine\"");
    expect(result.endsWith('</Catalog>')).toBe(true);
    expect(result.split('\r\n')).toHaveLength(AWKWARD_SOURCE.split('\r\n').length);
  });

  it('preserves the author\'s quote character when changing a value', () => {
    const editor = new XmlEditor(AWKWARD_SOURCE);
    editor.setAttributeValue(unitElement(AWKWARD_SOURCE), 'parent', 'NewBase');

    expect(editor.apply()).toContain("parent='NewBase'");
  });

  it('escapes a value that contains markup characters', () => {
    const source = '<a v="x"/>';
    const editor = new XmlEditor(source);
    editor.setAttributeValue(parseXml(source).root!, 'v', 'a & b < c');

    expect(editor.apply()).toBe('<a v="a &amp; b &lt; c"/>');
  });

  it('adds an attribute at the end of the opening tag', () => {
    const source = '<a v="1">text</a>';
    const editor = new XmlEditor(source);
    editor.addAttribute(parseXml(source).root!, 'w', '2');

    expect(editor.apply()).toBe('<a v="1" w="2">text</a>');
  });

  it('adds an attribute to a self-closing element before the slash', () => {
    const source = '<a v="1"/>';
    const editor = new XmlEditor(source);
    editor.addAttribute(parseXml(source).root!, 'w', '2');

    expect(editor.apply()).toBe('<a v="1" w="2"/>');
  });

  it('refuses to add an attribute that already exists', () => {
    const source = '<a v="1"/>';
    const editor = new XmlEditor(source);
    expect(() => {
      editor.addAttribute(parseXml(source).root!, 'v', '2');
    }).toThrow(SC2Error);
  });

  it('removes an attribute along with its leading space', () => {
    const source = '<a v="1" w="2"/>';
    const editor = new XmlEditor(source);
    editor.removeAttribute(parseXml(source).root!, 'w');

    expect(editor.apply()).toBe('<a v="1"/>');
  });

  it('appends a child at the indentation its siblings use', () => {
    const editor = new XmlEditor(AWKWARD_SOURCE);
    editor.appendChild(unitElement(AWKWARD_SOURCE), '<Sight value="9"/>');
    const result = editor.apply();

    expect(result).toContain('        <Speed value="2.25"/>\r\n        <Sight value="9"/>\r\n    </CUnit>');
  });

  it('indents one level in when the parent has no element children yet', () => {
    const source = '<Catalog>\n    <CUnit id="X">\n    </CUnit>\n</Catalog>';
    const document = parseXml(source);
    const editor = new XmlEditor(source);
    editor.appendChild(childElements(document.root!, 'CUnit')[0]!, '<LifeMax value="1"/>');

    expect(editor.apply()).toContain('<CUnit id="X">\n        <LifeMax value="1"/>');
  });

  it('refuses to append to a self-closing element instead of silently rewriting it', () => {
    const source = '<a/>';
    const editor = new XmlEditor(source);
    expect(() => {
      editor.appendChild(parseXml(source).root!, '<b/>');
    }).toThrow(SC2Error);
  });

  it('removes an element and takes its whole line with it', () => {
    const editor = new XmlEditor(AWKWARD_SOURCE);
    editor.removeElement(childElements(unitElement(AWKWARD_SOURCE), 'LifeMax')[0]!);
    const result = editor.apply();

    // No blank indented line left behind.
    expect(result).not.toContain('LifeMax');
    expect(result).toContain('id="Marine">\r\n        <Speed value="2.25"/>');
  });

  it('removes only the element when something else shares its line', () => {
    const source = '<a><b/><c/></a>';
    const document = parseXml(source);
    const editor = new XmlEditor(source);
    editor.removeElement(childElements(document.root!, 'b')[0]!);

    expect(editor.apply()).toBe('<a><c/></a>');
  });

  it('inserts a sibling after an element at the same indentation', () => {
    const editor = new XmlEditor(AWKWARD_SOURCE);
    editor.insertAfter(unitElement(AWKWARD_SOURCE), '<CUnit id="Marine2"/>');

    expect(editor.apply()).toContain('    </CUnit>\r\n    <CUnit id="Marine2"/>\r\n</Catalog>');
  });

  it('combines several independent edits in one pass', () => {
    const source = AWKWARD_SOURCE;
    const unit = unitElement(source);
    const editor = new XmlEditor(source);

    editor.setAttributeValue(childElements(unit, 'LifeMax')[0]!, 'value', '125');
    editor.setAttributeValue(childElements(unit, 'Speed')[0]!, 'value', '3.0');
    editor.appendChild(unit, '<Sight value="9"/>');

    const result = editor.apply();
    expect(result).toContain('<LifeMax value="125"/>');
    expect(result).toContain('<Speed value="3.0"/>');
    expect(result).toContain('<Sight value="9"/>');
    expect(result).toContain('hand-written note');
  });

  it('reparses to the same structure after editing', () => {
    const editor = new XmlEditor(AWKWARD_SOURCE);
    editor.setAttributeValue(childElements(unitElement(AWKWARD_SOURCE), 'LifeMax')[0]!, 'value', '125');

    const reparsed = parseXml(editor.apply());
    const unit = childElements(reparsed.root!, 'CUnit')[0]!;
    expect(childElements(unit, 'LifeMax')[0]?.attributes[0]?.value).toBe('125');
  });

  it('summarises its pending edits for a change record', () => {
    const editor = new XmlEditor(AWKWARD_SOURCE);
    editor.setAttributeValue(childElements(unitElement(AWKWARD_SOURCE), 'LifeMax')[0]!, 'value', '125');

    expect(editor.summarize()).toEqual(['set LifeMax/@value = 125']);
  });
});
