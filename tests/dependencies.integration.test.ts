/**
 * Dependency loading end to end (PLAN.md §25).
 *
 * The scenario is a real one for arcade authors: a map that keeps shared units in its own
 * `.SC2Mod` and depends on it. Those dependencies are ordinary directories, so they can be
 * resolved and indexed today — unlike Blizzard's stock mods, which live inside the
 * installation's CASC content store and are reported as such rather than as missing.
 */

import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { configFromObject, createNullLogger } from '@sc2mcp/core';
import { createTempDir, writeTree, type TempDir } from '@sc2mcp/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContext } from '../apps/sc2-mcp-server/src/context.js';
import { createMcpServer } from '../apps/sc2-mcp-server/src/server.js';

/** A dependency mod holding a base unit the map will inherit from. */
const SHARED_MOD: Record<string, string> = {
  DocumentInfo: '<?xml version="1.0" encoding="utf-8"?>\r\n<DocInfo>\r\n    <ModType>\r\n        <Value>Interface</Value>\r\n    </ModType>\r\n</DocInfo>\r\n',
  'Base.SC2Data/GameData/UnitData.xml':
    '<?xml version="1.0" encoding="utf-8"?>\r\n<Catalog>\r\n' +
    '    <CUnit id="SharedTrooper">\r\n' +
    '        <LifeMax value="200"/>\r\n' +
    '        <Speed value="3"/>\r\n' +
    '    </CUnit>\r\n' +
    '</Catalog>\r\n',
};

/** A map that inherits from the mod's unit and overrides one field. */
const MAP: Record<string, string> = {
  ComponentList: '',
  DocumentInfo:
    '<?xml version="1.0" encoding="utf-8"?>\r\n<DocInfo>\r\n' +
    '    <Dependencies>\r\n' +
    '        <Value>bnet:Shared Mod/0.0/999,file:Mods/Shared.SC2Mod</Value>\r\n' +
    '        <Value>bnet:Void Multi (Mod)/0.0/999,file:Mods/VoidMulti.SC2Mod</Value>\r\n' +
    '    </Dependencies>\r\n' +
    '</DocInfo>\r\n',
  'Base.SC2Data/GameData/UnitData.xml':
    '<?xml version="1.0" encoding="utf-8"?>\r\n<Catalog>\r\n' +
    '    <CUnit id="MapTrooper" parent="SharedTrooper">\r\n' +
    '        <LifeMax value="250"/>\r\n' +
    '    </CUnit>\r\n' +
    '</Catalog>\r\n',
};

interface ToolOutcome {
  isError: boolean;
  text: string;
  structured: Record<string, unknown>;
}

describe('dependency loading', () => {
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
    temp = await createTempDir('sc2mcp-deps-');

    // Layout mirrors a real project: Maps/ beside Mods/, both under one root, so the
    // dependency's `file:Mods/Shared.SC2Mod` resolves relative to the map's grandparent.
    const mapPath = path.join(temp.path, 'Maps', 'DepTest.SC2Map');
    await writeTree(mapPath, { ...MAP });
    await writeTree(path.join(temp.path, 'Mods', 'Shared.SC2Mod'), { ...SHARED_MOD });

    const config = configFromObject({
      allowedRoots: [temp.path],
      workspaceRoot: path.join(temp.path, 'state'),
      // A configured install root makes the stock dependency resolve as `in-casc`.
      sc2InstallPath: path.join(temp.path, 'fake-install'),
    });
    const context = await createContext({
      config,
      logger: createNullLogger(),
      skipInstallationDetection: true,
      skipMpqHelperProbe: true,
      skipGalaxyToolkitProbe: true,
    });

    server = createMcpServer(context);
    client = new Client({ name: 'deps-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // Populates the client's output-schema validator cache. Without this the client skips
    // validation entirely, and a tool whose declared outputSchema has drifted from what it
    // actually returns passes here while a real client rejects the call.
    await client.listTools();

    const opened = await call('sc2_open_document', { source_path: mapPath });
    workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await server.close();
    await temp.cleanup();
  });

  it('distinguishes a resolved dependency from one that lives in CASC', async () => {
    const outcome = await call('sc2_get_dependencies', { workspace_id: workspaceId });
    const dependencies = outcome.structured['dependencies'] as {
      name: string;
      resolution: string;
      loaded: boolean;
      reason: string | null;
    }[];

    expect(dependencies).toHaveLength(2);

    const shared = dependencies.find((entry) => entry.name === 'Shared Mod');
    expect(shared?.resolution).toBe('resolved');
    expect(shared?.loaded).toBe(true);

    // The stock one is NOT missing — it exists, inside the CASC store this build cannot
    // read. Calling it "not found" would tell the user their map is broken when it is fine.
    const stock = dependencies.find((entry) => entry.name === 'Void Multi (Mod)');
    expect(stock?.resolution).toBe('in-casc');
    expect(stock?.loaded).toBe(false);
    expect(stock?.reason).toContain('CASC');

    expect(outcome.structured['loadedCount']).toBe(1);
  });

  it('indexes the dependency\'s catalog alongside the document\'s', async () => {
    const domains = await call('sc2_list_catalog_domains', { workspace_id: workspaceId });
    const stats = domains.structured['stats'] as Record<string, unknown>;

    expect(stats['documentEntryCount']).toBe(1);
    expect(stats['dependencyEntryCount']).toBe(1);
    expect(stats['loadedDependencies']).toEqual(['Shared Mod']);
  });

  it('resolves inheritance across the dependency boundary', async () => {
    const resolved = await call('sc2_resolve_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'MapTrooper',
    });

    // The parent lives in the mod, so before dependency loading this reported "unresolved".
    expect(resolved.structured['parentChain']).toEqual(['SharedTrooper']);
    expect(resolved.structured['unresolvedParents']).toEqual([]);
    expect(resolved.structured['complete']).toBe(true);

    const fields = new Map(
      (resolved.structured['fields'] as { path: string; value: string; definedBy: string; origin: string | null }[]).map(
        (field) => [field.path, field],
      ),
    );

    // Overridden in the map...
    expect(fields.get('LifeMax')).toMatchObject({ value: '250', definedBy: 'Unit/MapTrooper', origin: null });
    // ...and inherited from the dependency, which is named so the caller knows it is not
    // theirs to edit.
    expect(fields.get('Speed')).toMatchObject({ value: '3', definedBy: 'Unit/SharedTrooper', origin: 'Shared Mod' });
  });

  it('lets the document override a dependency object of the same id', async () => {
    const search = await call('sc2_search_catalog', { workspace_id: workspaceId, query: 'Trooper' });
    const results = search.structured['results'] as { id: string; layer: string; origin: string | null }[];

    expect(results.find((entry) => entry.id === 'SharedTrooper')).toMatchObject({
      layer: 'dependency',
      origin: 'Shared Mod',
    });
    expect(results.find((entry) => entry.id === 'MapTrooper')).toMatchObject({ layer: 'document', origin: null });
  });

  it('refuses to edit an object owned by a dependency', async () => {
    const outcome = await call('sc2_patch_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'SharedTrooper',
      patches: [{ op: 'set', path: 'LifeMax', value: '999' }],
      dry_run: false,
    });

    // Visible does not mean editable: it lives outside the workspace, and PLAN.md §25
    // forbids modifying dependency archives.
    expect(outcome.isError).toBe(true);
    const error = outcome.structured['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SC2_UNSUPPORTED_OPERATION');
    expect(String(error['message'])).toContain('Shared Mod');
    expect(String(error['suggestedAction'])).toContain('clone');
  });

  it('still edits the document\'s own objects normally', async () => {
    const outcome = await call('sc2_patch_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'MapTrooper',
      patches: [{ op: 'set', path: 'LifeMax', value: '300' }],
      dry_run: false,
    });

    expect(outcome.isError).toBe(false);
  });

  it('points at parent-based creation when asked to clone from a dependency', async () => {
    const outcome = await call('sc2_clone_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      source_id: 'SharedTrooper',
      new_id: 'MyTrooper',
      dry_run: false,
    });

    expect(outcome.isError).toBe(true);
    // Copying a dependency object into the document is not implemented; the error names
    // the workaround that is, rather than leaving the caller stuck.
    expect(String((outcome.structured['error'] as Record<string, unknown>)['suggestedAction'])).toContain(
      'sc2_create_catalog_object',
    );
  });

  it('supports the recommended workaround: create with the dependency object as parent', async () => {
    const created = await call('sc2_create_catalog_object', {
      workspace_id: workspaceId,
      ctype: 'CUnit',
      id: 'MyTrooper',
      parent: 'SharedTrooper',
      dry_run: false,
    });
    expect(created.isError).toBe(false);

    const resolved = await call('sc2_resolve_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'MyTrooper',
    });
    const fields = resolved.structured['fields'] as { path: string; value: string; origin: string | null }[];
    expect(fields.find((field) => field.path === 'Speed')).toMatchObject({ value: '3', origin: 'Shared Mod' });
  });
});
