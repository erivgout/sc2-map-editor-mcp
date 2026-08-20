import { describe, expect, it } from 'vitest';

import { SC2Error } from '../errors.js';
import { cloneTriggerSubgraph, deleteTriggerSubgraph } from './mutate.js';
import { parseTriggerData } from './parse.js';

const TRIGGERS =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<TriggerData>\r\n' +
  '    <Root>\r\n' +
  '        <Item Type="Category" Id="AAAAAAAA"/>\r\n' +
  '    </Root>\r\n' +
  '    <Element Type="Category" Id="AAAAAAAA">\r\n' +
  '        <Item Type="Trigger" Id="BBBBBBBB"/>\r\n' +
  '    </Element>\r\n' +
  '    <Element Type="Trigger" Id="BBBBBBBB">\r\n' +
  '        <Event Type="FunctionCall" Id="CCCCCCCC"/>\r\n' +
  '        <Action Type="FunctionCall" Id="DDDDDDDD"/>\r\n' +
  '    </Element>\r\n' +
  '    <Element Type="FunctionCall" Id="CCCCCCCC">\r\n' +
  '        <FunctionDef Type="FunctionDef" Library="Ntve" Id="18377668"/>\r\n' +
  '        <Parameter Type="Param" Id="EEEEEEEE"/>\r\n' +
  '    </Element>\r\n' +
  '    <Element Type="FunctionCall" Id="DDDDDDDD">\r\n' +
  '        <FunctionDef Type="FunctionDef" Library="Ntve" Id="00000137"/>\r\n' +
  '        <Parameter Type="Param" Id="EEEEEEEE"/>\r\n' +
  '    </Element>\r\n' +
  '    <Element Type="Param" Id="EEEEEEEE">\r\n' +
  '        <ParameterDef Type="ParamDef" Library="Ntve" Id="B38CA56F"/>\r\n' +
  '        <Value>1</Value>\r\n' +
  '        <ValueId Id="BBBBBBBB"/>\r\n' +
  '        <ValueType Type="int"/>\r\n' +
  '    </Element>\r\n' +
  '</TriggerData>\r\n';

function deterministicIds(): () => string {
  const ids = ['10000001', '10000002', '10000003', '10000004'];
  return () => ids.shift() ?? 'FFFFFFFF';
}

describe('trigger graph parsing and mutation', () => {
  it('follows relation-specific local references and excludes library ids', () => {
    const data = parseTriggerData(TRIGGERS);

    expect(data.elements.get('BBBBBBBB')?.childIds).toEqual(['CCCCCCCC', 'DDDDDDDD']);
    expect(data.elements.get('CCCCCCCC')?.childIds).toEqual(['EEEEEEEE']);
    expect(data.elements.get('CCCCCCCC')?.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: 'FunctionDef', id: '18377668', library: 'Ntve' }),
        expect.objectContaining({ tag: 'Parameter', id: 'EEEEEEEE', library: null }),
      ]),
    );
    expect(data.elements.get('EEEEEEEE')?.childIds).toEqual([]);
    expect(data.danglingIds).toEqual([]);
  });

  it('clones a complete editor-authored subgraph and remaps every local id', () => {
    const outcome = cloneTriggerSubgraph(TRIGGERS, {
      sourceId: 'BBBBBBBB',
      parentId: 'AAAAAAAA',
      generateId: deterministicIds(),
    });
    const data = parseTriggerData(outcome.content);

    expect([...outcome.idMap]).toEqual([
      ['BBBBBBBB', '10000001'],
      ['CCCCCCCC', '10000002'],
      ['DDDDDDDD', '10000003'],
      ['EEEEEEEE', '10000004'],
    ]);
    expect(data.elements.get('AAAAAAAA')?.childIds).toEqual(['BBBBBBBB', '10000001']);
    expect(data.elements.get('10000001')?.childIds).toEqual(['10000002', '10000003']);
    expect(data.elements.get('10000002')?.childIds).toEqual(['10000004']);
    expect(data.elements.get('10000003')?.childIds).toEqual(['10000004']);
    expect(data.elements.get('10000002')?.references[0]).toMatchObject({ id: '18377668', library: 'Ntve' });
    expect(outcome.content).toContain('<ValueId Id="BBBBBBBB"/>');
    expect(data.danglingIds).toEqual([]);
  });

  it('deletes the cloned branch and restores the original bytes', () => {
    const cloned = cloneTriggerSubgraph(TRIGGERS, {
      sourceId: 'BBBBBBBB',
      parentId: 'AAAAAAAA',
      generateId: deterministicIds(),
    });
    const deleted = deleteTriggerSubgraph(cloned.content, { id: cloned.clonedRootId, parentId: 'AAAAAAAA' });

    expect(deleted.removedIds).toEqual(['10000001', '10000002', '10000003', '10000004']);
    expect(deleted.content).toBe(TRIGGERS);
  });

  it('preserves a descendant that another branch still references', () => {
    const withSecondTrigger = TRIGGERS.replace(
      '        <Item Type="Trigger" Id="BBBBBBBB"/>',
      '        <Item Type="Trigger" Id="BBBBBBBB"/>\r\n        <Item Type="Trigger" Id="99999999"/>',
    ).replace(
      '</TriggerData>',
      '    <Element Type="Trigger" Id="99999999">\r\n        <Action Type="Param" Id="EEEEEEEE"/>\r\n    </Element>\r\n</TriggerData>',
    );

    const deleted = deleteTriggerSubgraph(withSecondTrigger, { id: 'BBBBBBBB', parentId: 'AAAAAAAA' });
    const data = parseTriggerData(deleted.content);

    expect(deleted.removedIds).toEqual(['BBBBBBBB', 'CCCCCCCC', 'DDDDDDDD']);
    expect(data.elements.has('EEEEEEEE')).toBe(true);
    expect(data.elements.get('99999999')?.childIds).toEqual(['EEEEEEEE']);
  });

  it('requires a parent when an element has several incoming references', () => {
    const shared = TRIGGERS.replace(
      '        <Item Type="Trigger" Id="BBBBBBBB"/>',
      '        <Item Type="Trigger" Id="BBBBBBBB"/>\r\n        <Item Type="Trigger" Id="BBBBBBBB"/>',
    );
    expect(() => cloneTriggerSubgraph(shared, { sourceId: 'BBBBBBBB' })).toThrow(SC2Error);
  });

  it('rejects duplicate element ids before mutation', () => {
    const duplicate = TRIGGERS.replace('</TriggerData>', '    <Element Type="Trigger" Id="BBBBBBBB"/>\r\n</TriggerData>');
    expect(() => parseTriggerData(duplicate)).toThrow(SC2Error);
  });
});
