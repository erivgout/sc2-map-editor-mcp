/**
 * MCP server assembly (PLAN.md §14).
 *
 * The factory shape matters: `serveStdio` may build one server instance per
 * protocol era, so registration must be side-effect-free and repeatable. All durable
 * state lives in the {@link ServerContext}, which is created once and shared.
 */

import { McpServer } from '@modelcontextprotocol/server';

import type { ServerContext } from './context.js';
import { registerAuthoringTools } from './tools/authoring.js';
import { registerCatalogTools } from './tools/catalog.js';
import { registerCatalogMutationTools } from './tools/catalogMutation.js';
import { registerChangeTools } from './tools/changes.js';
import { registerComponentTools } from './tools/components.js';
import { registerEditorTools } from './tools/editor.js';
import { registerEnvironmentTools } from './tools/environment.js';
import { registerGalaxyTools } from './tools/galaxy.js';
import { registerTextTools } from './tools/text.js';
import { registerValidationTools } from './tools/validation.js';
import { registerWorkspaceTools } from './tools/workspace.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

const INSTRUCTIONS = [
  'This server edits StarCraft II maps and mods through their file contents, not through the Galaxy Editor UI.',
  '',
  'Start with sc2_get_server_info. Its "capabilities" matrix and "limitations" list state exactly which subsystems work in this build; do not assume a subsystem exists because a map contains that kind of data.',
  '',
  'Editing model: sc2_open_document copies the document into a server-owned staging tree and returns a workspace_id. The original file or directory is never modified. Every later call takes that workspace_id, and edits apply only to the staging copy until an explicit commit writes a new document.',
].join('\n');

export function createMcpServer(context: ServerContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
    },
  );

  registerEnvironmentTools(server, context);
  registerWorkspaceTools(server, context);
  registerComponentTools(server, context);
  registerCatalogTools(server, context);
  registerCatalogMutationTools(server, context);
  registerChangeTools(server, context);
  registerTextTools(server, context);
  registerValidationTools(server, context);
  registerEditorTools(server, context);
  registerAuthoringTools(server, context);
  registerGalaxyTools(server, context);

  return server;
}
