/**
 * End-to-end MCP tests: a real {@link Client} drives a real {@link McpServer} over a
 * linked in-memory transport pair, so the protocol layer, schema validation, and tool
 * handlers are all exercised together.
 *
 * PLAN.md §42 Phase 1 exit criterion — "an MCP client can launch the server and call
 * one tool successfully" — is what `lists tools` and the `sc2_get_server_info` case
 * verify. The workspace cases cover Phase 2's exit criterion.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { configFromObject, createNullLogger } from '@sc2mcp/core';
import { MINIMAL_DOCUMENT, createTempDir, writeTree, type TempDir } from '@sc2mcp/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContext } from './context.js';
import { createMcpServer } from './server.js';

const DOCUMENT_FIXTURE = MINIMAL_DOCUMENT;

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
      'sc2_create_snapshot',
      'sc2_detect_installations',
      'sc2_diff_workspace',
      'sc2_discard_workspace',
      'sc2_find_catalog_references',
      'sc2_get_catalog_object',
      'sc2_get_changes',
      'sc2_get_dependencies',
      'sc2_get_document_info',
      'sc2_get_document_summary',
      'sc2_get_server_info',
      'sc2_list_catalog_domains',
      'sc2_list_component_types',
      'sc2_list_components',
      'sc2_list_files',
      'sc2_list_snapshots',
      'sc2_list_workspaces',
      'sc2_open_document',
      'sc2_read_file',
      'sc2_resolve_catalog_object',
      'sc2_restore_snapshot',
      'sc2_revert_change',
      'sc2_search_catalog',
      'sc2_search_files',
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

    // Restoring a snapshot discards every later change, so it is destructive; taking one
    // writes files but can never lose anything, so it is not.
    expect(byName.get('sc2_restore_snapshot')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('sc2_revert_change')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('sc2_create_snapshot')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('sc2_create_snapshot')?.annotations?.destructiveHint).toBe(false);
  });

  it('reports honest capabilities from sc2_get_server_info', async () => {
    const outcome = await callTool(harness.client, 'sc2_get_server_info');
    expect(outcome.isError).toBe(false);

    const capabilities = outcome.structured['capabilities'] as Record<string, { read: boolean; write: boolean }>;
    // Workspace staging and catalog reading work in this build...
    expect(capabilities['workspace']).toEqual({ read: true, write: true });
    expect(capabilities['gamedata']).toEqual({ read: true, write: false, inheritance: true });
    // ...and nothing that depends on an unbuilt backend claims to.
    expect(capabilities['mpq']).toEqual({ read: false, write: false });
    expect(capabilities['terrain']).toEqual({ read: false, write: false });

    expect(outcome.structured['limitations']).toEqual(expect.arrayContaining([expect.stringContaining('Packed')]));
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
      'Base.SC2Data/GameData/UnitData.xml',
      'Base.SC2Data/GameData/WeaponData.xml',
    ]);
    expect(gameData?.exists).toBe(true);

    const text = components.find((component) => component.typeCode === 'text');
    expect(text?.resolvedPaths).toEqual(['enUS.SC2Data/LocalizedData/GameStrings.txt']);

    // PLAN.md §11: never claim write support just because a component can be read.
    expect(components.every((component) => !component.writable)).toBe(true);
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
    // The model must not conclude a unit is missing merely because a dependency is unread.
    expect(dependencies.structured['resolved']).toBe(false);
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

  it('lists workspaces so an id can be recovered after a reconnect', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const listed = await callTool(harness.client, 'sc2_list_workspaces');
    const workspaces = listed.structured['workspaces'] as { id: string }[];
    expect(workspaces.map((entry) => entry.id)).toContain(workspaceId);
  });
});
