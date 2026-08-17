/**
 * Validates the component parsers against a **real, editor-produced** SC2 document.
 *
 * PLAN.md §55 rule 1: format behaviour must be verified against real editor output, not
 * assumed from documentation. Retail StarCraft II installations ship an unpacked test map
 * at `maps/Test/EditorTest.SC2Map`, which is exactly that — a document written by the
 * Galaxy Editor, with a full component set, terrain, triggers, and localization.
 *
 * Skipped when no installation is present, so CI stays free of any StarCraft II
 * dependency (PLAN.md §39). Nothing from the map is copied into this repository; it is
 * read in place and only structural facts are asserted.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  attributeValue,
  childElements,
  configFromObject,
  createMpqExtractor,
  createNullLogger,
  defaultHelperPaths,
  detectInstallations,
  diffText,
  MpqHelper,
  findSc2DocumentsFolder,
  listEditorLogs,
  parseCatalogFile,
  buildTriggerTree,
  parseComponentList,
  parseDocumentInfo,
  parsePlacedObjects,
  parseRegions,
  parseTerrainSummary,
  readBinaryHeader,
  parseTextTable,
  parseTriggerData,
  parseXml,
  selectInstallation,
  walkFiles,
  PathGuard,
  WorkspaceService,
  WorkspaceStore,
  XmlEditor,
} from '@sc2mcp/core';
import { createTempDir, type TempDir } from '@sc2mcp/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Resolved once, synchronously, so `describe.skipIf` can use it. Detection proper is
 * async, so this checks the conventional locations directly.
 *
 * The editor writes EditorTest.SC2Map either as an unpacked directory or as a packed
 * archive, and it converts one to the other as a side effect of ordinary use. Both forms
 * are accepted so this suite does not quietly stop running the day that flips.
 */
function findEditorTestMap(): { readonly path: string; readonly packed: boolean } | null {
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  const roots = [
    process.env['SC2MCP_SC2_INSTALL_PATH'],
    process.env['SC2PATH'],
    programFilesX86 === undefined ? undefined : path.join(programFilesX86, 'StarCraft II'),
    'C:\\Program Files (x86)\\StarCraft II',
  ].filter((root): root is string => root !== undefined && root !== '');

  for (const root of roots) {
    const candidate = path.join(root, 'maps', 'Test', 'EditorTest.SC2Map');
    if (existsSync(path.join(candidate, 'ComponentList.SC2Components'))) return { path: candidate, packed: false };
    if (existsSync(candidate)) return { path: candidate, packed: true };
  }
  return null;
}

const editorTestMap = findEditorTestMap();
const mpqHelperPath = defaultHelperPaths()[0] ?? '';

/** A packed candidate is only usable if the sidecar that can unpack it exists. */
const mapUsable = editorTestMap !== null && (!editorTestMap.packed || existsSync(mpqHelperPath));
const mapPath = mapUsable ? editorTestMap.path : null;

describe.skipIf(mapPath === null)('real editor-produced document', () => {
  // These assertions read the document's files directly, so a packed candidate is
  // extracted first and the tests run against the staged tree either way.
  let documentPath: string;
  let extracted: TempDir | null = null;

  beforeAll(async () => {
    if (editorTestMap !== null && !editorTestMap.packed) {
      documentPath = editorTestMap.path;
      return;
    }
    const probe = await MpqHelper.probe({ helperPath: mpqHelperPath, timeoutMs: 300_000 });
    if (!probe.available) throw new Error(probe.reason ?? 'the sc2mpq helper is unavailable');
    extracted = await createTempDir('sc2mcp-editortest-');
    await MpqHelper.fromProbe(probe, 300_000).extract(mapPath!, extracted.path);
    documentPath = extracted.path;
  }, 300_000);

  afterAll(async () => {
    await extracted?.cleanup();
  });

  it('parses the shipped ComponentList and resolves its components', async () => {
    const source = await readFile(path.join(documentPath, 'ComponentList.SC2Components'), 'utf8');
    const files = await walkFiles(documentPath, { maxFiles: 100_000 });
    const list = parseComponentList(
      source,
      files.map((file) => file.relativePath),
    );

    // A real map declares many components; the exact set varies by editor version, so
    // assert on structure and on the ones every map has.
    expect(list.components.length).toBeGreaterThan(5);
    const typeCodes = list.components.map((component) => component.typeCode);
    expect(typeCodes).toContain('gada');
    expect(typeCodes).toContain('info');
    expect(typeCodes).toContain('trig');

    // The resolver must find real files for GameData, or its layer logic is wrong.
    const gameData = list.components.find((component) => component.typeCode === 'gada');
    expect(gameData?.exists, 'GameData component did not resolve to any staged file').toBe(true);
    expect(gameData?.resolvedPaths.every((entry) => entry.toLowerCase().includes('.sc2data/gamedata/'))).toBe(true);

    // Every declared component should resolve. A miss means the resolver is wrong, not
    // that the map is broken — worth failing loudly on.
    expect(list.missing.map((component) => `${component.typeCode}:${component.path}`)).toEqual([]);
  });

  it('parses the shipped DocumentInfo', async () => {
    const source = await readFile(path.join(documentPath, 'DocumentInfo'), 'utf8');
    const info = parseDocumentInfo(source);

    // Real maps declare dependencies with the bnet+file pair form.
    expect(info.dependencies.length).toBeGreaterThan(0);
    for (const dependency of info.dependencies) {
      expect(dependency.raw).not.toBe('');
      expect(dependency.bnet ?? dependency.file, `dependency parsed to nothing: ${dependency.raw}`).toBeTruthy();
    }
  });

  it('edits a real catalog file and changes nothing but the target bytes', async () => {
    // The strongest losslessness check available: genuine editor output, not a fixture we
    // wrote to suit the parser (PLAN.md §12, §55 rule 1).
    //
    // Deliberately no assertion on the file's size. The editor rewrites EditorTest.SC2Map
    // with whatever document was last opened, so anything keyed to one map's dimensions
    // silently stops describing this artifact. What matters is that real editor bytes go
    // in and only the addressed bytes come back changed.
    const catalogPath = path.join(documentPath, 'Base.SC2Data', 'GameData', 'UnitData.xml');
    const source = await readFile(catalogPath, 'utf8');
    expect(source.length).toBeGreaterThan(0);

    const file = parseCatalogFile(source, 'Base.SC2Data/GameData/UnitData.xml');
    const target = file.entries.find((entry) =>
      entry.fields.some((field) => field.name === 'LifeMax' && field.value !== null),
    );
    expect(target, 'expected at least one unit declaring LifeMax').toBeDefined();
    if (target === undefined) return;

    const document = parseXml(source);
    const entryElement = childElements(document.root!).find(
      (element) => attributeValue(element, 'id') === target.id && element.name === target.ctype,
    );
    expect(entryElement).toBeDefined();
    if (entryElement === undefined) return;

    const lifeMax = childElements(entryElement, 'LifeMax')[0];
    expect(lifeMax).toBeDefined();
    if (lifeMax === undefined) return;

    const valueAttribute = lifeMax.attributes.find((attribute) => attribute.name === 'value');
    expect(valueAttribute).toBeDefined();
    if (valueAttribute === undefined) return;

    const editor = new XmlEditor(source);
    editor.setAttributeValue(lifeMax, 'value', '123456');
    const edited = editor.apply();

    // Exactly one line differs, and it is the one we targeted.
    const diff = diffText('UnitData.xml', source, edited);
    expect(diff.addedLines).toBe(1);
    expect(diff.removedLines).toBe(1);

    // Byte-level proof: splicing the new value into the original produces the same string,
    // so every one of the other ~200,000 bytes is untouched.
    const spliced = source.slice(0, valueAttribute.valueSpan.start) + '123456' + source.slice(valueAttribute.valueSpan.end);
    expect(edited).toBe(spliced);

    // And it still parses to the same shape, with the new value in place.
    const reparsed = parseCatalogFile(edited, 'Base.SC2Data/GameData/UnitData.xml');
    expect(reparsed.entries).toHaveLength(file.entries.length);
    const reparsedTarget = reparsed.entries.find((entry) => entry.id === target.id);
    expect(reparsedTarget?.fields.find((field) => field.name === 'LifeMax')?.value).toBe('123456');
  });

  it('resolves the real Documents folder through the registry, not %USERPROFILE%', async () => {
    // ADR 0001: OneDrive Known Folder Move relocates Documents, so the obvious
    // USERPROFILE\Documents path is wrong and empty. This is the check that catches a
    // regression back to the naive join.
    const documents = await findSc2DocumentsFolder();
    expect(documents).not.toBeNull();
    if (documents === null) return;

    expect(documents.root.endsWith(path.join('StarCraft II'))).toBe(true);
    expect(existsSync(documents.root)).toBe(true);
  });

  it('lists and classifies the editor\'s own logs', async () => {
    const documents = await findSc2DocumentsFolder();
    if (documents === null || !existsSync(documents.editorLogs)) return;

    const logs = await listEditorLogs(documents.editorLogs, 10);
    // A fresh installation may have none; only assert the shape when there are some.
    if (logs.length === 0) return;

    expect(logs[0]?.name).toBeTruthy();
    expect(logs[0]?.kind).toBeTruthy();
    // Newest first.
    for (let index = 1; index < logs.length; index += 1) {
      expect(logs[index - 1]!.modifiedAt >= logs[index]!.modifiedAt).toBe(true);
    }
    // Crash reports are directories, and must be reported as such rather than read.
    expect(logs.every((log) => typeof log.isDirectory === 'boolean')).toBe(true);
  });

  it('parses the shipped Triggers component and joins its names', async () => {
    const source = await readFile(path.join(documentPath, 'Triggers'), 'utf8');
    expect(source.length).toBeGreaterThan(0);

    const data = parseTriggerData(source);
    expect(data.elements.size).toBeGreaterThan(100);
    expect(data.rootIds.length).toBeGreaterThan(0);

    // The element types observed in real editor output.
    const types = [...data.countsByType.keys()];
    expect(types).toEqual(expect.arrayContaining(['Category', 'Trigger', 'Variable', 'FunctionCall']));

    // Every `<Item>` should name an element that exists; a dangling id is an authoring
    // defect worth surfacing, and the shipped map should not have one.
    expect(data.danglingIds).toEqual([]);

    // Names live in TriggerStrings, not in the trigger data. Joining them is what makes
    // the tree readable at all.
    const strings = await readFile(path.join(documentPath, 'enUS.SC2Data', 'LocalizedData', 'TriggerStrings.txt'), 'utf8');
    const table = parseTextTable(strings, 'TriggerStrings.txt');
    const names = new Map([...table.byKey].map(([key, entry]) => [key, entry.value]));

    const tree = buildTriggerTree(data, { names, maxDepth: 2 });
    expect(tree.length).toBe(data.rootIds.length);
    expect(tree.some((node) => node.name !== null), 'no root element resolved to a name').toBe(true);
  });

  it('reads the shipped placed objects, regions, and terrain descriptor', async () => {
    // PLAN.md §27 anticipated binary formats here. Objects and Regions are actually XML,
    // which this asserts against genuine editor output rather than a fixture.
    const objects = parsePlacedObjects(await readFile(path.join(documentPath, 'Objects'), 'utf8'));
    expect(objects.objects.length).toBeGreaterThan(10);
    // Which kinds appear depends on what the map contains, so this asserts the parser
    // recognised real kinds rather than expecting one particular map's furniture.
    expect(objects.objects.every((object) => object.kind.startsWith('Object'))).toBe(true);
    expect([...objects.countsByKind.keys()].length).toBeGreaterThan(0);

    const placed = objects.objects.find((object) => object.position !== null);
    expect(placed, 'expected at least one object with a position').toBeDefined();
    // Positions keep the file's own precision; parsing them to floats would lose it.
    expect(placed?.position).toMatch(/^-?[\d.]+,-?[\d.]+,-?[\d.]+$/);

    const regions = parseRegions(await readFile(path.join(documentPath, 'Regions'), 'utf8'));
    expect(regions.regions.length).toBeGreaterThan(0);
    expect(regions.regions[0]?.name).toBeTruthy();
    expect(regions.regions[0]?.shapeType).toBeTruthy();

    const terrain = parseTerrainSummary(await readFile(path.join(documentPath, 't3Terrain.xml'), 'utf8'));
    expect(terrain.tileSet).toBeTruthy();
    // Vertex counts, one more than cells in each direction.
    expect(terrain.dimensions).toMatch(/^\d+ \d+$/);
    // Whether a map declares cliff sets depends on its terrain, so this asserts the field
    // parsed into strings rather than that this particular map has cliffs.
    expect(terrain.cliffSets.every((entry) => typeof entry === 'string' && entry !== '')).toBe(true);
  });

  it('reads binary terrain headers without interpreting their contents', async () => {
    const heightMap = await readFile(path.join(documentPath, 't3HeightMap'));
    const header = readBinaryHeader('t3HeightMap', heightMap);

    // The byte order is NOT uniform across SC2 components: t3HeightMap stores 'HMAP' in
    // file order, while MapInfo stores 'MapI' reversed. Assuming either convention gets
    // half the files wrong, so both forms are reported.
    expect(header.magic).toBe('HMAP');
    expect(header.magicReversed).toBe('PAMH');
    expect(header.version).toBe(101);
    expect(header.known).toBe(true);
    expect(header.sizeBytes).toBeGreaterThan(100_000);
  });

  it('locates the installation and reports the current build', async () => {
    const installations = await detectInstallations({});
    const selected = selectInstallation(installations);

    expect(selected).not.toBeNull();
    // The launcher exe reports 1.18.x; the real build comes from Versions/Base<N>.
    expect(selected?.latestBuild).toBeGreaterThan(90_000);
    expect(selected?.editorPath).toMatch(/StarCraft II Editor/);
  });
});

describe.skipIf(mapPath === null)('staging a real document', () => {
  let temp: TempDir;
  let service: WorkspaceService;

  beforeAll(async () => {
    temp = await createTempDir('sc2mcp-real-');
    const config = configFromObject({
      // The installation directory is read-only as far as this server is concerned:
      // opening from here copies out, and nothing is ever written back (PLAN.md §25).
      allowedRoots: [path.dirname(path.dirname(mapPath!))],
      workspaceRoot: path.join(temp.path, 'state'),
      // The shipped test map contains large model and texture assets.
      maxSingleFileBytes: 64 * 1024 * 1024,
    });
    // The candidate may be a packed archive, so the service needs the extractor that
    // opening one requires.
    const probe = await MpqHelper.probe({ helperPath: mpqHelperPath, timeoutMs: 300_000 });

    service = new WorkspaceService({
      config,
      pathGuard: new PathGuard({ allowedRoots: config.allowedRoots }),
      store: new WorkspaceStore({ workspaceRoot: config.workspaceRoot, serverVersion: '0.0.0-test' }),
      logger: createNullLogger(),
      ...(probe.available ? { mpqExtractor: createMpqExtractor(MpqHelper.fromProbe(probe, 300_000)) } : {}),
    });
  }, 300_000);

  afterAll(async () => {
    await temp.cleanup();
  });

  it('stages it and produces a summary with components and dependencies', async () => {
    const opened = await service.openDocument({ sourcePath: mapPath!, readOnly: true });
    expect(opened.workspace.documentKind).toBe('map');
    expect(opened.stagedFileCount).toBeGreaterThan(20);

    const summary = await service.getSummary(opened.workspace.id);

    expect(summary.components).not.toBeNull();
    expect(summary.documentInfo).not.toBeNull();
    expect(summary.documentInfo?.dependencies.length).toBeGreaterThan(0);
    // No parse errors against genuine editor output is the whole point of this test.
    expect(summary.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);

    await service.discard(opened.workspace.id);
  }, 300_000);

  it('indexes its GameData catalogs and resolves real inheritance', async () => {
    const opened = await service.openDocument({ sourcePath: mapPath!, readOnly: true });
    const index = await service.getCatalogIndex(opened.workspace.id);
    const stats = index.stats();

    // Sized to any real document rather than to one map: what matters is that catalog
    // files were found and indexed, not how many this particular artifact happens to have.
    expect(stats.fileCount).toBeGreaterThan(0);
    expect(stats.entryCount).toBeGreaterThan(0);

    // Not a single catalog file may fail to parse. This is the assertion that would catch
    // a real-world XML construct the parser does not handle.
    expect(index.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);

    // Domain derivation must work on the real spread of concrete types
    // (CAbilEffectInstant, CValidatorUnitCompareVital, CWeaponLegacy, …).
    const domains = index.domains().map((entry) => entry.domain);
    expect(domains).toEqual(expect.arrayContaining(['Unit', 'Abil', 'Effect', 'Actor', 'Weapon']));
    expect(stats.unknownDomainCount, 'some real entry types resolved to no known domain').toBe(0);

    // Pick a real unit that declares a parent and check inheritance end to end.
    const withParent = index.search({ domains: ['Unit'], limit: 500 }).results.find((entry) => entry.parent !== null);
    expect(withParent, 'expected at least one unit with a parent attribute').toBeDefined();

    if (withParent !== undefined) {
      const resolved = index.resolve('Unit', withParent.id);
      // Either the parent resolved within the document, or it lives in a dependency — and
      // the result must say which rather than silently returning a thin object.
      expect(resolved.parentChain.length + resolved.unresolvedParents.length).toBeGreaterThan(0);

      if (resolved.parentChain.length > 0) {
        // A chain that resolved in-document must actually carry inherited values down.
        expect(resolved.fields.length).toBeGreaterThan(0);
      } else {
        // A parent in an unloaded dependency yields no fields, and saying so is the
        // correct answer — an object with no fields and no explanation would not be.
        expect(resolved.unresolvedParents).toContain(withParent.parent);
      }
    }

    await service.discard(opened.workspace.id);
  }, 300_000);
});
