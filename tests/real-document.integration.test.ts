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
  configFromObject,
  createNullLogger,
  detectInstallations,
  parseComponentList,
  parseDocumentInfo,
  selectInstallation,
  walkFiles,
  PathGuard,
  WorkspaceService,
  WorkspaceStore,
} from '@sc2mcp/core';
import { createTempDir, type TempDir } from '@sc2mcp/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Resolved once, synchronously, so `describe.skipIf` can use it. Detection proper is
 * async, so this checks the conventional locations directly.
 */
function findEditorTestMap(): string | null {
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  const roots = [
    process.env['SC2MCP_SC2_INSTALL_PATH'],
    process.env['SC2PATH'],
    programFilesX86 === undefined ? undefined : path.join(programFilesX86, 'StarCraft II'),
    'C:\\Program Files (x86)\\StarCraft II',
  ].filter((root): root is string => root !== undefined && root !== '');

  for (const root of roots) {
    const candidate = path.join(root, 'maps', 'Test', 'EditorTest.SC2Map', 'ComponentList.SC2Components');
    if (existsSync(candidate)) return path.dirname(candidate);
  }
  return null;
}

const mapPath = findEditorTestMap();

describe.skipIf(mapPath === null)('real editor-produced document', () => {
  const documentPath = mapPath!;

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
    service = new WorkspaceService({
      config,
      pathGuard: new PathGuard({ allowedRoots: config.allowedRoots }),
      store: new WorkspaceStore({ workspaceRoot: config.workspaceRoot, serverVersion: '0.0.0-test' }),
      logger: createNullLogger(),
    });
  }, 120_000);

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
});
