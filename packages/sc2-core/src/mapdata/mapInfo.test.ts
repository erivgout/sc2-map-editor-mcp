import { describe, expect, it } from 'vitest';

import { parseMapInfo, setMapPlayerSlots, setPlayerAttributeSlots } from './mapInfo.js';

const EDITOR_MAP_INFO = Buffer.from(
  'SXBhTScAAAA2UwMAAAAAAAABAAAAAQAAAQAAAAEAAAAAAAEAAAAAAAAARGFyawBTaGFrdXJhcwAKAAAACAAAAPYAAADsAAAAAHgAAAAAAAAAAAAAAAAA/////wAAAAAAAAAAIAMAAFgCAAAAAAAAAABAAAABAAAAAgAAAAAgAAAAAAAAAAAAABAAAAAAAAAIAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAABAQAAAP////8AAAAAAAAAAAAAAAAAAAIBAAAA/////wAAAAAAAAAAAAAAAAAAAwEAAAD/////AAAAAAAAAAAAAAAAAAAEAQAAAP////8AAAAAAAAAAAAAAAAAAAUBAAAA/////wAAAAAAAAAAAAAAAAAADgIAAAD/////WmVyZwAAAAAAfVMkOXBtb0MADwQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'base64',
);

const ATTRIBUTES =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<Attributes>\r\n' +
  '    <Attribute>\r\n' +
  '        <Type Value="Player"/>\r\n' +
  '        <Default><Slot Id="0"/><Value Id="1"/></Default>\r\n' +
  '        <Default><Slot Id="1"/><Value Id="1"/></Default>\r\n' +
  '        <Default><Slot Id="2"/><Value Id="1"/></Default>\r\n' +
  '        <Default><Slot Id="3"/><Value Id="1"/></Default>\r\n' +
  '        <Default><Slot Id="4"/><Value Id="1"/></Default>\r\n' +
  '    </Attribute>\r\n' +
  '</Attributes>\r\n';

describe('MapInfo player slots', () => {
  it('reads version 39 player entries from real editor output', () => {
    const parsed = parseMapInfo(EDITOR_MAP_INFO);
    expect(parsed.version).toBe(39);
    expect([parsed.width, parsed.height]).toEqual([256, 256]);
    expect(parsed.players.map((player) => [player.controller, player.controlType])).toEqual([
      [0, 3],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
      [14, 2],
      [15, 4],
    ]);
  });

  it('sets an exact human range and can remove inherited computer slots', () => {
    const outcome = setMapPlayerSlots(EDITOR_MAP_INFO, { maxPlayers: 4, removeComputerPlayers: true });
    expect(outcome.after.players.map((player) => [player.controller, player.controlType])).toEqual([
      [0, 3],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [15, 4],
    ]);
    expect(outcome.content.byteLength).toBe(337);
    expect(parseMapInfo(EDITOR_MAP_INFO).players).toHaveLength(8);
  });

  it('adds human slots from the existing editor template', () => {
    const outcome = setMapPlayerSlots(EDITOR_MAP_INFO, { maxPlayers: 6 });
    expect(outcome.after.players.map((player) => player.controller)).toEqual([0, 1, 2, 3, 4, 5, 6, 14, 15]);
  });

  it('keeps Attributes defaults aligned with the human slots', () => {
    const reduced = setPlayerAttributeSlots(ATTRIBUTES, 4);
    expect(reduced.content).toContain('<Slot Id="3"/>');
    expect(reduced.content).not.toContain('<Slot Id="4"/>');

    const expanded = setPlayerAttributeSlots(reduced.content, 6);
    expect(expanded.content).toContain('<Slot Id="4"/>');
    expect(expanded.content).toContain('<Slot Id="5"/>');
  });
});
