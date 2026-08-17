/**
 * Server runtime context: the wiring between configuration and the domain services
 * that tool handlers call (PLAN.md §4).
 *
 * Built once at startup. `serveStdio` may construct a fresh `McpServer` per
 * connection era, but they all share this context — workspaces are durable on disk
 * and must not be re-derived per connection.
 */

import {
  PathGuard,
  WorkspaceService,
  WorkspaceStore,
  createLogger,
  deriveCapabilities,
  detectInstallations,
  queryRegistryInstallPaths,
  selectInstallation,
  type Logger,
  type Sc2Installation,
  type ServerCapabilities,
  type ServerConfig,
} from '@sc2mcp/core';

import { SERVER_VERSION } from './version.js';

export interface ServerContext {
  readonly config: ServerConfig;
  readonly logger: Logger;
  readonly pathGuard: PathGuard;
  readonly workspaces: WorkspaceService;
  /** Installations found at startup. Re-probed by `sc2_detect_installations`. */
  readonly installations: readonly Sc2Installation[];
  /** The unambiguous installation, or `null` when absent or ambiguous. */
  readonly selectedInstallation: Sc2Installation | null;
  readonly capabilities: ServerCapabilities;
}

export interface CreateContextOptions {
  readonly config: ServerConfig;
  /** Override for tests. */
  readonly logger?: Logger;
  /**
   * Skip the registry query and known-location probe. Tests set this so they neither
   * spawn `reg.exe` nor depend on whether the dev machine has SC2 installed.
   */
  readonly skipInstallationDetection?: boolean;
}

export async function createContext(options: CreateContextOptions): Promise<ServerContext> {
  const { config } = options;
  const logger = options.logger ?? createLogger({ level: config.logLevel, base: { server: SERVER_VERSION } });

  const pathGuard = new PathGuard({ allowedRoots: config.allowedRoots });
  const store = new WorkspaceStore({ workspaceRoot: config.workspaceRoot, serverVersion: SERVER_VERSION });
  const workspaces = new WorkspaceService({ config, pathGuard, store, logger });

  let installations: Sc2Installation[] = [];
  if (options.skipInstallationDetection !== true) {
    installations = await detectInstallations({
      configuredPath: config.sc2InstallPath,
      registryPaths: await queryRegistryInstallPaths(config.processTimeoutMs),
    });
  }
  const selectedInstallation = selectInstallation(installations);

  const capabilities = deriveCapabilities({
    // Phase 3 has not landed; there is no sidecar to probe yet.
    mpqHelperAvailable: false,
    editorAvailable: selectedInstallation?.editorPath != null,
    // Phase 5 has not landed; the toolkit adapter does not exist yet.
    toolkitAvailable: false,
  });

  if (config.allowedRoots.length === 0) {
    logger.warn('no allowed roots configured; every path-taking tool will refuse', {
      configPath: config.sourcePath,
      suggestion: 'Set "allowedRoots" in the config file or SC2MCP_ALLOWED_ROOTS.',
    });
  }

  logger.info('server context ready', {
    workspaceRoot: config.workspaceRoot,
    allowedRootCount: config.allowedRoots.length,
    installationsFound: installations.length,
    selectedInstallation: selectedInstallation?.path ?? null,
  });

  return { config, logger, pathGuard, workspaces, installations, selectedInstallation, capabilities };
}
