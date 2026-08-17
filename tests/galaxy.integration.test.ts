/**
 * Galaxy tools end to end, against the vendored `sc2-galaxy-lang` parser.
 *
 * Skipped when the toolkit is not built — it is fetched by `scripts/bootstrap.ps1` into a
 * gitignored `vendor/` directory and compiled separately, so CI and a fresh clone will not
 * have it. That is the same honesty model the MPQ sidecar uses: absent means the
 * capability reports false, not that the server breaks.
 */

import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { configFromObject, createNullLogger, parseGalaxy, probeGalaxyToolkit } from '@sc2mcp/core';
import { MINIMAL_DOCUMENT, createTempDir, writeTree, type TempDir } from '@sc2mcp/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContext } from '../apps/sc2-mcp-server/src/context.js';
import { createMcpServer } from '../apps/sc2-mcp-server/src/server.js';

const toolkit = await probeGalaxyToolkit();

interface ToolOutcome {
  isError: boolean;
  text: string;
  structured: Record<string, unknown>;
}

describe.skipIf(!toolkit.available)('Galaxy tools', () => {
  let temp: TempDir;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let workspaceId: string;

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> => {
    const result = await client.callTool({ name, arguments: args });
    const block = result.content?.[0];
    return {
      isError: result.isError === true,
      text: block?.type === 'text' ? block.text : '',
      structured: (result.structuredContent ?? {}) as Record<string, unknown>,
    };
  };

  beforeAll(async () => {
    temp = await createTempDir('sc2mcp-galaxy-');
    const sourceDir = path.join(temp.path, 'source', 'TestMap.SC2Map');
    await writeTree(sourceDir, {
      ...MINIMAL_DOCUMENT,
      'Base.SC2Data/LibTest.galaxy':
        'include "TriggerLibs/NativeLib"\n\nint gCounter = 0;\n\nvoid TestInit () {\n    gCounter = gCounter + 1;\n}\n',
      // The generated script, so the tools have something to refuse to edit.
      'MapScript.galaxy': 'include "TriggerLibs/NativeLib"\n\nvoid InitMap () {\n}\n',
    });

    const config = configFromObject({ allowedRoots: [temp.path], workspaceRoot: path.join(temp.path, 'state') });
    const context = await createContext({
      config,
      logger: createNullLogger(),
      skipInstallationDetection: true,
      skipMpqHelperProbe: true,
    });

    server = createMcpServer(context);
    client = new Client({ name: 'galaxy-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const opened = await call('sc2_open_document', { source_path: sourceDir });
    workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await server.close();
    await temp.cleanup();
  });

  it('reports the Galaxy capability as available when the toolkit is built', async () => {
    const info = await call('sc2_get_server_info');
    const capabilities = info.structured['capabilities'] as Record<string, Record<string, boolean>>;

    expect(capabilities['galaxy']?.['read']).toBe(true);
    expect(capabilities['galaxy']?.['write']).toBe(true);
    // Type checking is NOT claimed: it needs the game's native declarations.
    expect(capabilities['galaxy']?.['typecheck']).toBe(false);
  });

  it('lists scripts and flags the generated one', async () => {
    const listed = await call('sc2_list_galaxy_files', { workspace_id: workspaceId });
    const files = listed.structured['files'] as { path: string; generated: boolean }[];

    expect(files.map((file) => file.path).sort()).toEqual(['Base.SC2Data/LibTest.galaxy', 'MapScript.galaxy']);
    expect(files.find((file) => file.path === 'MapScript.galaxy')?.generated).toBe(true);
    expect(files.find((file) => file.path === 'Base.SC2Data/LibTest.galaxy')?.generated).toBe(false);
    expect(listed.text).toContain('GENERATED');
  });

  it('extracts declarations and includes', async () => {
    const symbols = await call('sc2_get_galaxy_symbols', {
      workspace_id: workspaceId,
      path: 'Base.SC2Data/LibTest.galaxy',
    });

    const found = symbols.structured['symbols'] as { name: string; kind: string }[];
    expect(found.map((symbol) => `${symbol.kind} ${symbol.name}`)).toEqual(['variable gCounter', 'function TestInit']);
    expect(symbols.structured['includes']).toEqual(['TriggerLibs/NativeLib']);
    // The syntax-only limit must be stated wherever a clean result could mislead.
    expect(String(symbols.structured['note'])).toContain('Syntax only');
  });

  it('finds no syntax errors in a valid script', async () => {
    const diagnostics = await call('sc2_get_galaxy_diagnostics', { workspace_id: workspaceId });
    expect(diagnostics.structured['errorCount']).toBe(0);
    // The generated script is skipped when no path is given.
    const files = diagnostics.structured['files'] as { path: string }[];
    expect(files.map((file) => file.path)).toEqual(['Base.SC2Data/LibTest.galaxy']);
  });

  it('applies a patch and reparses it', async () => {
    const applied = await call('sc2_apply_galaxy_patch', {
      workspace_id: workspaceId,
      path: 'Base.SC2Data/LibTest.galaxy',
      old_text: 'gCounter = gCounter + 1;',
      new_text: 'gCounter = gCounter + 2;',
      dry_run: false,
    });

    expect(applied.isError).toBe(false);
    const read = await call('sc2_get_galaxy_file', { workspace_id: workspaceId, path: 'Base.SC2Data/LibTest.galaxy' });
    expect(read.structured['content']).toContain('gCounter + 2;');
  });

  it('refuses a patch that would introduce a syntax error', async () => {
    const outcome = await call('sc2_apply_galaxy_patch', {
      workspace_id: workspaceId,
      path: 'Base.SC2Data/LibTest.galaxy',
      old_text: 'void TestInit () {',
      new_text: 'void TestInit ( {',
      dry_run: false,
    });

    // This is the check that makes text patching safe rather than reckless.
    expect(outcome.isError).toBe(true);
    expect((outcome.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_VALIDATION_FAILED');

    // And the file was left alone.
    const read = await call('sc2_get_galaxy_file', { workspace_id: workspaceId, path: 'Base.SC2Data/LibTest.galaxy' });
    expect(read.structured['content']).toContain('void TestInit () {');
  });

  it('refuses an ambiguous patch rather than guessing which occurrence', async () => {
    await call('sc2_create_galaxy_file', {
      workspace_id: workspaceId,
      path: 'Base.SC2Data/LibAmbiguous.galaxy',
      content: 'void A () {\n    int x = 1;\n}\n\nvoid B () {\n    int x = 1;\n}\n',
      dry_run: false,
    });

    const outcome = await call('sc2_apply_galaxy_patch', {
      workspace_id: workspaceId,
      path: 'Base.SC2Data/LibAmbiguous.galaxy',
      old_text: '    int x = 1;',
      new_text: '    int x = 2;',
      dry_run: false,
    });

    expect(outcome.isError).toBe(true);
    expect((outcome.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_CONFLICT');

    // Naming the occurrence resolves it.
    const targeted = await call('sc2_apply_galaxy_patch', {
      workspace_id: workspaceId,
      path: 'Base.SC2Data/LibAmbiguous.galaxy',
      old_text: '    int x = 1;',
      new_text: '    int x = 2;',
      occurrence: 2,
      dry_run: false,
    });
    expect(targeted.isError).toBe(false);
  });

  it('refuses to edit the generated MapScript.galaxy', async () => {
    const outcome = await call('sc2_apply_galaxy_patch', {
      workspace_id: workspaceId,
      path: 'MapScript.galaxy',
      old_text: 'void InitMap () {',
      new_text: 'void InitMap2 () {',
      dry_run: false,
    });

    expect(outcome.isError).toBe(true);
    const error = outcome.structured['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SC2_UNSUPPORTED_OPERATION');
    expect(String(error['suggestedAction'])).toContain('triggers');
  });

  it('refuses to create a script that does not parse', async () => {
    const outcome = await call('sc2_create_galaxy_file', {
      workspace_id: workspaceId,
      path: 'Base.SC2Data/LibBroken.galaxy',
      content: 'void Broken( {\n',
      dry_run: false,
    });

    expect(outcome.isError).toBe(true);
    expect((outcome.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_VALIDATION_FAILED');
  });
});

describe.skipIf(!toolkit.available)('Galaxy adapter', () => {
  it('locates syntax errors with a line and column', async () => {
    const parsed = await parseGalaxy('Bad.galaxy', 'void Broken( {\n    int x = ;\n}\n');
    const errors = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.line).toBe(1);
    expect(errors[0]?.column).toBeGreaterThan(0);
  });

  it('parses a real generated MapScript from the shipped map, if present', async () => {
    const { existsSync } = await import('node:fs');
    const { readFile } = await import('node:fs/promises');
    const realPath = 'C:\\Program Files (x86)\\StarCraft II\\maps\\Test\\EditorTest.SC2Map\\MapScript.galaxy';
    if (!existsSync(realPath)) return;

    const source = await readFile(realPath, 'utf8');
    const parsed = await parseGalaxy('MapScript.galaxy', source);

    // Genuine editor-generated Galaxy must parse cleanly, or the parser is wrong.
    expect(source.length).toBeGreaterThan(10_000);
    expect(parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(parsed.symbols.length).toBeGreaterThan(0);
  });
});
