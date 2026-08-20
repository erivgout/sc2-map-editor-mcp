import { describe, expect, it } from 'vitest';

import { SC2Error } from '../errors.js';
import { addComponent, removeComponent, updateComponent } from './componentListMutate.js';

const COMPONENTS =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<Components>\r\n' +
  '    <DataComponent Type="gada">GameData</DataComponent>\r\n' +
  '    <DataComponent Type="text" Locale="enUS">GameText</DataComponent>\r\n' +
  '    <DataComponent Type="info">DocumentInfo</DataComponent>\r\n' +
  '</Components>';

describe('ComponentList mutations', () => {
  it('adds an entry without changing CRLF or adding a trailing newline', () => {
    const outcome = addComponent(COMPONENTS, { typeCode: 'layo', path: 'UI/Layout' });

    expect(outcome.content).toContain(
      '    <DataComponent Type="layo">UI/Layout</DataComponent>\r\n</Components>',
    );
    expect(outcome.content.endsWith('\n')).toBe(false);
    expect(outcome.content.replace('    <DataComponent Type="layo">UI/Layout</DataComponent>\r\n', '')).toBe(
      COMPONENTS,
    );
  });

  it('updates only the requested path and locale attribute', () => {
    const outcome = updateComponent(
      COMPONENTS,
      { typeCode: 'text', locale: 'enUS' },
      { newPath: 'LocalizedData', newLocale: 'frFR' },
    );

    expect(outcome.content).toBe(
      COMPONENTS.replace(
        '<DataComponent Type="text" Locale="enUS">GameText</DataComponent>',
        '<DataComponent Type="text" Locale="frFR">LocalizedData</DataComponent>',
      ),
    );
  });

  it('can add and remove a Locale attribute without reserializing the file', () => {
    const localized = updateComponent(COMPONENTS, { typeCode: 'info' }, { newLocale: 'enUS' }).content;
    expect(localized).toContain('<DataComponent Type="info" Locale="enUS">DocumentInfo</DataComponent>');

    const unlocalized = updateComponent(localized, { typeCode: 'info', locale: 'enUS' }, { newLocale: null }).content;
    expect(unlocalized).toBe(COMPONENTS);
  });

  it('removes only the declaration and preserves surrounding bytes', () => {
    const outcome = removeComponent(COMPONENTS, { typeCode: 'text', locale: 'enUS' });

    expect(outcome.content).toBe(
      COMPONENTS.replace('    <DataComponent Type="text" Locale="enUS">GameText</DataComponent>\r\n', ''),
    );
    expect(outcome.summary[0]).toContain('component files were preserved');
  });

  it('refuses duplicate type and locale identities', () => {
    expect(() => addComponent(COMPONENTS, { typeCode: 'text', path: 'OtherText', locale: 'enUS' })).toThrow(
      SC2Error,
    );
    expect(() =>
      updateComponent(COMPONENTS, { typeCode: 'info' }, { newTypeCode: 'gada' }),
    ).toThrow(SC2Error);
  });

  it('refuses absolute and traversal paths', () => {
    expect(() => addComponent(COMPONENTS, { typeCode: 'test', path: '../outside' })).toThrow(SC2Error);
    expect(() => addComponent(COMPONENTS, { typeCode: 'test', path: 'C:\\outside' })).toThrow(SC2Error);
  });
});
