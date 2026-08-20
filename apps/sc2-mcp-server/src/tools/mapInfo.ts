import { readFile } from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/server';
import {
  ATTRIBUTES_FILENAME,
  MAP_INFO_FILENAME,
  SC2Error,
  parseMapInfo,
  setMapPlayerSlots,
  setPlayerAttributeSlots,
  type ChangeResult,
} from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

const WorkspaceIdSchema = z.string().min(1).describe('Workspace id returned by sc2_open_document.');
const PlayerSchema = z.object({
  controller: z.number().int(),
  controlType: z.number().int(),
  team: z.number().int(),
  aiName: z.string(),
  colorIndex: z.number().int(),
  startLocation: z.number().int(),
  resourceFlags: z.number().int(),
  aiPersonality: z.string(),
});
const ChangeResultSchema = z.object({
  changeId: z.string(),
  revisionBefore: z.number().int(),
  revisionAfter: z.number().int(),
  dryRun: z.boolean(),
  filesChanged: z.array(
    z.object({
      path: z.string(),
      beforeHash: z.string().nullable(),
      afterHash: z.string().nullable(),
      addedLines: z.number().int(),
      removedLines: z.number().int(),
      diff: z.string().nullable(),
    }),
  ),
  summary: z.array(z.string()),
  diagnostics: z.array(
    z.object({ severity: z.enum(['error', 'warning', 'info']), code: z.string(), message: z.string(), path: z.string().optional() }),
  ),
  requiresRepack: z.boolean(),
  snapshotId: z.string().nullable(),
});

function toStructured(result: ChangeResult): Record<string, unknown> {
  return {
    changeId: result.changeId,
    revisionBefore: result.revisionBefore,
    revisionAfter: result.revisionAfter,
    dryRun: result.dryRun,
    filesChanged: [...result.filesChanged],
    summary: [...result.summary],
    diagnostics: [...result.diagnostics],
    requiresRepack: result.requiresRepack,
    snapshotId: result.snapshotId,
  };
}

function describeChange(result: ChangeResult): string {
  return [
    result.dryRun ? 'DRY RUN. Nothing was written. Pass dry_run=false to apply.' : `Applied ${result.changeId}.`,
    ...result.summary.map((line) => `- ${line}`),
  ].join('\n');
}

export function registerMapInfoTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger } = context;

  async function readMapInfo(workspaceId: string): Promise<Buffer> {
    try {
      return await readFile(await workspaces.resolveWorkingPath(workspaceId, MAP_INFO_FILENAME));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SC2Error('SC2_NOT_FOUND', 'This document has no MapInfo component.', {
          workspaceId,
          path: MAP_INFO_FILENAME,
          recoverable: false,
        });
      }
      throw error;
    }
  }

  server.registerTool(
    'sc2_get_map_players',
    {
      title: 'Read MapInfo player slots',
      description:
        'Reads version 39 MapInfo player metadata, including human, computer, neutral, and hostile slots. This is the authoritative lobby/player configuration, separate from Galaxy runtime logic.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema }),
      outputSchema: z.object({
        version: z.number().int(),
        width: z.number().int(),
        height: z.number().int(),
        players: z.array(PlayerSchema),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_map_players', logger }, async (args) => {
      const parsed = parseMapInfo(await readMapInfo(args.workspace_id));
      return ok(
        `${parsed.players.length} MapInfo player entries: ${parsed.players.map((player) => `${player.controller}:${player.controlType}`).join(', ')}`,
        { ...parsed, players: [...parsed.players] },
      );
    }),
  );

  server.registerTool(
    'sc2_set_map_player_slots',
    {
      title: 'Set exact human player slots',
      description:
        'Sets MapInfo to an exact contiguous human range starting at player 1 and synchronizes Attributes defaults. Neutral and hostile entries are preserved. Computer entries can be removed when cleaning a template map. Supports editor MapInfo version 39 and defaults to a dry run.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        max_players: z.number().int().min(1).max(14),
        remove_computer_players: z.boolean().optional().describe('Defaults to false.'),
        expected_revision: z.number().int().nonnegative().optional(),
        dry_run: z.boolean().optional().describe('Defaults to TRUE. Pass false to apply.'),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_set_map_player_slots', logger }, async (args) => {
      const mapInfo = setMapPlayerSlots(await readMapInfo(args.workspace_id), {
        maxPlayers: args.max_players,
        ...(args.remove_computer_players === undefined ? {} : { removeComputerPlayers: args.remove_computer_players }),
      });
      const files: { kind: 'write'; path: string; content: string | Uint8Array }[] = [
        { kind: 'write', path: MAP_INFO_FILENAME, content: mapInfo.content },
      ];
      const summary = [...mapInfo.summary];
      try {
        const attributesPath = await workspaces.resolveWorkingPath(args.workspace_id, ATTRIBUTES_FILENAME);
        const attributesSource = await readFile(attributesPath, 'utf8');
        const attributes = setPlayerAttributeSlots(attributesSource, args.max_players);
        files.push({ kind: 'write', path: ATTRIBUTES_FILENAME, content: attributes.content });
        summary.push(...attributes.summary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        summary.push('Attributes component absent; MapInfo was updated alone');
      }

      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_set_map_player_slots',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary,
        diagnostics: [],
        files,
        suppressDiffs: true,
      });
      return ok(describeChange(result), toStructured(result));
    }),
  );
}
