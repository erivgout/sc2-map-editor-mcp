/**
 * Server runtime context: the wiring between configuration and the domain services
 * that tool handlers call (PLAN.md §4).
 *
 * Built once at startup. `serveStdio` may construct a fresh `McpServer` per
 * connection era, but they all share this context — workspaces are durable on disk
 * and must not be re-derived per connection.
 */

import {
  MpqHelper,
  PathGuard,
  WorkspaceService,
  WorkspaceStore,
  createLogger,
  createMpqExtractor,
  createMpqPacker,
  deriveCapabilities,
  probeGalaxyToolkit,
  detectInstallations,
  queryRegistryInstallPaths,
  selectInstallation,
  type HelperProbe,
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
  /** Result of the startup probe for the `sc2mpq` sidecar, including why it is absent. */
  readonly mpqHelper: HelperProbe;
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
  /**
   * Skip the `sc2mpq` probe. Tests set this so their expectations do not flip depending
   * on whether the developer happens to have built the native helper.
   */
  readonly skipMpqHelperProbe?: boolean;
  /**
   * Skip the Galaxy toolkit probe. Tests set this so their capability expectations do
   * not flip depending on whether the vendored toolkit happens to be built locally.
   */
  readonly skipGalaxyToolkitProbe?: boolean;
}

export async function createContext(options: CreateContextOptions): Promise<ServerContext> {
  const { config } = options;
  const logger = options.logger ?? createLogger({ level: config.logLevel, base: { server: SERVER_VERSION } });

  const pathGuard = new PathGuard({ allowedRoots: config.allowedRoots });
  const store = new WorkspaceStore({ workspaceRoot: config.workspaceRoot, serverVersion: SERVER_VERSION });

  const mpqHelper: HelperProbe =
    options.skipMpqHelperProbe === true
      ? { available: false, reason: 'The MPQ helper probe was skipped for this context.', searched: [] }
      : await MpqHelper.probe({ helperPath: config.mpqHelperPath, timeoutMs: config.processTimeoutMs });

  if (mpqHelper.available) {
    logger.info('sc2mpq helper available', {
      path: mpqHelper.executablePath,
      version: mpqHelper.version.version,
      stormLib: mpqHelper.version.stormLib,
    });
  } else {
    // Not an error: the helper needs a C++ toolchain most users will not have. The
    // consequence — packed archives cannot be opened — is reported through the
    // capability matrix instead.
    logger.info('sc2mpq helper unavailable', { reason: mpqHelper.reason, searched: mpqHelper.searched });
  }

  const helper = mpqHelper.available ? MpqHelper.fromProbe(mpqHelper, config.processTimeoutMs) : null;

  const workspaces = new WorkspaceService({
    config,
    pathGuard,
    store,
    logger,
    mpqExtractor: helper === null ? undefined : createMpqExtractor(helper),
    mpqPacker: helper === null ? undefined : createMpqPacker(helper),
    mpqInfo: helper === null ? undefined : async (archivePath) => ({ sectorSize: (await helper.info(archivePath)).sectorSize }),
  });

  let installations: Sc2Installation[] = [];
  if (options.skipInstallationDetection !== true) {
    installations = await detectInstallations({
      configuredPath: config.sc2InstallPath,
      registryPaths: await queryRegistryInstallPaths(config.processTimeoutMs),
    });
  }
  const selectedInstallation = selectInstallation(installations);

  const toolkit =
    options.skipGalaxyToolkitProbe === true
      ? { available: false, reason: 'The Galaxy toolkit probe was skipped for this context.' }
      : await probeGalaxyToolkit();
  if (!toolkit.available) {
    // Expected on a fresh clone: the toolkit is vendored, gitignored, and separately
    // built. Galaxy capabilities report false rather than the server failing to start.
    logger.info('galaxy toolkit unavailable', { reason: toolkit.reason });
  }

  const capabilities = deriveCapabilities({
    mpqHelperAvailable: mpqHelper.available,
    editorAvailable: selectedInstallation?.editorPath != null,
    toolkitAvailable: toolkit.available,
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

  return { config, logger, pathGuard, workspaces, installations, selectedInstallation, mpqHelper, capabilities };
}
