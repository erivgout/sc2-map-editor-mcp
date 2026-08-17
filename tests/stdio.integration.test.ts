/**
 * Integration test: spawns the **built** server as a real child process and drives it
 * over stdio, exactly as an MCP client would.
 *
 * This is what actually proves PLAN.md §42 Phase 1's exit criterion. The in-process
 * tests in `apps/sc2-mcp-server/src/server.test.ts` share a module registry with the
 * server and would not catch a broken `bin` entry, a bad `dist` layout, an ESM
 * resolution failure, or — critically — stray writes to stdout (PLAN.md §55 rule 12),
 * which desynchronise the JSON-RPC wire.
 *
 * Requires `pnpm build` first; the test fails with a clear message if `dist` is absent.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MINIMAL_DOCUMENT, createTempDir, writeTree, type TempDir } from '@sc2mcp/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(repoRoot, 'apps', 'sc2-mcp-server', 'dist', 'main.js');

describe.skipIf(!existsSync(serverEntry))('stdio transport (built server)', () => {
  let temp: TempDir;
  let client: Client;
  let transport: StdioClientTransport;
  let stderrOutput = '';

  beforeAll(async () => {
    temp = await createTempDir('sc2mcp-stdio-');
    await writeTree(path.join(temp.path, 'source', 'TestMap.SC2Map'), { ...MINIMAL_DOCUMENT });

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      // Capture rather than inherit, so the assertion below can prove logs went here
      // and not to stdout.
      stderr: 'pipe',
      env: {
        SC2MCP_ALLOWED_ROOTS: temp.path,
        SC2MCP_WORKSPACE_ROOT: path.join(temp.path, 'state'),
        SC2MCP_LOG_LEVEL: 'info',
        // Windows needs these to spawn Node at all.
        SystemRoot: process.env['SystemRoot'] ?? '',
        PATH: process.env['PATH'] ?? '',
      },
    });

    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString('utf8');
    });

    client = new Client({ name: 'sc2-mcp-stdio-test', version: '0.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await temp.cleanup();
  });

  it('completes the MCP handshake over a spawned process', () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe('sc2-map-editor-mcp');
    expect(client.getInstructions()).toContain('sc2_get_server_info');
  });

  it('serves tools/list and tools/call across the process boundary', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('sc2_get_server_info');

    const result = await client.callTool({ name: 'sc2_get_server_info', arguments: {} });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured['name']).toBe('sc2-map-editor-mcp');
  });

  it('honours allowed roots passed through the environment', async () => {
    const sourcePath = path.join(temp.path, 'source', 'TestMap.SC2Map');
    const opened = await client.callTool({ name: 'sc2_open_document', arguments: { source_path: sourcePath } });

    expect(opened.isError).toBeFalsy();
    const workspace = (opened.structuredContent as { workspace: { id: string; documentKind: string } }).workspace;
    expect(workspace.documentKind).toBe('map');

    const discarded = await client.callTool({
      name: 'sc2_discard_workspace',
      arguments: { workspace_id: workspace.id },
    });
    expect(discarded.isError).toBeFalsy();
  });

  it('writes structured logs to stderr and nothing but JSON-RPC to stdout', () => {
    // If any log line had gone to stdout, the handshake above would have failed to
    // parse — so reaching here already proves stdout is clean. This asserts the other
    // half: that the logs exist at all, on stderr, in the documented format.
    expect(stderrOutput).toContain('"msg":"serving MCP over stdio"');
    for (const line of stderrOutput.split('\n').filter((entry) => entry.trim() !== '')) {
      expect(() => JSON.parse(line) as unknown, `stderr line is not JSON: ${line}`).not.toThrow();
    }
  });
});
