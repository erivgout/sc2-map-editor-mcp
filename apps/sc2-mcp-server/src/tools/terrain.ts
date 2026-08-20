import { readFile } from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/server';
import {
  BINARY_TERRAIN_FILES,
  CELL_FLAGS_FILENAME,
  HEIGHT_MAP_FILENAME,
  SC2Error,
  SYNC_CLIFF_LEVEL_FILENAME,
  SYNC_HEIGHT_MAP_FILENAME,
  SYNC_TEXTURE_INFO_FILENAME,
  TERRAIN_BINARY_FILENAMES,
  TERRAIN_FILENAME,
  TEXTURE_MASKS_FILENAME,
  inspectTerrainFiles,
  parseTerrainDescriptor,
  patchTerrainBinary,
  readBinaryHeader,
  readTerrainCell,
  readTerrainVertex,
  setTerrainCellFlags,
  setTerrainCellTexture,
  setTerrainCliffCell,
  setTerrainVertexHeight,
  type ChangeResult,
  type TerrainBinaryMutationOutcome,
} from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

const WorkspaceIdSchema = z.string().min(1).describe('Workspace id returned by sc2_open_document.');
const MutationArgsShape = {
  workspace_id: WorkspaceIdSchema,
  expected_revision: z.number().int().nonnegative().optional(),
  dry_run: z.boolean().optional().describe('Defaults to TRUE. Pass false to actually write.'),
};
const TerrainComponentSchema = z.enum(TERRAIN_BINARY_FILENAMES);

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
    result.dryRun
      ? 'DRY RUN. Nothing was written. Pass dry_run=false to apply.'
      : `Applied as ${result.changeId}; workspace is now at revision ${result.revisionAfter}.`,
    ...result.summary.map((line) => `- ${line}`),
    ...result.filesChanged.map((file) => `${file.path}: ${file.beforeHash ?? '(new)'} -> ${file.afterHash ?? '(deleted)'}`),
    result.snapshotId === null ? '' : `Restore snapshot ${result.snapshotId} or use sc2_revert_change to undo it.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function registerTerrainTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger } = context;

  async function readRequired(workspaceId: string, path: string): Promise<Buffer> {
    try {
      return await readFile(await workspaces.resolveWorkingPath(workspaceId, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SC2Error('SC2_NOT_FOUND', `This document has no ${path} terrain component.`, {
          workspaceId,
          path,
          recoverable: false,
          suggestedAction: 'Use sc2_get_terrain_summary to inspect the terrain components that are present.',
        });
      }
      throw error;
    }
  }

  async function descriptorFor(workspaceId: string): Promise<{ source: string; parsed: ReturnType<typeof parseTerrainDescriptor> }> {
    const source = (await readRequired(workspaceId, TERRAIN_FILENAME)).toString('utf8');
    return { source, parsed: parseTerrainDescriptor(source) };
  }

  async function commitTerrain(
    args: { workspace_id: string; expected_revision?: number | undefined; dry_run?: boolean | undefined },
    operation: string,
    outcome: TerrainBinaryMutationOutcome,
  ): Promise<ReturnType<typeof ok>> {
    const result = await workspaces.transactions.run({
      workspaceId: args.workspace_id,
      operation,
      expectedRevision: args.expected_revision,
      dryRun: args.dry_run ?? true,
      summary: [...outcome.summary],
      diagnostics: [],
      files: outcome.files.map((file) => ({ kind: 'write' as const, path: file.path, content: file.content })),
      suppressDiffs: outcome.files.some((file) => typeof file.content !== 'string'),
    });
    return ok(describeChange(result), toStructured(result));
  }

  server.registerTool(
    'sc2_get_terrain_summary',
    {
      title: 'Summarise and validate terrain',
      description: 'Decodes the terrain descriptor and validates all rendering and synchronized terrain binary components, including dimensions and file lengths.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema }),
      outputSchema: z.object({
        descriptor: z.object({
          version: z.number(),
          width: z.number().int(),
          height: z.number().int(),
          cellWidth: z.number().int(),
          cellHeight: z.number().int(),
          cliffWidth: z.number().int(),
          cliffHeight: z.number().int(),
          offset: z.tuple([z.number(), z.number(), z.number()]),
          scale: z.tuple([z.number(), z.number(), z.number()]),
          quantizeBias: z.number(),
          quantizeScale: z.number(),
          standardHeight: z.number(),
          textureSets: z.array(z.string()),
          textures: z.array(z.string()),
          cliffCellCount: z.number().int(),
        }),
        binaryComponents: z.array(
          z.object({
            path: z.string(),
            sizeBytes: z.number().int(),
            magic: z.string().nullable(),
            magicReversed: z.string().nullable(),
            version: z.number().int().nullable(),
            known: z.boolean(),
            description: z.string().nullable(),
          }),
        ),
        issues: z.array(z.object({ severity: z.enum(['error', 'warning']), path: z.string(), message: z.string() })),
        valid: z.boolean(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_terrain_summary', logger }, async (args) => {
      const descriptor = await descriptorFor(args.workspace_id);
      const files = new Map<string, Uint8Array>();
      const binaryComponents = [];
      for (const file of await workspaces.listFiles(args.workspace_id)) {
        if (!(file.relativePath in BINARY_TERRAIN_FILES)) continue;
        const bytes = await readFile(file.absolutePath);
        files.set(file.relativePath, bytes);
        binaryComponents.push(readBinaryHeader(file.relativePath, bytes));
      }
      binaryComponents.sort((left, right) => left.path.localeCompare(right.path));
      const inspected = inspectTerrainFiles(descriptor.source, files);
      const valid = inspected.issues.every((issue) => issue.severity !== 'error');
      const structuredDescriptor = {
        version: descriptor.parsed.version,
        width: descriptor.parsed.width,
        height: descriptor.parsed.height,
        cellWidth: descriptor.parsed.width - 1,
        cellHeight: descriptor.parsed.height - 1,
        cliffWidth: Math.floor((descriptor.parsed.width - 1) / 2),
        cliffHeight: Math.floor((descriptor.parsed.height - 1) / 2),
        offset: descriptor.parsed.offset,
        scale: descriptor.parsed.scale,
        quantizeBias: descriptor.parsed.quantizeBias,
        quantizeScale: descriptor.parsed.quantizeScale,
        standardHeight: descriptor.parsed.standardHeight,
        textureSets: [...descriptor.parsed.textureSets],
        textures: [...descriptor.parsed.textures],
        cliffCellCount: descriptor.parsed.cliffCells.size,
      };
      return ok(
        [
          `Terrain ${descriptor.parsed.width}x${descriptor.parsed.height} vertices, version ${descriptor.parsed.version}.`,
          `${binaryComponents.length} binary terrain component(s) decoded; ${inspected.issues.length} issue(s).`,
          ...inspected.issues.map((issue) => `[${issue.severity}] ${issue.path}: ${issue.message}`),
        ].join('\n'),
        { descriptor: structuredDescriptor, binaryComponents, issues: [...inspected.issues], valid },
      );
    }),
  );

  server.registerTool(
    'sc2_get_terrain_vertex',
    {
      title: 'Read a terrain vertex height',
      description: 'Reads one rendering height vertex and its deterministic synchronized height, including the original uint16 fields.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema, x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }),
      outputSchema: z.object({
        x: z.number().int(),
        y: z.number().int(),
        heightBaseRaw: z.number().int(),
        heightAdjustmentRaw: z.number().int(),
        mask: z.number().int(),
        worldHeight: z.number(),
        syncHeightRaw: z.number().int(),
        syncHeight: z.number(),
        syncSecondaryRaw: z.number().int(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_terrain_vertex', logger }, async (args) => {
      const descriptor = await descriptorFor(args.workspace_id);
      const vertex = readTerrainVertex(
        descriptor.parsed,
        await readRequired(args.workspace_id, HEIGHT_MAP_FILENAME),
        await readRequired(args.workspace_id, SYNC_HEIGHT_MAP_FILENAME),
        args.x,
        args.y,
      );
      return ok(`Terrain vertex (${args.x}, ${args.y}) is ${vertex.worldHeight}; synchronized height is ${vertex.syncHeight}.`, { ...vertex });
    }),
  );

  server.registerTool(
    'sc2_set_terrain_height',
    {
      title: 'Set a terrain vertex height',
      description: 'Sets one rendering height vertex and its deterministic simulation height in the same transaction. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        world_height: z.number(),
        sync_height: z.number().optional().describe('Defaults to world_height. Use an override near deliberate cliff collision geometry.'),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_set_terrain_height', logger }, async (args) => {
      const descriptor = await descriptorFor(args.workspace_id);
      const outcome = setTerrainVertexHeight(
        descriptor.parsed,
        await readRequired(args.workspace_id, HEIGHT_MAP_FILENAME),
        await readRequired(args.workspace_id, SYNC_HEIGHT_MAP_FILENAME),
        args.x,
        args.y,
        args.world_height,
        args.sync_height,
      );
      return commitTerrain(args, 'sc2_set_terrain_height', outcome);
    }),
  );

  server.registerTool(
    'sc2_get_terrain_cell',
    {
      title: 'Read a terrain cell',
      description: 'Reads pathing flags, cliff level, eight texture blend weights, and synchronized texture assignment for one terrain cell.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema, x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }),
      outputSchema: z.object({
        x: z.number().int(),
        y: z.number().int(),
        flags: z.number().int(),
        cliffRaw: z.number().int(),
        cliffLevel: z.number().int(),
        cliffCellX: z.number().int(),
        cliffCellY: z.number().int(),
        descriptorCliff: z
          .object({ index: z.number().int(), flags: z.number().int(), cliffId: z.number().int(), variation: z.number().int() })
          .nullable(),
        textureWeights: z.array(z.number().int()).length(8),
        textureIndex: z.number().int(),
        textureField: z.number().int(),
        activeTextureSet: z.number().int(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_terrain_cell', logger }, async (args) => {
      const descriptor = await descriptorFor(args.workspace_id);
      const cell = readTerrainCell(
        descriptor.parsed,
        await readRequired(args.workspace_id, CELL_FLAGS_FILENAME),
        await readRequired(args.workspace_id, TEXTURE_MASKS_FILENAME),
        await readRequired(args.workspace_id, SYNC_CLIFF_LEVEL_FILENAME),
        await readRequired(args.workspace_id, SYNC_TEXTURE_INFO_FILENAME),
        args.x,
        args.y,
      );
      return ok(
        `Terrain cell (${args.x}, ${args.y}): flags=${cell.flags}, cliff=${cell.cliffLevel}, texture=${cell.textureIndex}, weights=[${cell.textureWeights.join(', ')}].`,
        { ...cell },
      );
    }),
  );

  server.registerTool(
    'sc2_set_terrain_cell_flags',
    {
      title: 'Set terrain pathing flags',
      description: 'Sets the raw per-cell t3CellFlags byte. Use sc2_get_terrain_cell first to preserve bits you do not intend to change. Defaults to a dry run.',
      inputSchema: z.object({ ...MutationArgsShape, x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), flags: z.number().int().min(0).max(255) }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_set_terrain_cell_flags', logger }, async (args) => {
      const descriptor = await descriptorFor(args.workspace_id);
      return commitTerrain(
        args,
        'sc2_set_terrain_cell_flags',
        setTerrainCellFlags(descriptor.parsed, await readRequired(args.workspace_id, CELL_FLAGS_FILENAME), args.x, args.y, args.flags),
      );
    }),
  );

  server.registerTool(
    'sc2_set_terrain_texture',
    {
      title: 'Paint one terrain cell',
      description: 'Writes all eight nibble blend weights across the cell mask area and updates deterministic texture assignment in the same transaction. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        weights: z.array(z.number().int().min(0).max(15)).length(8),
        texture_index: z.number().int().min(0).max(255).optional().describe('Defaults to the strongest layer in the cell active texture set.'),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_set_terrain_texture', logger }, async (args) => {
      const descriptor = await descriptorFor(args.workspace_id);
      return commitTerrain(
        args,
        'sc2_set_terrain_texture',
        setTerrainCellTexture(
          descriptor.parsed,
          await readRequired(args.workspace_id, TEXTURE_MASKS_FILENAME),
          await readRequired(args.workspace_id, SYNC_TEXTURE_INFO_FILENAME),
          args.x,
          args.y,
          args.weights,
          args.texture_index,
        ),
      );
    }),
  );

  server.registerTool(
    'sc2_set_terrain_cliff',
    {
      title: 'Set a terrain cliff cell',
      description: 'Creates, updates, or clears one half-resolution t3Terrain.xml cliff cell and updates its synchronized 2x2 terrain-cell area. Use the cliff grid dimensions from sc2_get_terrain_summary. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        x: z.number().int().nonnegative().describe('X coordinate in the half-resolution cliff grid.'),
        y: z.number().int().nonnegative().describe('Y coordinate in the half-resolution cliff grid.'),
        flags: z.number().int().min(0).max(0xffffffff),
        cliff_id: z.number().int().min(0).max(0xffff),
        variation: z.number().int().min(0).max(0xffff),
        cliff_level: z.number().int().min(0).max(15),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_set_terrain_cliff', logger }, async (args) => {
      const descriptor = await descriptorFor(args.workspace_id);
      return commitTerrain(
        args,
        'sc2_set_terrain_cliff',
        setTerrainCliffCell(descriptor.source, await readRequired(args.workspace_id, SYNC_CLIFF_LEVEL_FILENAME), args.x, args.y, {
          flags: args.flags,
          cliffId: args.cliff_id,
          variation: args.variation,
          cliffLevel: args.cliff_level,
        }),
      );
    }),
  );

  server.registerTool(
    'sc2_get_terrain_component',
    {
      title: 'Read raw terrain component bytes',
      description: 'Reads a bounded byte range from any known terrain component as base64. This covers advanced water, hard-tile, fluff, and vertex-color data without text conversion.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        component: TerrainComponentSchema,
        offset: z.number().int().nonnegative().optional(),
        length: z.number().int().min(1).max(1024 * 1024).optional(),
      }),
      outputSchema: z.object({ component: TerrainComponentSchema, sizeBytes: z.number().int(), offset: z.number().int(), length: z.number().int(), dataBase64: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_terrain_component', logger }, async (args) => {
      const bytes = await readRequired(args.workspace_id, args.component);
      const offset = args.offset ?? 0;
      const length = Math.min(args.length ?? 4096, Math.max(0, bytes.length - offset));
      if (offset > bytes.length) {
        throw new SC2Error('SC2_INVALID_ARGUMENT', `Offset ${offset} is beyond ${args.component} (${bytes.length} bytes).`, { recoverable: true });
      }
      return ok(`${args.component} bytes ${offset}..${offset + length - 1} of ${bytes.length}.`, {
        component: args.component,
        sizeBytes: bytes.length,
        offset,
        length,
        dataBase64: bytes.subarray(offset, offset + length).toString('base64'),
      });
    }),
  );

  server.registerTool(
    'sc2_patch_terrain_component',
    {
      title: 'Patch raw terrain component bytes',
      description: 'Applies a same-length base64 byte patch to a known terrain component, then runs that component\'s available validation before writing. Typed components check magic, version, dimensions, and exact length; advanced components check the documented header and versions. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        component: TerrainComponentSchema,
        offset: z.number().int().nonnegative(),
        data_base64: z.string().min(1).max(1_500_000).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Invalid base64 data.'),
        allow_header: z.boolean().optional().describe('Defaults to false. Required to patch magic or version bytes.'),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_patch_terrain_component', logger }, async (args) => {
      const descriptor = await descriptorFor(args.workspace_id);
      const replacement = Buffer.from(args.data_base64, 'base64');
      if (replacement.length === 0 || replacement.length > 1024 * 1024) {
        throw new SC2Error('SC2_INVALID_ARGUMENT', 'Decoded patch must contain 1 to 1,048,576 bytes.', { recoverable: true });
      }
      return commitTerrain(
        args,
        'sc2_patch_terrain_component',
        patchTerrainBinary(
          args.component,
          await readRequired(args.workspace_id, args.component),
          args.offset,
          replacement,
          descriptor.parsed,
          args.allow_header ?? false,
        ),
      );
    }),
  );
}
