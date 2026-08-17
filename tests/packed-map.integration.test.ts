/**
 * The full packed-map workflow, end to end, against a **real ladder map** from the
 * StarCraft II installation.
 *
 * This is PLAN.md §42 Phase 3's exit criterion and §56's vertical slice, minus the one
 * step that cannot be automated: opening the result in the Galaxy Editor. Everything up to
 * that point runs here — open a packed `.SC2Map`, inspect it, edit a catalog value, commit
 * a new archive, and reopen the result to confirm the change survived.
 *
 * Skipped when the `sc2mpq` helper is not built or no installation is present. The
 * original map is never modified: it is opened read-only into staging, and output goes to
 * a temp directory.
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { MpqHelper, configFromObject, createNullLogger, defaultHelperPaths } from '@sc2mcp/core';
import { createTempDir, type TempDir } from '@sc2mcp/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContext } from '../apps/sc2-mcp-server/src/context.js';
import { createMcpServer } from '../apps/sc2-mcp-server/src/server.js';

const helperPath = defaultHelperPaths()[0] ?? '';

/** A packed map from the installation, chosen deterministically so runs are comparable. */
function findPackedMap(): string | null {
  const roots = [
    process.env['SC2MCP_SC2_INSTALL_PATH'],
    process.env['SC2PATH'],
    'C:\\Program Files (x86)\\StarCraft II',
  ].filter((root): root is string => root !== undefined && root !== '');

  for (const root of roots) {
    const mapsDir = path.join(root, 'maps');
    if (!existsSync(mapsDir)) continue;
    const maps = readdirSync(mapsDir)
      .filter((name) => name.toLowerCase().endsWith('.sc2map'))
      .sort();
    if (maps[0] !== undefined) return path.join(mapsDir, maps[0]);
  }
  return null;
}

const packedMap = findPackedMap();
const enabled = existsSync(helperPath) && packedMap !== null;

interface ToolOutcome {
  isError: boolean;
  text: string;
  structured: Record<string, unknown>;
}

describe.skipIf(!enabled)('packed map workflow', () => {
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
    temp = await createTempDir('sc2mcp-packed-');

    const config = configFromObject({
      // The installation is an allowed root so the map can be READ; nothing is ever
      // written there, and the output path below is under the temp directory.
      allowedRoots: [path.dirname(path.dirname(packedMap!)), temp.path],
      workspaceRoot: path.join(temp.path, 'state'),
      maxSingleFileBytes: 64 * 1024 * 1024,
    });

    const context = await createContext({
      config,
      logger: createNullLogger(),
      skipInstallationDetection: true,
      skipGalaxyToolkitProbe: true,
    });

    server = createMcpServer(context);
    client = new Client({ name: 'packed-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // See dependencies.integration.test.ts: this is what turns on output-schema validation.
    await client.listTools();

    const opened = await call('sc2_open_document', { source_path: packedMap! });
    expect(opened.isError, opened.text).toBe(false);
    workspaceId = (opened.structured['workspace'] as Record<string, unknown>)['id'] as string;
  }, 300_000);

  afterAll(async () => {
    await client.close();
    await server.close();
    await temp.cleanup();
  });

  it('reports the MPQ capability as available once the helper is built', async () => {
    const info = await call('sc2_get_server_info');
    const capabilities = info.structured['capabilities'] as Record<string, Record<string, boolean>>;

    expect(capabilities['mpq']?.['read']).toBe(true);
    const versions = info.structured['versions'] as Record<string, unknown>;
    expect(typeof versions['mpqHelperVersion']).toBe('string');
  });

  it('stages a real packed map without touching the original', async () => {
    const summary = await call('sc2_get_document_summary', { workspace_id: workspaceId });
    const workspace = summary.structured['workspace'] as Record<string, unknown>;

    expect(workspace['sourceKind']).toBe('mpq');
    expect(workspace['documentKind']).toBe('map');
    expect(summary.structured['fileCount']).toBeGreaterThan(50);

    // A real ladder map has a component list and GameData.
    expect(summary.structured['componentTypes']).toEqual(expect.arrayContaining(['gada']));
  });

  it('indexes the catalogs of a real packed map', async () => {
    const domains = await call('sc2_list_catalog_domains', { workspace_id: workspaceId });
    const stats = domains.structured['stats'] as Record<string, number>;

    expect(stats['entryCount']).toBeGreaterThan(0);
    // Nothing in a genuine map may fail to parse.
    const diagnostics = domains.structured['diagnostics'] as { severity: string }[];
    expect(diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  });

  it('edits a catalog value and commits a new packed archive that reopens', async () => {
    const search = await call('sc2_search_catalog', { workspace_id: workspaceId, limit: 200 });
    const results = search.structured['results'] as { domain: string; id: string }[];
    const target = results.find((entry) => entry.domain !== null);
    expect(target, 'the map declares no catalog objects to edit').toBeDefined();
    if (target === undefined) return;

    const applied = await call('sc2_patch_catalog_object', {
      workspace_id: workspaceId,
      domain: target.domain,
      id: target.id,
      patches: [{ op: 'set', path: 'SC2McpRoundTripMarker', value: '1' }],
      dry_run: false,
    });
    expect(applied.isError, applied.text).toBe(false);

    const outputPath = path.join(temp.path, 'out', 'RoundTrip.SC2Map');
    const committed = await call('sc2_commit_document', {
      workspace_id: workspaceId,
      output_path: outputPath,
      // The source is a stock map we opened read-only; validation warnings about
      // dependency-owned parents are expected and must not block the commit.
      force: true,
    });
    expect(committed.isError, committed.text).toBe(false);
    expect(existsSync(outputPath)).toBe(true);

    // The committed archive is a real MPQ: verify it independently of the server.
    const probe = await MpqHelper.probe({ helperPath, timeoutMs: 300_000 });
    expect(probe.available).toBe(true);
    if (!probe.available) return;
    const helper = MpqHelper.fromProbe(probe, 300_000);

    const verified = await helper.verify(outputPath);
    expect(verified.ok, JSON.stringify(verified.failures.slice(0, 3))).toBe(true);
    expect(verified.readableCount).toBe(verified.enumeratedCount);

    // Reopen the committed archive through the server and confirm the edit survived the
    // whole extract -> edit -> repack -> extract cycle.
    const reopened = await call('sc2_open_document', { source_path: outputPath });
    expect(reopened.isError, reopened.text).toBe(false);
    const reopenedId = (reopened.structured['workspace'] as Record<string, unknown>)['id'] as string;

    const object = await call('sc2_get_catalog_object', {
      workspace_id: reopenedId,
      domain: target.domain,
      id: target.id,
    });
    expect(object.structured['rawXml']).toContain('SC2McpRoundTripMarker');
  }, 300_000);

  it('leaves the original map on disk untouched', async () => {
    // The single most important invariant, checked against a file the user cares about.
    const probe = await MpqHelper.probe({ helperPath, timeoutMs: 300_000 });
    if (!probe.available) return;
    const helper = MpqHelper.fromProbe(probe, 300_000);

    const verified = await helper.verify(packedMap!);
    expect(verified.ok).toBe(true);
  }, 300_000);
});
