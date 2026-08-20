/**
 * Environment and installation tools (PLAN.md §16.A).
 *
 * Both are strictly read-only: they inspect this process and the local machine and
 * never create or modify anything, so `readOnlyHint` is honest here.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { detectInstallations, queryRegistryInstallPaths, selectInstallation } from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';
import {
  MCP_PROTOCOL_TARGET,
  MPQ_HELPER_PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  WORKSPACE_STATE_SCHEMA_VERSION,
} from '../version.js';

const ReadWriteSchema = z.object({ read: z.boolean(), write: z.boolean() });

const CapabilitiesSchema = z.object({
  workspace: ReadWriteSchema,
  mpq: ReadWriteSchema,
  gamedata: ReadWriteSchema.extend({ inheritance: z.boolean() }),
  galaxy: ReadWriteSchema.extend({ typecheck: z.boolean() }),
  triggers: ReadWriteSchema,
  localization: ReadWriteSchema,
  layout: ReadWriteSchema,
  objects: ReadWriteSchema,
  terrain: ReadWriteSchema,
  editorLaunch: z.boolean(),
  runtimeSmokeTest: z.boolean(),
});

const ServerInfoOutputSchema = z.object({
  name: z.string(),
  version: z.string(),
  mcpProtocolTarget: z.string(),
  versions: z.object({
    workspaceStateSchema: z.number().int(),
    mpqHelperProtocol: z.number().int(),
    /** `null` until the vendored toolkit is wired in (Phase 5). */
    galaxyToolkitCommit: z.string().nullable(),
    /** `null` until the sidecar exists and answers a version probe (Phase 3). */
    mpqHelperVersion: z.string().nullable(),
    node: z.string(),
  }),
  configuration: z.object({
    configPath: z.string().nullable(),
    allowedRoots: z.array(z.string()),
    workspaceRoot: z.string(),
    defaultLocale: z.string(),
    allowOverwrite: z.boolean(),
  }),
  installation: z
    .object({
      path: z.string(),
      editorPath: z.string().nullable(),
      gameExecutablePath: z.string().nullable(),
      switcherPath: z.string().nullable(),
      latestBuild: z.number().int().nullable(),
      source: z.string(),
    })
    .nullable(),
  capabilities: CapabilitiesSchema,
  /** Plain-language notes about what this build cannot do yet. */
  limitations: z.array(z.string()),
});

const InstallationSchema = z.object({
  path: z.string(),
  source: z.string(),
  editorPath: z.string().nullable(),
  gameExecutablePath: z.string().nullable(),
  switcherPath: z.string().nullable(),
  latestBuild: z.number().int().nullable(),
  usable: z.boolean(),
});

const DetectInstallationsOutputSchema = z.object({
  installations: z.array(InstallationSchema),
  /** The unambiguous choice, or `null` when there is none — never a silent guess. */
  selected: InstallationSchema.nullable(),
  ambiguous: z.boolean(),
});

/** Human-readable gaps, derived from the capability matrix rather than hand-maintained. */
function limitationsFor(context: ServerContext): string[] {
  const notes: string[] = [];
  const { capabilities } = context;
  if (!capabilities.mpq.read) {
    notes.push(
      `Packed .SC2Map/.SC2Mod archives cannot be opened; only unpacked document directories are supported. ${
        context.mpqHelper.available ? '' : context.mpqHelper.reason
      }`.trim(),
    );
  }
  if (capabilities.mpq.read && !capabilities.mpq.write) {
    notes.push(
      'Packed archives can be read but not written: repacking is not advertised until multiple editor-authored maps have survived an extract/repack/reopen round trip.',
    );
  }
  if (!capabilities.gamedata.read) {
    notes.push('GameData catalogs are not parsed yet; there are no catalog search or edit tools.');
  }
  if (!capabilities.galaxy.read) {
    notes.push('Galaxy scripts are not parsed yet; there are no symbol or diagnostic tools.');
  }
  if (!capabilities.galaxy.typecheck) {
    notes.push(
      'Galaxy diagnostics are syntax-only; type checking is unavailable because the game native declarations are not loaded.',
    );
  }
  if (!capabilities.triggers.read) {
    notes.push('Trigger data is not parsed in this build.');
  } else if (!capabilities.triggers.write) {
    notes.push(
      'Trigger structure is read-only. Display names can be renamed safely, but actions, events, conditions, and graph nodes cannot be created or rewired.',
    );
  }
  if (!capabilities.layout.read) {
    notes.push('SC2Layout files are not parsed or editable in this build.');
  } else if (!capabilities.layout.write) {
    notes.push('SC2Layout files can be inspected but not edited in this build.');
  }
  if (!capabilities.objects.read) {
    notes.push('Placed objects and regions are not parsed in this build.');
  } else if (!capabilities.objects.write) {
    notes.push('Placed objects and regions can be inspected but not edited in this build.');
  }
  if (!capabilities.terrain.read) {
    notes.push('Terrain data is not parsed in this build.');
  } else if (!capabilities.terrain.write) {
    notes.push(
      'Terrain support is inspection-only: the descriptor and binary headers are reported, but height, texture, pathing, cliff, and water data cannot be edited.',
    );
  }
  if (!capabilities.editorLaunch) {
    notes.push(
      context.selectedInstallation === null
        ? 'No unambiguous StarCraft II installation was detected, so editor integration is unavailable.'
        : 'Editor launching is not implemented in this build.',
    );
  }
  if (!capabilities.runtimeSmokeTest) {
    notes.push(
      'Automated in-game testing is unavailable because the selected installation does not provide both SC2Switcher and a current game executable.',
    );
  }
  return notes;
}

export function registerEnvironmentTools(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'sc2_get_server_info',
    {
      title: 'Get SC2 MCP server info',
      description:
        'Reports this server\'s version, the MCP revision it targets, component versions, effective configuration, the detected StarCraft II installation, and a capability matrix. Read this first: the capability matrix states which subsystems are actually usable in this build, and "limitations" explains the gaps in plain language.',
      inputSchema: z.object({}),
      outputSchema: ServerInfoOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_server_info', logger: context.logger }, () => {
      const installation = context.selectedInstallation;
      const structured = {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        mcpProtocolTarget: MCP_PROTOCOL_TARGET,
        versions: {
          workspaceStateSchema: WORKSPACE_STATE_SCHEMA_VERSION,
          mpqHelperProtocol: MPQ_HELPER_PROTOCOL_VERSION,
          galaxyToolkitCommit: null,
          mpqHelperVersion: context.mpqHelper.available ? context.mpqHelper.version.version : null,
          node: process.versions.node,
        },
        configuration: {
          configPath: context.config.sourcePath,
          allowedRoots: [...context.config.allowedRoots],
          workspaceRoot: context.config.workspaceRoot,
          defaultLocale: context.config.defaultLocale,
          allowOverwrite: context.config.allowOverwrite,
        },
        installation:
          installation === null
            ? null
            : {
                path: installation.path,
                editorPath: installation.editorPath,
                gameExecutablePath: installation.gameExecutablePath,
                switcherPath: installation.switcherPath,
                latestBuild: installation.latestBuild,
                source: installation.source,
              },
        capabilities: context.capabilities,
        limitations: limitationsFor(context),
      };

      const summary = [
        `${SERVER_NAME} ${SERVER_VERSION} (MCP ${MCP_PROTOCOL_TARGET}, Node ${process.versions.node})`,
        `allowed roots: ${context.config.allowedRoots.length === 0 ? '(none configured — all paths denied)' : context.config.allowedRoots.join(', ')}`,
        `StarCraft II: ${installation === null ? 'not detected' : `${installation.path} (build ${installation.latestBuild ?? 'unknown'})`}`,
        ...structured.limitations.map((note) => `- ${note}`),
      ].join('\n');

      return ok(summary, structured);
    }),
  );

  server.registerTool(
    'sc2_detect_installations',
    {
      title: 'Detect StarCraft II installations',
      description:
        'Searches configured paths, the SC2MCP_SC2_INSTALL_PATH/SC2PATH environment variables, the Windows registry, and a short list of conservative default locations. Does not scan the disk. Returns every candidate; "selected" is non-null only when the choice is unambiguous.',
      inputSchema: z.object({}),
      outputSchema: DetectInstallationsOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_detect_installations', logger: context.logger }, async () => {
      const installations = await detectInstallations({
        configuredPath: context.config.sc2InstallPath,
        registryPaths: await queryRegistryInstallPaths(context.config.processTimeoutMs),
      });
      const selected = selectInstallation(installations);
      const usableCount = installations.filter((candidate) => candidate.usable).length;

      const structured = {
        installations: installations.map((candidate) => ({
          path: candidate.path,
          source: candidate.source,
          editorPath: candidate.editorPath,
          gameExecutablePath: candidate.gameExecutablePath,
          switcherPath: candidate.switcherPath,
          latestBuild: candidate.latestBuild,
          usable: candidate.usable,
        })),
        selected:
          selected === null
            ? null
            : {
                path: selected.path,
                source: selected.source,
                editorPath: selected.editorPath,
                gameExecutablePath: selected.gameExecutablePath,
                switcherPath: selected.switcherPath,
                latestBuild: selected.latestBuild,
                usable: selected.usable,
              },
        ambiguous: selected === null && usableCount > 1,
      };

      const summary =
        installations.length === 0
          ? 'No StarCraft II installation found in any conservative location. Set "sc2InstallPath" in the config, or SC2MCP_SC2_INSTALL_PATH.'
          : [
              `Found ${installations.length} candidate installation(s), ${usableCount} usable:`,
              ...installations.map(
                (candidate) =>
                  `- ${candidate.path} [${candidate.source}] build ${candidate.latestBuild ?? 'unknown'}${candidate.usable ? '' : ' (no editor executable)'}`,
              ),
              structured.ambiguous
                ? 'Several usable installations exist; set "sc2InstallPath" to choose one.'
                : `Selected: ${selected?.path ?? 'none'}`,
            ].join('\n');

      return ok(summary, structured);
    }),
  );
}
