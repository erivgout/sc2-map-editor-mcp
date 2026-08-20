import { describe, expect, it } from 'vitest';

import { applyLayoutPatch, createLayout, parseLayout, searchLayout } from './layout.js';

const SOURCE =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<Desc>\r\n' +
  '    <Frame type="Frame" name="Root">\r\n' +
  '        <Frame type="Label" name="Title"><Text val="Hello"/></Frame>\r\n' +
  '    </Frame>\r\n' +
  '</Desc>\r\n';

describe('SC2Layout', () => {
  it('indexes frame definitions and searches their attributes', () => {
    const parsed = parseLayout(SOURCE, 'Test.SC2Layout');
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.elements.filter((element) => element.element === 'Frame')).toHaveLength(2);
    expect(searchLayout(SOURCE, 'Test.SC2Layout', 'title')).toEqual([
      expect.objectContaining({ element: 'Frame', name: 'Title', type: 'Label' }),
    ]);
  });

  it('patches only the selected attribute bytes', () => {
    const outcome = applyLayoutPatch(
      SOURCE,
      'Test.SC2Layout',
      { element: 'Frame', attributes: { name: 'Title' } },
      { op: 'set_attribute', name: 'type', value: 'Button' },
    );
    expect(outcome.content).toBe(SOURCE.replace('type="Label" name="Title"', 'type="Button" name="Title"'));
  });

  it('creates an empty valid layout', () => {
    expect(parseLayout(createLayout().content).diagnostics).toEqual([]);
  });

  it('supports child insertion and content replacement without reserializing the file', () => {
    const appended = applyLayoutPatch(SOURCE, 'Test.SC2Layout', { element: 'Desc' }, {
      op: 'append_child',
      xml: '<Frame type="Button" name="Added"/>',
    }).content;
    expect(appended).toContain('<Frame type="Button" name="Added"/>');
    expect(appended.startsWith(SOURCE.slice(0, SOURCE.indexOf('</Desc>')))).toBe(true);

    const replaced = applyLayoutPatch(
      SOURCE,
      'Test.SC2Layout',
      { element: 'Frame', attributes: { name: 'Title' } },
      { op: 'replace_content', xml: '<Text val="Goodbye"/>' },
    ).content;
    expect(replaced).toBe(SOURCE.replace('<Text val="Hello"/>', '<Text val="Goodbye"/>'));
  });

  it('supports element replacement, deletion, and safe attribute removal', () => {
    const replaced = applyLayoutPatch(
      SOURCE,
      'Test.SC2Layout',
      { element: 'Frame', attributes: { name: 'Title' } },
      { op: 'replace_element', xml: '<Frame type="Image" name="Title"/>' },
    ).content;
    expect(replaced).toContain('<Frame type="Image" name="Title"/>');

    const deleted = applyLayoutPatch(
      SOURCE,
      'Test.SC2Layout',
      { element: 'Frame', attributes: { name: 'Title' } },
      { op: 'delete_element' },
    ).content;
    expect(deleted).not.toContain('name="Title"');

    const removed = applyLayoutPatch(
      SOURCE,
      'Test.SC2Layout',
      { element: 'Frame', attributes: { name: 'Title' } },
      { op: 'remove_attribute', name: 'type' },
    ).content;
    expect(removed).toBe(SOURCE.replace(' type="Label"', ''));
  });

  it('rejects a frame without a name after a patch', () => {
    expect(() =>
      applyLayoutPatch(
        SOURCE,
        'Test.SC2Layout',
        { element: 'Frame', attributes: { name: 'Title' } },
        { op: 'remove_attribute', name: 'name' },
      ),
    ).toThrow(/structural error/i);
  });
});
