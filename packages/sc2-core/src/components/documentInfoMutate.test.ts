import { describe, expect, it } from 'vitest';

import { SC2Error } from '../errors.js';
import { parseDocumentInfo } from './documentInfo.js';
import { addDependency, removeDependency, setDocumentInfoField } from './documentInfoMutate.js';

/** Copied from a real map's DocumentInfo, CRLF and all. */
const DOC_INFO =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<DocInfo>\r\n' +
  '    <ModType>\r\n' +
  '        <Value>Interface</Value>\r\n' +
  '    </ModType>\r\n' +
  '    <Dependencies>\r\n' +
  '        <Value>bnet:Void Multi (Mod)/0.0/999,file:Mods/VoidMulti.SC2Mod</Value>\r\n' +
  '        <Value>bnet:Co-op Mission/0.0/999,file:Mods/StarCoop/StarCoop.SC2Mod</Value>\r\n' +
  '    </Dependencies>\r\n' +
  '</DocInfo>\r\n';

const NO_DEPS = '<?xml version="1.0" encoding="utf-8"?>\r\n<DocInfo>\r\n    <ModType>\r\n        <Value>Melee</Value>\r\n    </ModType>\r\n</DocInfo>\r\n';

describe('dependencies', () => {
  it('appends a dependency last, because last wins in load order', () => {
    const outcome = addDependency(DOC_INFO, 'bnet:Swarm (Mod)/0.0/999,file:Mods/Swarm.SC2Mod');

    const parsed = parseDocumentInfo(outcome.content);
    expect(parsed.dependencies.map((entry) => entry.file)).toEqual([
      'Mods/VoidMulti.SC2Mod',
      'Mods/StarCoop/StarCoop.SC2Mod',
      'Mods/Swarm.SC2Mod',
    ]);
    expect(outcome.summary[0]).toContain('last in load order');
    // Nothing else in the file moved.
    expect(outcome.content).toContain('<Value>Interface</Value>');
    expect(outcome.content).toContain('\r\n');
  });

  it('creates the Dependencies element when a map has none', () => {
    const outcome = addDependency(NO_DEPS, 'bnet:Void (Mod)/0.0/999,file:Mods/Void.SC2Mod');
    expect(parseDocumentInfo(outcome.content).dependencies.map((entry) => entry.file)).toEqual(['Mods/Void.SC2Mod']);
  });

  it('refuses a duplicate identified by its file, not its display name', () => {
    // Same mod, different bnet label — adding it twice is how load order gets confusing.
    expect(() => addDependency(DOC_INFO, 'bnet:Totally Different Name/1.2/3,file:Mods/VoidMulti.SC2Mod')).toThrow(SC2Error);
  });

  it('rejects a dependency string with no file part', () => {
    expect(() => addDependency(DOC_INFO, 'bnet:Void Multi (Mod)/0.0/999')).toThrow(SC2Error);
    expect(() => addDependency(DOC_INFO, '   ')).toThrow(SC2Error);
  });

  it('removes a dependency by file, leaving the others in order', () => {
    const outcome = removeDependency(DOC_INFO, 'Mods/VoidMulti.SC2Mod');
    expect(parseDocumentInfo(outcome.content).dependencies.map((entry) => entry.file)).toEqual([
      'Mods/StarCoop/StarCoop.SC2Mod',
    ]);
  });

  it('reports a dependency that is not there', () => {
    expect(() => removeDependency(DOC_INFO, 'Mods/Nope.SC2Mod')).toThrow(SC2Error);
  });
});

describe('single-valued fields', () => {
  it('changes a field in place', () => {
    const outcome = setDocumentInfoField(DOC_INFO, 'ModType', 'Melee');
    expect(outcome.summary).toEqual(['set ModType: Interface -> Melee']);
    expect(outcome.content).toContain('<Value>Melee</Value>');
    expect(parseDocumentInfo(outcome.content).dependencies).toHaveLength(2);
  });

  it('adds a field the document does not have', () => {
    const outcome = setDocumentInfoField(DOC_INFO, 'Icon', 'custom.tga');
    expect(outcome.content).toContain('<Icon>');
    expect(outcome.content).toContain('<Value>custom.tga</Value>');
  });

  it('treats an unchanged value as no edit', () => {
    const outcome = setDocumentInfoField(DOC_INFO, 'ModType', 'Interface');
    expect(outcome.summary).toEqual([]);
    expect(outcome.content).toBe(DOC_INFO);
  });

  it('refuses to treat the dependency list as a single-valued field', () => {
    expect(() => setDocumentInfoField(DOC_INFO, 'Dependencies', 'x')).toThrow(SC2Error);
  });
});
