/**
 * End-to-end MCP tests: a real {@link Client} drives a real {@link McpServer} over a
 * linked in-memory transport pair, so the protocol layer, schema validation, and tool
 * handlers are all exercised together.
 *
 * PLAN.md §42 Phase 1 exit criterion — "an MCP client can launch the server and call
 * one tool successfully" — is what `lists tools` and the `sc2_get_server_info` case
 * verify. The workspace cases cover Phase 2's exit criterion.
 */

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
    // Keep the test independent of whether this machine has StarCraft II installed.
    skipInstallationDetection: true,
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
      'sc2_detect_installations',
      'sc2_discard_workspace',
      'sc2_get_document_summary',
      'sc2_get_server_info',
      'sc2_list_files',
      'sc2_list_workspaces',
      'sc2_open_document',
      'sc2_read_file',
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
  });

  it('reports honest capabilities from sc2_get_server_info', async () => {
    const outcome = await callTool(harness.client, 'sc2_get_server_info');
    expect(outcome.isError).toBe(false);

    const capabilities = outcome.structured['capabilities'] as Record<string, { read: boolean; write: boolean }>;
    // Workspace staging works in this build...
    expect(capabilities['workspace']).toEqual({ read: true, write: true });
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
    expect(summary.structured['notYetImplemented']).toEqual(expect.arrayContaining(['components']));

    const listed = await callTool(harness.client, 'sc2_list_files', {
      workspace_id: workspaceId,
      path_prefix: 'Base.SC2Data',
    });
    const files = listed.structured['files'] as { path: string }[];
    expect(files.map((file) => file.path).sort()).toEqual(['Base.SC2Data/GameData/UnitData.xml', 'Base.SC2Data/LibTest.galaxy']);

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
    expect(matches.map((match) => match.path).sort()).toEqual([
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

  it('lists workspaces so an id can be recovered after a reconnect', async () => {
    const opened = await callTool(harness.client, 'sc2_open_document', { source_path: harness.sourceDir });
    const workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const listed = await callTool(harness.client, 'sc2_list_workspaces');
    const workspaces = listed.structured['workspaces'] as { id: string }[];
    expect(workspaces.map((entry) => entry.id)).toContain(workspaceId);
  });
});
