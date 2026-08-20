/**
 * End-to-end MCP tests: a real {@link Client} drives a real {@link McpServer} over a
 * linked in-memory transport pair, so the protocol layer, schema validation, and tool
 * handlers are all exercised together.
 *
 * PLAN.md §42 Phase 1 exit criterion — "an MCP client can launch the server and call
 * one tool successfully" — is what `lists tools` and the `sc2_get_server_info` case
 * verify. The workspace cases cover Phase 2's exit criterion.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { configFromObject, createNullLogger } from '@sc2mcp/core';
import { MINIMAL_DOCUMENT, createTempDir, writeTree, type TempDir } from '@sc2mcp/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContext } from './context.js';
import { createMcpServer } from './server.js';

const DOCUMENT_FIXTURE = MINIMAL_DOCUMENT;

const TRIGGER_FIXTURE =
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
  '    </Element>\r\n' +
  '    <Element Type="FunctionCall" Id="CCCCCCCC">\r\n' +
  '        <FunctionDef Type="FunctionDef" Library="Ntve" Id="18377668"/>\r\n' +
  '    </Element>\r\n' +
  '</TriggerData>\r\n';

const MAP_INFO_FIXTURE = Buffer.from(
  'SXBhTScAAAA2UwMAAAAAAAABAAAAAQAAAQAAAAEAAAAAAAEAAAAAAAAARGFyawBTaGFrdXJhcwAKAAAACAAAAPYAAADsAAAAAHgAAAAAAAAAAAAAAAAA/////wAAAAAAAAAAIAMAAFgCAAAAAAAAAABAAAABAAAAAgAAAAAgAAAAAAAAAAAAABAAAAAAAAAIAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAABAQAAAP////8AAAAAAAAAAAAAAAAAAAIBAAAA/////wAAAAAAAAAAAAAAAAAAAwEAAAD/////AAAAAAAAAAAAAAAAAAAEAQAAAP////8AAAAAAAAAAAAAAAAAAAUBAAAA/////wAAAAAAAAAAAAAAAAAADgIAAAD/////WmVyZwAAAAAAfVMkOXBtb0MADwQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'base64',
);

const ATTRIBUTES_FIXTURE =
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

const TERRAIN_DESCRIPTOR =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<terrain version="115">\r\n' +
  '    <heightMap tileSet="Test" dim="3 3 " offset="0 0 0 " scale="1 1 1 ">\r\n' +
  '        <vertData quantizeBias="1" quantizeScale="0.001" standardHeight="8" name="t3HeightMap"/>\r\n' +
  '        <masks name="t3TextureMasks"/>\r\n' +
  '        <textureSetList num="8"><textureSet i="0" name="Test"/></textureSetList>\r\n' +
  '        <textureList num="64"><texture i="0" name="Ground"/><texture i="1" name="Rock"/></textureList>\r\n' +
  '        <blockTextureSetList num="0"/>\r\n' +
  '        <cliffCellList num="1" numOccupied="0"/>\r\n' +
  '    </heightMap>\r\n' +
  '</terrain>\r\n';

function terrainFixture(): Record<string, string | Uint8Array> {
  const heightMap = Buffer.alloc(32 + 6 * 9);
  heightMap.write('HMAP', 0, 'ascii');
  heightMap.writeUInt32LE(101, 4);
  heightMap.writeUInt32LE(3, 8);
  heightMap.writeUInt32LE(3, 12);
  for (let index = 0; index < 9; index += 1) {
    heightMap.writeUInt16LE(9000, 32 + index * 6);
    heightMap.writeUInt16LE(1000, 34 + index * 6);
    heightMap.writeUInt16LE(1, 36 + index * 6);
  }

  const syncHeight = Buffer.alloc(64 + 4 * 9);
  syncHeight.write('SMAP', 0, 'ascii');
  syncHeight.writeUInt32LE(102, 4);
  syncHeight.writeUInt32LE(3, 8);
  syncHeight.writeUInt32LE(3, 12);
  for (let index = 0; index < 9; index += 1) syncHeight.writeUInt16LE(2048, 64 + index * 4);

  const cellFlags = Buffer.alloc(32 + 4);
  cellFlags.write('LFCT', 0, 'ascii');
  cellFlags.writeUInt32LE(102, 4);
  cellFlags.writeUInt32LE(2, 24);
  cellFlags.writeUInt32LE(2, 28);

  const textureMasks = Buffer.alloc(64 + 8 * 2048);
  textureMasks.write('MASK', 0, 'ascii');
  textureMasks.writeUInt32LE(102, 4);
  textureMasks.writeUInt32LE(64, 12);
  textureMasks.writeUInt32LE(64, 16);

  const syncCliff = Buffer.alloc(32 + 2 * 4);
  syncCliff.write('CLIF', 0, 'ascii');
  syncCliff.writeUInt32LE(100, 4);
  for (let index = 0; index < 4; index += 1) syncCliff.writeUInt16LE(64, 32 + index * 2);

  const names = Buffer.from('Ground\0Rock\0\0\0\0\0\0\0', 'utf8');
  const syncTexture = Buffer.alloc(20 + names.length + 8 * 4);
  syncTexture.write('RTXT', 0, 'ascii');
  syncTexture.writeUInt32LE(101, 4);
  syncTexture.writeUInt32LE(2, 8);
  syncTexture.writeUInt32LE(2, 12);
  syncTexture.writeUInt32LE(1, 16);
  names.copy(syncTexture, 20);

  return {
    't3Terrain.xml': TERRAIN_DESCRIPTOR,
    t3HeightMap: heightMap,
    t3SyncHeightMap: syncHeight,
    t3CellFlags: cellFlags,
    t3TextureMasks: textureMasks,
    t3SyncCliffLevel: syncCliff,
    t3SyncTextureInfo: syncTexture,
  };
}

interface Harness {
  client: Client;
  temp: TempDir;
  sourceDir: string;
  close(): Promise<void>;
}

/** Anything a tool returns, once the SDK has projected it onto the wire. */
interface ToolCallOutcome {
  isError: boolean;
  text: string;
  structured: Record<string, unknown>;
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolCallOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const firstBlock = result.content?.[0];
  return {
    isError: result.isError === true,
    text: firstBlock?.type === 'text' ? firstBlock.text : '',
    structured: (result.structuredContent ?? {}) as Record<string, unknown>,
  };
}

async function createHarness(): Promise<Harness> {
  const temp = await createTempDir('sc2mcp-e2e-');
  const sourceDir = path.join(temp.path, 'source', 'TestMap.SC2Map');
  await writeTree(sourceDir, { ...DOCUMENT_FIXTURE });

  const config = configFromObject({
    allowedRoots: [temp.path],
    workspaceRoot: path.join(temp.path, 'state'),
  });

  const context = await createContext({
    config,
    logger: createNullLogger(),
    // Keep the test independent of whether this machine has StarCraft II installed, or
    // whether the developer happened to have built the native helper.
    skipInstallationDetection: true,
    skipMpqHelperProbe: true,
    skipGalaxyToolkitProbe: true,
  });

  const server = createMcpServer(context);
  const client = new Client({ name: 'sc2-mcp-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    temp,
    sourceDir,
    close: async () => {
      await client.close();
      await server.close();
      await temp.cleanup();
    },
  };
}

describe('MCP server', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('lists every registered tool with a schema and annotations', async () => {
    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      'sc2_add_component',
      'sc2_add_dependency',
      'sc2_apply_galaxy_patch',
      'sc2_apply_layout_patch',
      'sc2_check_shared_object',
      'sc2_clone_catalog_object',
      'sc2_clone_trigger',
      'sc2_commit_document',
      'sc2_copy_text_key',
      'sc2_create_catalog_object',
      'sc2_create_galaxy_file',
      'sc2_create_layout',
      'sc2_create_region',
      'sc2_create_snapshot',
      'sc2_create_unit_from_template',
      'sc2_delete_catalog_object',
      'sc2_delete_object',
      'sc2_delete_region',
      'sc2_delete_text_key',
      'sc2_delete_trigger',
      'sc2_detect_installations',
      'sc2_diff_workspace',
      'sc2_discard_workspace',
      'sc2_find_catalog_references',
      'sc2_find_missing_localization',
      'sc2_get_catalog_object',
      'sc2_get_changes',
      'sc2_get_dependencies',
      'sc2_get_document_info',
      'sc2_get_document_summary',
      'sc2_get_editor_logs',
      'sc2_get_galaxy_diagnostics',
      'sc2_get_galaxy_file',
      'sc2_get_galaxy_symbols',
      'sc2_get_last_test_log',
      'sc2_get_layout',
      'sc2_get_layout_diagnostics',
      'sc2_get_map_players',
      'sc2_get_server_info',
      'sc2_get_terrain_cell',
      'sc2_get_terrain_component',
      'sc2_get_terrain_summary',
      'sc2_get_terrain_vertex',
      'sc2_get_text_value',
      'sc2_get_trigger',
      'sc2_get_user_maps',
      'sc2_isolate_shared_object',
      'sc2_launch_editor',
      'sc2_list_catalog_domains',
      'sc2_list_component_types',
      'sc2_list_components',
      'sc2_list_files',
      'sc2_list_galaxy_files',
      'sc2_list_layouts',
      'sc2_list_locales',
      'sc2_list_placed_objects',
      'sc2_list_regions',
      'sc2_list_snapshots',
      'sc2_list_triggers',
      'sc2_list_workspaces',
      'sc2_open_document',
      'sc2_patch_catalog_object',
      'sc2_patch_terrain_component',
      'sc2_place_object',
      'sc2_read_file',
      'sc2_remove_component',
      'sc2_remove_dependency',
      'sc2_rename_trigger',
      'sc2_resolve_catalog_object',
      'sc2_restore_snapshot',
      'sc2_revert_change',
      'sc2_search_catalog',
      'sc2_search_files',
      'sc2_search_layouts',
      'sc2_search_text_keys',
      'sc2_search_triggers',
      'sc2_set_document_info',
      'sc2_set_galaxy_entrypoint',
      'sc2_set_map_player_slots',
      'sc2_set_terrain_cell_flags',
      'sc2_set_terrain_cliff',
      'sc2_set_terrain_height',
      'sc2_set_terrain_texture',
      'sc2_set_text_value',
      'sc2_set_unit_weapon_damage',
      'sc2_test_document',
      'sc2_update_component',
      'sc2_update_object',
      'sc2_update_region',
      'sc2_validate_document',
    ]);

    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} needs an input schema`).toBeTruthy();
      expect(tool.annotations, `${tool.name} needs annotations`).toBeDefined();
    }
  });

  it('marks mutating tools as not read-only', async () => {
    const { tools } = await harness.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    // PLAN.md §14: a tool that creates workspace files is not "read only".
    expect(byName.get('sc2_open_document')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('sc2_discard_workspace')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('sc2_discard_workspace')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('sc2_get_server_info')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('sc2_read_file')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('sc2_test_document')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('sc2_get_last_test_log')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('sc2_add_component')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('sc2_clone_trigger')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('sc2_delete_trigger')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('sc2_set_galaxy_entrypoint')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('sc2_set_map_player_slots')?.annotations?.destructiveHint).toBe(true);

    // Restoring a snapshot discards every later change, so it is destructive; taking one
    // writes files but can never lose anything, so it is not.
    expect(byName.get('sc2_restore_snapshot')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('sc2_revert_change')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('sc2_create_snapshot')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('sc2_create_snapshot')?.annotations?.destructiveHint).toBe(false);
  });

  it('reports an empty runtime-test log before the first launch', async () => {
    const outcome = await callTool(harness.client, 'sc2_get_last_test_log');
    expect(outcome.isError).toBe(false);
    expect(outcome.structured['run']).toBeNull();
    expect(outcome.structured['logs']).toEqual([]);
    expect(outcome.structured['alertsContent']).toBeNull();
    expect(outcome.structured['scriptErrorContent']).toBeNull();
  });

  it('reports honest capabilities from sc2_get_server_info', async () => {
    const outcome = await callTool(harness.client, 'sc2_get_server_info');
    expect(outcome.isError).toBe(false);

    const capabilities = outcome.structured['capabilities'] as Record<string, { read: boolean; write: boolean }>;
    // Workspace staging and catalog reading work in this build...
    expect(capabilities['workspace']).toEqual({ read: true, write: true });
    expect(capabilities['components']).toEqual({ read: true, write: true });
    expect(capabilities['gamedata']).toEqual({ read: true, write: true, inheritance: true });
    // ...and nothing that depends on an unbuilt backend claims to.
    expect(capabilities['mpq']).toEqual({ read: false, write: false });
    expect(capabilities['layout']).toEqual({ read: true, write: true });
    expect(capabilities['terrain']).toEqual({ read: true, write: true });
    // Objects and Regions are plain XML and need no external backend, so they are writable
    // wherever the server runs.
    expect(capabilities['objects']).toEqual({ read: true, write: true });
    expect(capabilities['triggers']).toEqual({ read: true, write: true });
    expect(capabilities['localization']).toEqual({ read: true, write: true });
    // Galaxy is implemented but gated on the vendored toolkit, which this harness skips.
    expect(capabilities['galaxy']).toEqual({ read: false, write: false, typecheck: false });

    const limitations = outcome.structured['limitations'] as string[];
    expect(limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Packed'),
        expect.stringContaining('Galaxy scripts'),
        expect.stringContaining('type checking'),
        expect.stringContaining('Automated in-game testing'),
      ]),
    );
    expect(limitations).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('SC2Layout'),
        expect.stringContaining('Terrain'),
      ]),
    );
  });

  it('reads, searches, creates, and losslessly patches SC2Layout files through MCP', async () => {
    const layoutPath = 'Base.SC2Data/UI/Layout/Test.SC2Layout';
    const original = '<?xml version="1.0" encoding="utf-8"?>\r\n<Desc>\r\n    <Frame type="Frame" name="Root"/>\r\n</Desc>\r\n';
    await writeTree(harness.sourceDir, { [layoutPath]: original });

    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const listed = await callTool(harness.client, 'sc2_list_layouts', { workspace_id: workspaceId });
    expect((listed.structured['layouts'] as { path: string }[]).map((layout) => layout.path)).toEqual([layoutPath]);

    const read = await callTool(harness.client, 'sc2_get_layout', { workspace_id: workspaceId, path: layoutPath });
    expect(read.structured['content']).toBe(original);
    const diagnostics = await callTool(harness.client, 'sc2_get_layout_diagnostics', { workspace_id: workspaceId, path: layoutPath });
    expect(diagnostics.structured['valid']).toBe(true);
    const searched = await callTool(harness.client, 'sc2_search_layouts', { workspace_id: workspaceId, query: 'Root' });
    expect(searched.structured['total']).toBe(1);

    const patchArgs = {
      workspace_id: workspaceId,
      path: layoutPath,
      selector: { element: 'Frame', attributes: { name: 'Root' } },
      patch: { op: 'set_attribute', name: 'name', value: 'EditedRoot' },
    };
    const preview = await callTool(harness.client, 'sc2_apply_layout_patch', patchArgs);
    expect(preview.structured['dryRun']).toBe(true);
    expect((await callTool(harness.client, 'sc2_get_layout', { workspace_id: workspaceId, path: layoutPath })).structured['content']).toBe(original);

    const applied = await callTool(harness.client, 'sc2_apply_layout_patch', { ...patchArgs, dry_run: false });
    expect(applied.isError).toBe(false);
    const edited = (await callTool(harness.client, 'sc2_get_layout', { workspace_id: workspaceId, path: layoutPath })).structured['content'] as string;
    expect(edited).toContain('name="EditedRoot"');
    expect(edited.replace('name="EditedRoot"', 'name="Root"')).toBe(original);

    const createdPath = 'Base.SC2Data/UI/Layout/Created.SC2Layout';
    const created = await callTool(harness.client, 'sc2_create_layout', {
      workspace_id: workspaceId,
      path: createdPath,
      dry_run: false,
    });
    expect(created.isError).toBe(false);
    expect((await callTool(harness.client, 'sc2_get_layout_diagnostics', { workspace_id: workspaceId, path: createdPath })).structured['valid']).toBe(true);
  });

  it('includes SC2Layout structural errors in aggregate validation', async () => {
    const layoutPath = 'Base.SC2Data/UI/Layout/Broken.SC2Layout';
    await writeTree(harness.sourceDir, { [layoutPath]: '<Desc><Frame type="Frame"/></Desc>' });
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const validation = await callTool(harness.client, 'sc2_validate_document', { workspace_id: workspaceId });
    expect(validation.structured['valid']).toBe(false);
    const checks = validation.structured['checks'] as Record<string, { status: string }>;
    expect(checks['xml']?.status).toBe('failed');
    const errors = validation.structured['errors'] as { path?: string; message: string }[];
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: layoutPath, message: expect.stringContaining('name attribute') })]));
  });

  it('decodes and writes synchronized terrain components through MCP', async () => {
    await writeTree(harness.sourceDir, terrainFixture());
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const summary = await callTool(harness.client, 'sc2_get_terrain_summary', { workspace_id: workspaceId });
    expect(summary.structured['valid']).toBe(true);
    expect((summary.structured['descriptor'] as Record<string, unknown>)['width']).toBe(3);

    const originalVertex = await callTool(harness.client, 'sc2_get_terrain_vertex', { workspace_id: workspaceId, x: 1, y: 2 });
    expect(originalVertex.structured['worldHeight']).toBeCloseTo(8, 3);
    const heightPreview = await callTool(harness.client, 'sc2_set_terrain_height', {
      workspace_id: workspaceId,
      x: 1,
      y: 2,
      world_height: 10.5,
    });
    expect(heightPreview.structured['dryRun']).toBe(true);
    expect((await callTool(harness.client, 'sc2_get_terrain_vertex', { workspace_id: workspaceId, x: 1, y: 2 })).structured['worldHeight']).toBeCloseTo(8, 3);
    await callTool(harness.client, 'sc2_set_terrain_height', { workspace_id: workspaceId, x: 1, y: 2, world_height: 10.5, dry_run: false });
    const editedVertex = await callTool(harness.client, 'sc2_get_terrain_vertex', { workspace_id: workspaceId, x: 1, y: 2 });
    expect(editedVertex.structured['worldHeight']).toBeCloseTo(10.5, 3);
    expect(editedVertex.structured['syncHeight']).toBeCloseTo(10.5, 3);

    await callTool(harness.client, 'sc2_set_terrain_cell_flags', { workspace_id: workspaceId, x: 1, y: 0, flags: 0xa5, dry_run: false });
    await callTool(harness.client, 'sc2_set_terrain_texture', {
      workspace_id: workspaceId,
      x: 0,
      y: 1,
      weights: [0, 15, 2, 3, 4, 5, 6, 7],
      dry_run: false,
    });
    await callTool(harness.client, 'sc2_set_terrain_cliff', {
      workspace_id: workspaceId,
      x: 0,
      y: 0,
      flags: 1,
      cliff_id: 0,
      variation: 2,
      cliff_level: 5,
      dry_run: false,
    });

    const textured = await callTool(harness.client, 'sc2_get_terrain_cell', { workspace_id: workspaceId, x: 0, y: 1 });
    expect(textured.structured['textureWeights']).toEqual([0, 15, 2, 3, 4, 5, 6, 7]);
    expect(textured.structured['textureIndex']).toBe(1);
    const cliff = await callTool(harness.client, 'sc2_get_terrain_cell', { workspace_id: workspaceId, x: 0, y: 0 });
    expect(cliff.structured['cliffLevel']).toBe(5);
    expect(cliff.structured['descriptorCliff']).toEqual({ index: 0, flags: 1, cliffId: 0, variation: 2 });

    const raw = await callTool(harness.client, 'sc2_get_terrain_component', {
      workspace_id: workspaceId,
      component: 't3CellFlags',
      offset: 33,
      length: 1,
    });
    expect(raw.structured['dataBase64']).toBe(Buffer.from([0xa5]).toString('base64'));
    await callTool(harness.client, 'sc2_patch_terrain_component', {
      workspace_id: workspaceId,
      component: 't3CellFlags',
      offset: 33,
      data_base64: Buffer.from([7]).toString('base64'),
      dry_run: false,
    });
    expect((await callTool(harness.client, 'sc2_get_terrain_cell', { workspace_id: workspaceId, x: 1, y: 0 })).structured['flags']).toBe(7);

    const validation = await callTool(harness.client, 'sc2_validate_document', { workspace_id: workspaceId });
    expect((validation.structured['checks'] as Record<string, { status: string }>)['terrain']?.status).toBe('passed');
  });

  it('reads and synchronizes MapInfo and Attributes player slots through MCP', async () => {
    await writeTree(harness.sourceDir, { MapInfo: MAP_INFO_FIXTURE, Attributes: ATTRIBUTES_FIXTURE });
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const before = await callTool(harness.client, 'sc2_get_map_players', { workspace_id: workspaceId });
    expect((before.structured['players'] as unknown[])).toHaveLength(8);

    const preview = await callTool(harness.client, 'sc2_set_map_player_slots', {
      workspace_id: workspaceId,
      max_players: 4,
      remove_computer_players: true,
    });
    expect(preview.structured['dryRun']).toBe(true);
    expect((await callTool(harness.client, 'sc2_get_map_players', { workspace_id: workspaceId })).structured['players']).toHaveLength(8);

    const applied = await callTool(harness.client, 'sc2_set_map_player_slots', {
      workspace_id: workspaceId,
      max_players: 4,
      remove_computer_players: true,
      dry_run: false,
    });
    expect(applied.isError).toBe(false);
    const after = await callTool(harness.client, 'sc2_get_map_players', { workspace_id: workspaceId });
    expect((after.structured['players'] as { controller: number }[]).map((player) => player.controller)).toEqual([0, 1, 2, 3, 4, 15]);

    const attributes = await callTool(harness.client, 'sc2_read_file', { workspace_id: workspaceId, path: 'Attributes' });
    expect(attributes.structured['content']).toContain('<Slot Id="3"/>');
    expect(attributes.structured['content']).not.toContain('<Slot Id="4"/>');
  });

  it('opens a document, inspects it, and discards it', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    expect(opened.isError).toBe(false);

    const workspace = opened.structured['workspace'] as Record<string, unknown>;
    const workspaceId = workspace['id'] as string;
    expect(workspace['documentKind']).toBe('map');
    expect(opened.structured['stagedFileCount']).toBe(Object.keys(DOCUMENT_FIXTURE).length);

    const summary = await callTool(harness.client, 'sc2_get_document_summary', { workspace_id: workspaceId });
    expect(summary.isError).toBe(false);
    expect(summary.structured['topLevelEntries']).toEqual(
      expect.arrayContaining(['Base.SC2Data', 'ComponentList.SC2Components', 'DocumentInfo']),
    );
    // The model must be told what is unknown rather than inferring "absent".
    expect(summary.structured['notYetImplemented']).toEqual(expect.arrayContaining(['catalogCounts']));
    expect(summary.structured['componentTypes']).toEqual(['gada', 'text', 'info']);
    expect(summary.structured['locales']).toEqual(['enUS']);
    expect(summary.structured['documentName']).toBe('Test Document');
    expect(summary.structured['dependencyCount']).toBe(1);

    const listed = await callTool(harness.client, 'sc2_list_files', {
      workspace_id: workspaceId,
      path_prefix: 'Base.SC2Data',
    });
    const files = listed.structured['files'] as { path: string }[];
    expect(files.map((file) => file.path).sort()).toEqual([
      'Base.SC2Data/GameData/EffectData.xml',
      'Base.SC2Data/GameData/UnitData.xml',
      'Base.SC2Data/GameData/WeaponData.xml',
      'Base.SC2Data/LibTest.galaxy',
    ]);

    const read = await callTool(harness.client, 'sc2_read_file', {
      workspace_id: workspaceId,
      path: 'Base.SC2Data/GameData/UnitData.xml',
    });
    expect(read.structured['content']).toBe(DOCUMENT_FIXTURE['Base.SC2Data/GameData/UnitData.xml']);

    const searched = await callTool(harness.client, 'sc2_search_files', {
      workspace_id: workspaceId,
      query: 'TestMarine',
    });
    const matches = searched.structured['matches'] as { path: string; line: number }[];
    // The id appears in the catalog and again as a localisation key, and the search is
    // deliberately format-agnostic: it reports both rather than guessing which matters.
    expect([...new Set(matches.map((match) => match.path))].sort()).toEqual([
      'Base.SC2Data/GameData/UnitData.xml',
      'enUS.SC2Data/LocalizedData/GameStrings.txt',
    ]);

    const discarded = await callTool(harness.client, 'sc2_discard_workspace', { workspace_id: workspaceId });
    expect(discarded.structured['discarded']).toBe(true);

    // The workspace is genuinely gone.
    const afterDiscard = await callTool(harness.client, 'sc2_get_document_summary', { workspace_id: workspaceId });
    expect(afterDiscard.isError).toBe(true);
  });

  it('returns a structured error payload, not a bare message, when a path is denied', async () => {
    const outsideRoot = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc';
    const outcome = await callTool(harness.client, 'sc2_open_document', { source_path: outsideRoot });

    expect(outcome.isError).toBe(true);
    const error = outcome.structured['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SC2_PATH_DENIED');
    expect(error['recoverable']).toBe(true);
    expect(error['suggestedAction']).toBeTruthy();
    expect(outcome.text).toContain('SC2_PATH_DENIED');
  });

  it('rejects an unknown workspace id with SC2_WORKSPACE_NOT_FOUND', async () => {
    const outcome = await callTool(harness.client, 'sc2_get_document_summary', {
      workspace_id: `ws_${'0'.repeat(32)}`,
    });
    expect(outcome.isError).toBe(true);
    expect((outcome.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_WORKSPACE_NOT_FOUND');
  });

  it('rejects a malformed workspace id before touching the filesystem', async () => {
    const outcome = await callTool(harness.client, 'sc2_get_document_summary', { workspace_id: '../../etc' });
    expect(outcome.isError).toBe(true);
    expect((outcome.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_INVALID_ARGUMENT');
  });

  it('refuses to read outside the workspace staging tree', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const outcome = await callTool(harness.client, 'sc2_read_file', {
      workspace_id: workspaceId,
      path: '../../../../state/config.json',
    });
    expect(outcome.isError).toBe(true);
    expect((outcome.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_PATH_DENIED');
  });

  it('rejects input that violates the tool schema before the handler runs', async () => {
    // `limit` is capped at 500. The SDK validates against the declared input schema and
    // turns the failure into an error result, so the handler never sees the call — note
    // the deliberately bogus workspace_id never produces a workspace error.
    const result = await harness.client.callTool({
      name: 'sc2_list_files',
      arguments: { workspace_id: 'ws_x', limit: 10_000 },
    });

    expect(result.isError).toBe(true);
    const firstBlock = result.content?.[0];
    expect(firstBlock?.type === 'text' ? firstBlock.text : '').toContain('Input validation error');
  });

  it('inventories components and resolves them to real staged files', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const listed = await callTool(harness.client, 'sc2_list_components', { workspace_id: workspaceId });
    expect(listed.isError).toBe(false);
    expect(listed.structured['hasComponentList']).toBe(true);

    const components = listed.structured['components'] as {
      typeCode: string;
      resolvedPaths: string[];
      writable: boolean;
      exists: boolean;
    }[];

    const gameData = components.find((component) => component.typeCode === 'gada');
    expect([...(gameData?.resolvedPaths ?? [])].sort()).toEqual([
      'Base.SC2Data/GameData/EffectData.xml',
      'Base.SC2Data/GameData/UnitData.xml',
      'Base.SC2Data/GameData/WeaponData.xml',
    ]);
    expect(gameData?.exists).toBe(true);

    const text = components.find((component) => component.typeCode === 'text');
    expect(text?.resolvedPaths).toEqual(['enUS.SC2Data/LocalizedData/GameStrings.txt']);

    expect(gameData?.writable).toBe(true);
    expect(components.find((component) => component.typeCode === 'info')?.writable).toBe(true);
  });

  it('adds, updates, and removes component declarations through MCP', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const added = await callTool(harness.client, 'sc2_add_component', {
      workspace_id: workspaceId,
      type_code: 'test',
      path: 'Base.SC2Data/LibTest.galaxy',
      dry_run: false,
    });
    expect(added.isError).toBe(false);
    expect((added.structured['component'] as Record<string, unknown>)['exists']).toBe(true);

    const updated = await callTool(harness.client, 'sc2_update_component', {
      workspace_id: workspaceId,
      type_code: 'test',
      new_path: 'Base.SC2Data/GameData/UnitData.xml',
      dry_run: false,
    });
    expect(updated.isError).toBe(false);
    expect((updated.structured['component'] as Record<string, unknown>)['path']).toBe(
      'Base.SC2Data/GameData/UnitData.xml',
    );

    const removed = await callTool(harness.client, 'sc2_remove_component', {
      workspace_id: workspaceId,
      type_code: 'test',
      dry_run: false,
    });
    expect(removed.isError).toBe(false);
    const listed = await callTool(harness.client, 'sc2_list_components', { workspace_id: workspaceId });
    expect((listed.structured['components'] as { typeCode: string }[]).some((entry) => entry.typeCode === 'test')).toBe(false);
  });

  it('sets a bounded Galaxy entrypoint through MCP', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const applied = await callTool(harness.client, 'sc2_set_galaxy_entrypoint', {
      workspace_id: workspaceId,
      library_path: 'Base.SC2Data/LibTest.galaxy',
      init_function: 'TestInit',
      dry_run: false,
    });
    expect(applied.isError).toBe(false);

    const mapScript = await callTool(harness.client, 'sc2_get_galaxy_file', {
      workspace_id: workspaceId,
      path: 'MapScript.galaxy',
    });
    expect(mapScript.structured['content']).toContain('include "Base.SC2Data/LibTest"');
    expect(mapScript.structured['content']).toContain('    TestInit();');
    expect(mapScript.structured['content']).not.toContain('InitTriggers');
  });

  it('clones and deletes complete trigger subgraphs through MCP', async () => {
    await writeTree(harness.sourceDir, {
      Triggers: TRIGGER_FIXTURE,
      'enUS.SC2Data/LocalizedData/TriggerStrings.txt':
        'Category/Name/AAAAAAAA=Folder\r\nTrigger/Name/BBBBBBBB=Original\r\n',
      'ComponentList.SC2Components': String(DOCUMENT_FIXTURE['ComponentList.SC2Components']).replace(
        '</Components>',
        '    <DataComponent Type="trig">Triggers</DataComponent>\r\n</Components>',
      ),
    });
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const listed = await callTool(harness.client, 'sc2_list_triggers', { workspace_id: workspaceId, max_depth: 5 });
    expect(listed.isError).toBe(false);
    expect((listed.structured['tree'] as { children: unknown[] }[])[0]?.children).toHaveLength(1);

    const cloned = await callTool(harness.client, 'sc2_clone_trigger', {
      workspace_id: workspaceId,
      source_id: 'BBBBBBBB',
      parent_id: 'AAAAAAAA',
      new_name: 'Cloned trigger',
      dry_run: false,
    });
    expect(cloned.isError).toBe(false);
    const clonedRootId = cloned.structured['clonedRootId'] as string;
    const clone = await callTool(harness.client, 'sc2_get_trigger', {
      workspace_id: workspaceId,
      id: clonedRootId,
    });
    expect(clone.isError).toBe(false);
    expect(clone.structured['childIds']).toHaveLength(1);
    expect(clone.structured['name']).toBe('Cloned trigger');

    const deleted = await callTool(harness.client, 'sc2_delete_trigger', {
      workspace_id: workspaceId,
      id: clonedRootId,
      parent_id: 'AAAAAAAA',
      dry_run: false,
    });
    expect(deleted.isError).toBe(false);
    expect((deleted.structured['removedIds'] as string[]).length).toBe(2);
    expect(
      (await callTool(harness.client, 'sc2_get_trigger', { workspace_id: workspaceId, id: clonedRootId })).isError,
    ).toBe(true);
  });

  it('reads DocumentInfo and its dependency chain', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const info = await callTool(harness.client, 'sc2_get_document_info', { workspace_id: workspaceId });
    expect(info.structured['name']).toBe('Test Document');
    expect(info.structured['modType']).toBe('Interface');
    // A field the file does not contain must read as null, not "".
    expect(info.structured['author']).toBeNull();

    const dependencies = await callTool(harness.client, 'sc2_get_dependencies', { workspace_id: workspaceId });
    const entries = dependencies.structured['dependencies'] as { name: string; file: string }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('Void Multi (Mod)');
    expect(entries[0]?.file).toBe('Mods/VoidMulti.SC2Mod');
    // Nothing here resolves, so no dependency catalogs are loaded — and the note must say
    // so, or a model would read a later "not found" as "does not exist".
    expect(dependencies.structured['loadedCount']).toBe(0);
    expect(String(dependencies.structured['note'])).toContain('not in what was loaded');
  });

  it('reports a missing DocumentInfo as SC2_NOT_FOUND rather than inventing one', async () => {
    const bareDocument = path.join(harness.temp.path, 'bare', 'Bare.SC2Map');
    await writeTree(bareDocument, { 'Base.SC2Data/GameData/UnitData.xml': '<Catalog/>' });

    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: bareDocument });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const info = await callTool(harness.client, 'sc2_get_document_info', { workspace_id: workspaceId });
    expect(info.isError).toBe(true);
    expect((info.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_NOT_FOUND');

    // And the summary must say the component list is absent, not pretend it is empty.
    const summary = await callTool(harness.client, 'sc2_get_document_summary', { workspace_id: workspaceId });
    expect(summary.structured['componentCount']).toBeNull();
    const diagnostics = summary.structured['diagnostics'] as { severity: string; message: string }[];
    expect(diagnostics.some((entry) => entry.message.includes('ComponentList'))).toBe(true);
  });

  it('surfaces a malformed component list as a diagnostic instead of failing the summary', async () => {
    const brokenDocument = path.join(harness.temp.path, 'broken', 'Broken.SC2Map');
    await writeTree(brokenDocument, { 'ComponentList.SC2Components': '<Components><DataComponent Type="gada">' });

    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: brokenDocument });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const summary = await callTool(harness.client, 'sc2_get_document_summary', { workspace_id: workspaceId });
    // Knowing the file is broken beats getting nothing at all.
    expect(summary.isError).toBe(false);
    const diagnostics = summary.structured['diagnostics'] as { severity: string; code: string }[];
    expect(diagnostics.some((entry) => entry.severity === 'error' && entry.code === 'SC2_PARSE_ERROR')).toBe(true);
  });

  it('answers Data Editor questions about the catalog', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const domains = await callTool(harness.client, 'sc2_list_catalog_domains', { workspace_id: workspaceId });
    expect(domains.structured['present']).toEqual([
      { domain: 'Effect', count: 1 },
      { domain: 'Unit', count: 3 },
      { domain: 'Weapon', count: 1 },
    ]);

    const search = await callTool(harness.client, 'sc2_search_catalog', { workspace_id: workspaceId, query: 'marine' });
    const results = search.structured['results'] as { domain: string; id: string }[];
    expect(results.map((entry) => `${entry.domain}/${entry.id}`)).toEqual(['Unit/TestMarine', 'Unit/TestMarineBase']);

    const object = await callTool(harness.client, 'sc2_get_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestMarine',
    });
    expect(object.structured['parent']).toBe('TestMarineBase');
    // Raw XML comes from the recorded span, so it is the declaration verbatim.
    expect(object.structured['rawXml']).toContain('<CUnit id="TestMarine" parent="TestMarineBase">');

    const resolved = await callTool(harness.client, 'sc2_resolve_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestMarine',
    });
    const fields = new Map(
      (resolved.structured['fields'] as { path: string; value: string; definedBy: string }[]).map((field) => [field.path, field]),
    );
    // Overridden locally...
    expect(fields.get('LifeMax')).toMatchObject({ value: '60', definedBy: 'Unit/TestMarine' });
    // ...and inherited, with the source named so a caller knows editing it hits the parent.
    expect(fields.get('Speed')).toMatchObject({ value: '2.25', definedBy: 'Unit/TestMarineBase' });
    expect(resolved.structured['complete']).toBe(true);

    const references = await callTool(harness.client, 'sc2_find_catalog_references', {
      workspace_id: workspaceId,
      domain: 'Weapon',
      id: 'TestRifle',
    });
    // Two units share the weapon, so a naive damage edit would hit both. The tool has to
    // say so (PLAN.md §45).
    expect(references.structured['shared']).toBe(true);
    expect(references.structured['total']).toBe(2);
    expect(references.structured['note']).toContain('clone it first');
  });

  it('reports an unknown catalog object without implying it does not exist', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const outcome = await callTool(harness.client, 'sc2_get_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'Zealot',
    });

    expect(outcome.isError).toBe(true);
    const error = outcome.structured['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SC2_NOT_FOUND');
    // Dependencies are not indexed, and the model must be told that rather than
    // concluding the unit is absent from the game.
    expect(String(error['suggestedAction'])).toContain('dependency');
  });

  it('rejects an unknown domain instead of returning zero results', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const outcome = await callTool(harness.client, 'sc2_search_catalog', {
      workspace_id: workspaceId,
      domains: ['Untis'],
    });

    // An empty result for a typo'd domain would read as "this map has no units".
    expect(outcome.isError).toBe(true);
    expect((outcome.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_INVALID_ARGUMENT');
  });

  it('reports an unmodified workspace as having no changes and no diff', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const diff = await callTool(harness.client, 'sc2_diff_workspace', { workspace_id: workspaceId });
    expect(diff.structured['filesChanged']).toEqual([]);
    expect(diff.structured['comparedAgainst']).toContain('original source');

    const changes = await callTool(harness.client, 'sc2_get_changes', { workspace_id: workspaceId });
    expect(changes.structured['changes']).toEqual([]);
    expect(changes.structured['currentRevision']).toBe(0);
  });

  it('snapshots, then sees the staged edit in a diff against that snapshot', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;
    const stagingPath = (opened.structured['workspace'] as Record<string, unknown>)['stagingPath'] as string;

    const snapshot = await callTool(harness.client, 'sc2_create_snapshot', {
      workspace_id: workspaceId,
      label: 'before hand edit',
    });
    const snapshotId = snapshot.structured['snapshotId'] as string;
    expect(snapshotId).toMatch(/^snap_/);

    // Stand in for a mutating tool (Phase 8) by editing the staging tree directly — which
    // is also what happens if the user opens it in the editor (PLAN.md §50).
    await writeFile(path.join(stagingPath, 'DocumentInfo'), 'EDITED OUTSIDE\n', 'utf8');

    const diff = await callTool(harness.client, 'sc2_diff_workspace', {
      workspace_id: workspaceId,
      snapshot_id: snapshotId,
    });
    const changed = diff.structured['filesChanged'] as { path: string; diff: string }[];
    expect(changed.map((file) => file.path)).toEqual(['DocumentInfo']);
    expect(changed[0]?.diff).toContain('+EDITED OUTSIDE');

    // Restoring puts it back and moves the revision forward, never backward.
    const restored = await callTool(harness.client, 'sc2_restore_snapshot', {
      workspace_id: workspaceId,
      snapshot_id: snapshotId,
    });
    expect(restored.structured['revisionAfter']).toBe(1);

    const afterRestore = await callTool(harness.client, 'sc2_diff_workspace', {
      workspace_id: workspaceId,
      snapshot_id: snapshotId,
    });
    expect(afterRestore.structured['filesChanged']).toEqual([]);
  });

  it('lists snapshots with their labels', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    await callTool(harness.client, 'sc2_create_snapshot', { workspace_id: workspaceId, label: 'checkpoint' });
    const listed = await callTool(harness.client, 'sc2_list_snapshots', { workspace_id: workspaceId });

    const snapshots = listed.structured['snapshots'] as { label: string }[];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.label).toBe('checkpoint');
  });

  it('refuses to snapshot or restore a read-only workspace', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', {
      source_path: harness.sourceDir,
      read_only: true,
    });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const outcome = await callTool(harness.client, 'sc2_create_snapshot', { workspace_id: workspaceId });
    expect(outcome.isError).toBe(true);
    expect((outcome.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_UNSUPPORTED_OPERATION');
  });

  it('reports an unknown snapshot as SC2_NOT_FOUND', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const outcome = await callTool(harness.client, 'sc2_restore_snapshot', {
      workspace_id: workspaceId,
      snapshot_id: 'snap_does_not_exist',
    });
    expect(outcome.isError).toBe(true);
    expect((outcome.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_NOT_FOUND');
  });

  it('previews a catalog edit, applies it, and can revert it', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const patchArgs = {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestMarine',
      patches: [{ op: 'set', path: 'LifeMax', value: '125' }],
    };

    // Default is a dry run: nothing is written unless dry_run=false is explicit.
    const preview = await callTool(harness.client, 'sc2_patch_catalog_object', patchArgs);
    expect(preview.structured['dryRun']).toBe(true);
    expect(preview.structured['revisionAfter']).toBe(preview.structured['revisionBefore']);
    const previewDiff = (preview.structured['filesChanged'] as { diff: string }[])[0]?.diff ?? '';
    expect(previewDiff).toContain('-        <LifeMax value="60"/>');
    expect(previewDiff).toContain('+        <LifeMax value="125"/>');

    const stillOriginal = await callTool(harness.client, 'sc2_get_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestMarine',
    });
    expect(stillOriginal.structured['rawXml']).toContain('<LifeMax value="60"/>');

    const applied = await callTool(harness.client, 'sc2_patch_catalog_object', { ...patchArgs, dry_run: false });
    expect(applied.structured['dryRun']).toBe(false);
    expect(applied.structured['revisionAfter']).toBe(1);
    const changeId = applied.structured['changeId'] as string;

    // The catalog index must reflect the edit, not a cached pre-change view.
    const afterEdit = await callTool(harness.client, 'sc2_get_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestMarine',
    });
    expect(afterEdit.structured['rawXml']).toContain('<LifeMax value="125"/>');

    const reverted = await callTool(harness.client, 'sc2_revert_change', {
      workspace_id: workspaceId,
      change_id: changeId,
    });
    expect(reverted.isError).toBe(false);

    const afterRevert = await callTool(harness.client, 'sc2_get_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestMarine',
    });
    expect(afterRevert.structured['rawXml']).toContain('<LifeMax value="60"/>');
  });

  it('warns when patching an object other objects share', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    // TestRifle is referenced by two units in the fixture.
    const preview = await callTool(harness.client, 'sc2_patch_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Weapon',
      id: 'TestRifle',
      patches: [{ op: 'set', path: 'DisplayEffect', value: 'Something' }],
    });

    const diagnostics = preview.structured['diagnostics'] as { severity: string; message: string }[];
    expect(diagnostics.some((entry) => entry.severity === 'warning' && entry.message.includes('referenced by 2'))).toBe(true);
  });

  it('refuses a stale expected_revision', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    await callTool(harness.client, 'sc2_patch_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestMarine',
      patches: [{ op: 'set', path: 'LifeMax', value: '70' }],
      dry_run: false,
    });

    const stale = await callTool(harness.client, 'sc2_patch_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestMarine',
      patches: [{ op: 'set', path: 'LifeMax', value: '80' }],
      expected_revision: 0,
      dry_run: false,
    });

    expect(stale.isError).toBe(true);
    expect((stale.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_CONFLICT');
  });

  it('clones a shared weapon so one unit can diverge from the other', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    await callTool(harness.client, 'sc2_clone_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Weapon',
      source_id: 'TestRifle',
      new_id: 'TestRailRifle',
      dry_run: false,
    });

    await callTool(harness.client, 'sc2_patch_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestMarine',
      patches: [{ op: 'set_link', path: 'WeaponArray[0]', value: 'TestRailRifle' }],
      dry_run: false,
    });

    // The other unit still points at the original — which is the whole point of cloning.
    const reaper = await callTool(harness.client, 'sc2_get_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestReaper',
    });
    expect(reaper.structured['rawXml']).toContain('Link="TestRifle"');

    const references = await callTool(harness.client, 'sc2_find_catalog_references', {
      workspace_id: workspaceId,
      domain: 'Weapon',
      id: 'TestRifle',
    });
    expect(references.structured['shared']).toBe(false);
  });

  it('creates a new object with a parent and inherits through it', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    await callTool(harness.client, 'sc2_create_catalog_object', {
      workspace_id: workspaceId,
      ctype: 'CUnit',
      id: 'TestGhost',
      parent: 'TestMarineBase',
      dry_run: false,
    });

    const resolved = await callTool(harness.client, 'sc2_resolve_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestGhost',
    });
    const fields = resolved.structured['fields'] as { path: string; value: string; definedBy: string }[];
    expect(fields.find((field) => field.path === 'Speed')).toMatchObject({
      value: '2.25',
      definedBy: 'Unit/TestMarineBase',
    });
  });

  it('creates catalog objects with root attributes', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    await callTool(harness.client, 'sc2_create_catalog_object', {
      workspace_id: workspaceId,
      ctype: 'CActorUnit',
      id: 'TestMarineActor',
      parent: 'Marine',
      attributes: { unitName: 'TestMarine' },
      file: 'Base.SC2Data/GameData/ActorData.xml',
      dry_run: false,
    });

    const actor = await callTool(harness.client, 'sc2_get_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Actor',
      id: 'TestMarineActor',
    });
    expect(actor.structured['rawXml']).toContain('unitName="TestMarine"');
  });

  it('refuses to delete a referenced object, listing what would break', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const outcome = await callTool(harness.client, 'sc2_delete_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Weapon',
      id: 'TestRifle',
      dry_run: false,
    });

    expect(outcome.isError).toBe(true);
    const error = outcome.structured['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SC2_BROKEN_REFERENCE');
    expect(String((error['context'] as Record<string, unknown>)['references'])).toContain('Unit/TestMarine');
  });

  it('deletes an unreferenced object without complaint', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const outcome = await callTool(harness.client, 'sc2_delete_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestReaper',
      dry_run: false,
    });

    expect(outcome.isError).toBe(false);
    const search = await callTool(harness.client, 'sc2_search_catalog', { workspace_id: workspaceId, query: 'TestReaper' });
    expect(search.structured['total']).toBe(0);
  });

  it('refuses every mutation on a read-only workspace', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', {
      source_path: harness.sourceDir,
      read_only: true,
    });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const outcome = await callTool(harness.client, 'sc2_patch_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestMarine',
      patches: [{ op: 'set', path: 'LifeMax', value: '1' }],
      dry_run: false,
    });

    expect(outcome.isError).toBe(true);
    expect((outcome.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_UNSUPPORTED_OPERATION');
  });

  it('never modifies the source document, only the staging copy', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    await callTool(harness.client, 'sc2_patch_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestMarine',
      patches: [{ op: 'set', path: 'LifeMax', value: '999' }],
      dry_run: false,
    });

    // The single most important invariant in the whole server.
    const sourceContent = await readFile(
      path.join(harness.sourceDir, 'Base.SC2Data', 'GameData', 'UnitData.xml'),
      'utf8',
    );
    expect(sourceContent).toBe(DOCUMENT_FIXTURE['Base.SC2Data/GameData/UnitData.xml']);
  });

  it('reads, edits, and adds localized strings while preserving the file byte-for-byte', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;
    const stagingPath = (opened.structured['workspace'] as Record<string, unknown>)['stagingPath'] as string;

    const locales = await callTool(harness.client, 'sc2_list_locales', { workspace_id: workspaceId });
    expect(locales.structured['locales']).toEqual(['enUS']);

    const value = await callTool(harness.client, 'sc2_get_text_value', {
      workspace_id: workspaceId,
      key: 'Unit/Name/TestMarine',
    });
    expect(value.structured['value']).toBe('Test Marine');

    const applied = await callTool(harness.client, 'sc2_set_text_value', {
      workspace_id: workspaceId,
      entries: [
        { key: 'Unit/Name/TestMarine', value: 'Rail Marine' },
        { key: 'Unit/Name/BrandNew', value: 'Brand New' },
      ],
      dry_run: false,
    });
    expect(applied.isError).toBe(false);

    const tablePath = path.join(stagingPath, 'enUS.SC2Data', 'LocalizedData', 'GameStrings.txt');
    const raw = await readFile(tablePath, 'utf8');
    expect(raw).toContain('Unit/Name/TestMarine=Rail Marine');
    expect(raw).toContain('Unit/Name/BrandNew=Brand New');
    // CRLF endings survive the edit; a normalising writer would break the file's shape.
    expect(raw).toContain('\r\n');
  });

  it('reports a missing key as not-found rather than an empty string', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const outcome = await callTool(harness.client, 'sc2_get_text_value', {
      workspace_id: workspaceId,
      key: 'Unit/Name/Nope',
    });

    expect(outcome.isError).toBe(true);
    expect((outcome.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_NOT_FOUND');
  });

  it('copies a display name onto a cloned object', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    await callTool(harness.client, 'sc2_clone_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      source_id: 'TestMarine',
      new_id: 'RailMarine',
      dry_run: false,
    });

    await callTool(harness.client, 'sc2_copy_text_key', {
      workspace_id: workspaceId,
      copies: [{ from_key: 'Unit/Name/TestMarine', to_key: 'Unit/Name/RailMarine' }],
      dry_run: false,
    });

    const copied = await callTool(harness.client, 'sc2_get_text_value', {
      workspace_id: workspaceId,
      key: 'Unit/Name/RailMarine',
    });
    expect(copied.structured['value']).toBe('Test Marine');
  });

  it('finds catalog objects with no display name', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const outcome = await callTool(harness.client, 'sc2_find_missing_localization', {
      workspace_id: workspaceId,
      domains: ['Unit'],
    });

    const missing = outcome.structured['missing'] as { id: string }[];
    // TestMarine has a name in the fixture; the other two units do not.
    expect(missing.map((entry) => entry.id).sort()).toEqual(['TestMarineBase', 'TestReaper']);
    // The result has to say that an unnamed object is often correct, not a defect.
    expect(String(outcome.structured['note'])).toContain('by design');
  });

  it('refuses a text value containing a newline', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const outcome = await callTool(harness.client, 'sc2_set_text_value', {
      workspace_id: workspaceId,
      entries: [{ key: 'Unit/Name/Bad', value: 'line one\nline two' }],
      dry_run: false,
    });

    expect(outcome.isError).toBe(true);
    const error = outcome.structured['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SC2_INVALID_ARGUMENT');
    expect(String(error['suggestedAction'])).toContain('<n/>');
  });

  it('validates a document and states plainly what it did not check', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const report = await callTool(harness.client, 'sc2_validate_document', { workspace_id: workspaceId });
    expect(report.structured['valid']).toBe(true);

    const checks = report.structured['checks'] as Record<string, { status: string; reason?: string }>;
    expect(checks['gamedata']?.status).toBe('passed');
    expect(checks['xml']?.status).toBe('passed');

    // A missing component is inapplicable, not unsupported. Terrain has real codecs now,
    // so it must never be reported as an unchecked category.
    expect(report.structured['notChecked']).not.toEqual(expect.arrayContaining(['terrain']));
    expect(checks['terrain']?.status).toBe('skipped');
    expect(checks['terrain']?.reason).toContain('no t3Terrain.xml');

    // A category may only claim "passed" when it really ran, so anything that is not
    // passed has to explain itself.
    for (const category of ['galaxy', 'triggers'] as const) {
      const check = checks[category];
      expect(check, category).toBeDefined();
      if (check!.status !== 'passed' && check!.status !== 'failed') {
        expect(check!.reason, category).toBeTruthy();
      }
    }
  });

  it('reports malformed XML as a validation error', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspace = opened.structured['workspace'] as Record<string, unknown>;
    const workspaceId = workspace['id'] as string;

    await writeFile(
      path.join(workspace['stagingPath'] as string, 'Base.SC2Data', 'GameData', 'UnitData.xml'),
      '<Catalog><CUnit id="Broken">',
      'utf8',
    );

    const report = await callTool(harness.client, 'sc2_validate_document', { workspace_id: workspaceId });
    expect(report.structured['valid']).toBe(false);
    const errors = report.structured['errors'] as { category: string }[];
    expect(errors.some((finding) => finding.category === 'xml')).toBe(true);
  });

  it('commits to a new directory and leaves the source alone', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    await callTool(harness.client, 'sc2_patch_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestMarine',
      patches: [{ op: 'set', path: 'LifeMax', value: '125' }],
      dry_run: false,
    });

    const outputPath = path.join(harness.temp.path, 'out', 'Committed.SC2Map');
    const committed = await callTool(harness.client, 'sc2_commit_document', {
      workspace_id: workspaceId,
      output_path: outputPath,
    });

    expect(committed.isError).toBe(false);
    expect(committed.structured['overwritten']).toBe(false);

    const written = await readFile(path.join(outputPath, 'Base.SC2Data', 'GameData', 'UnitData.xml'), 'utf8');
    expect(written).toContain('<LifeMax value="125"/>');

    // The source still holds the original value.
    const source = await readFile(path.join(harness.sourceDir, 'Base.SC2Data', 'GameData', 'UnitData.xml'), 'utf8');
    expect(source).toContain('<LifeMax value="60"/>');
  });

  it('refuses to overwrite an existing destination unless asked', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;
    const outputPath = path.join(harness.temp.path, 'out2', 'Committed.SC2Map');

    await callTool(harness.client, 'sc2_commit_document', { workspace_id: workspaceId, output_path: outputPath });

    const second = await callTool(harness.client, 'sc2_commit_document', {
      workspace_id: workspaceId,
      output_path: outputPath,
    });
    expect(second.isError).toBe(true);
    expect((second.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_CONFLICT');

    const forced = await callTool(harness.client, 'sc2_commit_document', {
      workspace_id: workspaceId,
      output_path: outputPath,
      overwrite: true,
    });
    expect(forced.structured['overwritten']).toBe(true);
    // Backing up before an overwrite is the default, not something you have to remember.
    expect(forced.structured['backupPath']).toMatch(/backup-/);
  });

  it('refuses to commit when the source changed after opening', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    await writeFile(path.join(harness.sourceDir, 'DocumentInfo'), 'CHANGED BY SOMEONE ELSE', 'utf8');

    const outcome = await callTool(harness.client, 'sc2_commit_document', {
      workspace_id: workspaceId,
      output_path: path.join(harness.temp.path, 'out3', 'X.SC2Map'),
    });

    expect(outcome.isError).toBe(true);
    expect((outcome.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_SOURCE_CHANGED');
  });

  it('refuses to commit an invalid document unless forced', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspace = opened.structured['workspace'] as Record<string, unknown>;
    const workspaceId = workspace['id'] as string;

    await writeFile(
      path.join(workspace['stagingPath'] as string, 'Base.SC2Data', 'GameData', 'UnitData.xml'),
      '<Catalog><CUnit id="Broken">',
      'utf8',
    );

    const outputPath = path.join(harness.temp.path, 'out4', 'X.SC2Map');
    const refused = await callTool(harness.client, 'sc2_commit_document', {
      workspace_id: workspaceId,
      output_path: outputPath,
    });
    expect(refused.isError).toBe(true);
    expect((refused.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_VALIDATION_FAILED');

    const forced = await callTool(harness.client, 'sc2_commit_document', {
      workspace_id: workspaceId,
      output_path: outputPath,
      force: true,
    });
    expect(forced.isError).toBe(false);
    expect((forced.structured['validation'] as Record<string, unknown>)['valid']).toBe(false);
  });

  it('refuses to commit outside the allowed roots', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const outcome = await callTool(harness.client, 'sc2_commit_document', {
      workspace_id: workspaceId,
      output_path: process.platform === 'win32' ? 'C:\\Windows\\Temp\\Escaped.SC2Map' : '/tmp/Escaped.SC2Map',
    });

    expect(outcome.isError).toBe(true);
    expect((outcome.structured['error'] as Record<string, unknown>)['code']).toBe('SC2_PATH_DENIED');
  });

  it('creates a unit from a template with a name, stats, and its own weapon', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const created = await callTool(harness.client, 'sc2_create_unit_from_template', {
      workspace_id: workspaceId,
      base_unit_id: 'TestMarine',
      new_id: 'RailMarine',
      display_name: 'Rail Marine',
      stat_overrides: [{ path: 'LifeMax', value: '125' }],
      isolate_weapon: true,
      dry_run: false,
    });
    expect(created.isError).toBe(false);

    // Every object that appeared is named, not left for the caller to discover.
    const objects = created.structured['createdObjects'] as { domain: string; id: string }[];
    expect(objects.map((object) => `${object.domain}/${object.id}`)).toEqual(['Unit/RailMarine', 'Weapon/RailMarineTestRifle']);

    const resolved = await callTool(harness.client, 'sc2_resolve_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'RailMarine',
    });
    const fields = new Map(
      (resolved.structured['fields'] as { path: string; value: string; link: string }[]).map((field) => [field.path, field]),
    );
    expect(fields.get('LifeMax')?.value).toBe('125');
    expect(fields.get('WeaponArray[0]')?.link).toBe('RailMarineTestRifle');

    const name = await callTool(harness.client, 'sc2_get_text_value', {
      workspace_id: workspaceId,
      key: 'Unit/Name/RailMarine',
    });
    expect(name.structured['value']).toBe('Rail Marine');

    // And the unit it was copied from still points at the original weapon.
    const original = await callTool(harness.client, 'sc2_get_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestMarine',
    });
    expect(original.structured['rawXml']).toContain('Link="TestRifle"');
  });

  it('changes one unit\'s weapon damage without touching the units that share it', async () => {
    // PLAN.md §45's worked example, end to end.
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    // Both TestMarine and TestReaper use TestRifle -> TestRifleDamage (Amount 5).
    const applied = await callTool(harness.client, 'sc2_set_unit_weapon_damage', {
      workspace_id: workspaceId,
      unit_id: 'TestMarine',
      damage: '100',
      dry_run: false,
    });
    expect(applied.isError).toBe(false);

    // The shared weapon and effect were cloned rather than edited.
    const cloned = applied.structured['clonedForIsolation'] as string[];
    expect(cloned).toEqual(['Weapon/TestMarineTestRifle', 'Effect/TestMarineTestRifleDamage']);

    const isolatedEffect = await callTool(harness.client, 'sc2_get_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Effect',
      id: 'TestMarineTestRifleDamage',
    });
    expect(isolatedEffect.structured['rawXml']).toContain('<Amount value="100"/>');

    // The original effect is untouched, so TestReaper still does 5.
    const originalEffect = await callTool(harness.client, 'sc2_get_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Effect',
      id: 'TestRifleDamage',
    });
    expect(originalEffect.structured['rawXml']).toContain('<Amount value="5"/>');

    const reaper = await callTool(harness.client, 'sc2_get_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestReaper',
    });
    expect(reaper.structured['rawXml']).toContain('Link="TestRifle"');
  });

  it('edits a shared weapon in place when explicitly told to', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const applied = await callTool(harness.client, 'sc2_set_unit_weapon_damage', {
      workspace_id: workspaceId,
      unit_id: 'TestMarine',
      damage: '100',
      modify_shared: true,
      dry_run: false,
    });

    expect(applied.structured['clonedForIsolation']).toEqual([]);
    // The escape hatch exists, but the caller is warned about its reach.
    const diagnostics = applied.structured['diagnostics'] as { message: string }[];
    expect(diagnostics.some((entry) => entry.message.includes('every object using'))).toBe(true);
  });

  it('reports whether an object is safe to edit in place', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const shared = await callTool(harness.client, 'sc2_check_shared_object', {
      workspace_id: workspaceId,
      domain: 'Weapon',
      id: 'TestRifle',
    });
    expect(shared.structured['shared']).toBe(true);
    expect(String(shared.structured['recommendation'])).toContain('sc2_isolate_shared_object');

    const notShared = await callTool(harness.client, 'sc2_check_shared_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestMarine',
    });
    expect(notShared.structured['shared']).toBe(false);
    expect(String(notShared.structured['recommendation'])).toContain('safe');
  });

  it('does not clone an object that nothing else references', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    // Give TestReaper its own weapon so TestRifle is used by one unit only.
    await callTool(harness.client, 'sc2_patch_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: 'TestReaper',
      patches: [{ op: 'set_link', path: 'WeaponArray[0]', value: 'SomethingElse' }],
      dry_run: false,
    });

    const outcome = await callTool(harness.client, 'sc2_isolate_shared_object', {
      workspace_id: workspaceId,
      domain: 'Weapon',
      id: 'TestRifle',
      owner_domain: 'Unit',
      owner_id: 'TestMarine',
      dry_run: false,
    });

    // Cloning an unshared object would just add a near-duplicate for no benefit.
    expect(outcome.structured['isolated']).toBe(false);
    expect(outcome.structured['effectiveId']).toBe('TestRifle');
    expect(outcome.text).toContain('already safe');
  });

  it('lists workspaces so an id can be recovered after a reconnect', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const listed = await callTool(harness.client, 'sc2_list_workspaces');
    const workspaces = listed.structured['workspaces'] as { id: string }[];
    expect(workspaces.map((entry) => entry.id)).toContain(workspaceId);
  });
});
