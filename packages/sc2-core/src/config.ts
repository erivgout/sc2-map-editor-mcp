/**
 * Server configuration (PLAN.md §51).
 *
 * Resolution order, lowest priority first:
 *   1. built-in defaults
 *   2. config file (`--config <path>`, else `%LOCALAPPDATA%/sc2-map-editor-mcp/config.json`)
 *   3. environment variables (`SC2MCP_*`)
 *
 * Config is read once at startup. PLAN.md §16.A deliberately keeps mutation out of
 * MCP for v1 — a model should not be able to widen its own allowed roots.
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { SC2Error } from './errors.js';
import { LOG_LEVELS, type LogLevel } from './logging.js';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

export const ConfigFileSchema = z
  .object({
    /** Absolute directories the server may read and write under. Empty = deny everything. */
    allowedRoots: z.array(z.string().min(1)).default([]),
    /** Server-owned state directory: workspaces, snapshots, logs, cache. */
    workspaceRoot: z.string().min(1).optional(),
    /** StarCraft II installation root. `null` = autodetect. */
    sc2InstallPath: z.string().min(1).nullable().default(null),
    /** Path to the `sc2mpq` sidecar. `null` = look beside the server build. */
    mpqHelperPath: z.string().min(1).nullable().default(null),
    defaultLocale: z.string().min(2).default('enUS'),
    /** When false, `sc2_commit_document` refuses to overwrite an existing file at all. */
    allowOverwrite: z.boolean().default(false),
    maxArchiveBytes: z.number().int().positive().default(2 * GIB),
    maxExtractedFiles: z.number().int().positive().default(50_000),
    maxSingleFileBytes: z.number().int().positive().default(256 * MIB),
    /** Wall-clock ceiling for any spawned external process (sidecar, editor probe). */
    processTimeoutMs: z.number().int().positive().default(120_000),
    logLevel: z.enum(LOG_LEVELS).default('info'),
  })
  .strict();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export interface ServerConfig extends Omit<ConfigFile, 'allowedRoots' | 'workspaceRoot' | 'logLevel'> {
  readonly allowedRoots: readonly string[];
  readonly workspaceRoot: string;
  readonly logLevel: LogLevel;
  /** Where the config was loaded from, or `null` when defaults-only. For `sc2_get_server_info`. */
  readonly sourcePath: string | null;
}

/** Default server-owned state directory (PLAN.md §8). */
export function defaultWorkspaceRoot(): string {
  const localAppData = process.env['LOCALAPPDATA'];
  if (process.platform === 'win32' && localAppData !== undefined && localAppData !== '') {
    return path.join(localAppData, 'sc2-map-editor-mcp');
  }
  const xdgState = process.env['XDG_STATE_HOME'];
  if (xdgState !== undefined && xdgState !== '') {
    return path.join(xdgState, 'sc2-map-editor-mcp');
  }
  return path.join(os.homedir(), '.local', 'state', 'sc2-map-editor-mcp');
}

export function defaultConfigPath(): string {
  return path.join(defaultWorkspaceRoot(), 'config.json');
}

/** `A;B;C` on Windows, `A:B:C` elsewhere — matching the platform's own PATH convention. */
function splitPathList(value: string): string[] {
  return value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function parseIntegerEnv(name: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `${name} must be a positive integer, got: ${raw}`, {
      recoverable: true,
    });
  }
  return parsed;
}

function parseBooleanEnv(name: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new SC2Error('SC2_INVALID_ARGUMENT', `${name} must be a boolean, got: ${raw}`, { recoverable: true });
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Environment overlay, applied on top of the file layer. */
function applyEnv(base: ConfigFile, env: EnvSource): ConfigFile {
  const next: ConfigFile = { ...base };

  const roots = env['SC2MCP_ALLOWED_ROOTS'];
  if (roots !== undefined && roots.trim() !== '') next.allowedRoots = splitPathList(roots);

  const workspaceRoot = env['SC2MCP_WORKSPACE_ROOT'];
  if (workspaceRoot !== undefined && workspaceRoot.trim() !== '') next.workspaceRoot = workspaceRoot.trim();

  const installPath = env['SC2MCP_SC2_INSTALL_PATH'];
  if (installPath !== undefined && installPath.trim() !== '') next.sc2InstallPath = installPath.trim();

  const helperPath = env['SC2MCP_MPQ_HELPER_PATH'];
  if (helperPath !== undefined && helperPath.trim() !== '') next.mpqHelperPath = helperPath.trim();

  const locale = env['SC2MCP_DEFAULT_LOCALE'];
  if (locale !== undefined && locale.trim() !== '') next.defaultLocale = locale.trim();

  const allowOverwrite = env['SC2MCP_ALLOW_OVERWRITE'];
  if (allowOverwrite !== undefined && allowOverwrite.trim() !== '') {
    next.allowOverwrite = parseBooleanEnv('SC2MCP_ALLOW_OVERWRITE', allowOverwrite);
  }

  const maxArchiveBytes = env['SC2MCP_MAX_ARCHIVE_BYTES'];
  if (maxArchiveBytes !== undefined && maxArchiveBytes.trim() !== '') {
    next.maxArchiveBytes = parseIntegerEnv('SC2MCP_MAX_ARCHIVE_BYTES', maxArchiveBytes);
  }

  const maxExtractedFiles = env['SC2MCP_MAX_EXTRACTED_FILES'];
  if (maxExtractedFiles !== undefined && maxExtractedFiles.trim() !== '') {
    next.maxExtractedFiles = parseIntegerEnv('SC2MCP_MAX_EXTRACTED_FILES', maxExtractedFiles);
  }

  const maxSingleFileBytes = env['SC2MCP_MAX_SINGLE_FILE_BYTES'];
  if (maxSingleFileBytes !== undefined && maxSingleFileBytes.trim() !== '') {
    next.maxSingleFileBytes = parseIntegerEnv('SC2MCP_MAX_SINGLE_FILE_BYTES', maxSingleFileBytes);
  }

  const processTimeoutMs = env['SC2MCP_PROCESS_TIMEOUT_MS'];
  if (processTimeoutMs !== undefined && processTimeoutMs.trim() !== '') {
    next.processTimeoutMs = parseIntegerEnv('SC2MCP_PROCESS_TIMEOUT_MS', processTimeoutMs);
  }

  const logLevel = env['SC2MCP_LOG_LEVEL'];
  if (logLevel !== undefined && logLevel.trim() !== '') {
    const normalized = logLevel.trim().toLowerCase();
    if (!(LOG_LEVELS as readonly string[]).includes(normalized)) {
      throw new SC2Error(
        'SC2_INVALID_ARGUMENT',
        `SC2MCP_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got: ${logLevel}`,
        { recoverable: true },
      );
    }
    next.logLevel = normalized as LogLevel;
  }

  return next;
}

/** Turns the merged layers into the resolved, absolute-path config the server uses. */
function finalize(merged: ConfigFile, sourcePath: string | null): ServerConfig {
  const workspaceRoot = path.resolve(merged.workspaceRoot ?? defaultWorkspaceRoot());
  return {
    ...merged,
    allowedRoots: merged.allowedRoots.map((root) => path.resolve(root)),
    workspaceRoot,
    logLevel: merged.logLevel,
    sourcePath,
  };
}

export interface LoadConfigOptions {
  /** Explicit config file path (from `--config`). When set, a missing file is an error. */
  readonly configPath?: string | undefined;
  readonly env?: EnvSource;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ServerConfig> {
  const env = options.env ?? process.env;
  const explicit = options.configPath;
  const candidate = explicit ?? env['SC2MCP_CONFIG'] ?? defaultConfigPath();
  const required = explicit !== undefined || (env['SC2MCP_CONFIG'] ?? '') !== '';

  let fileLayer: unknown = {};
  let sourcePath: string | null = null;

  let raw: string | undefined;
  try {
    raw = await readFile(candidate, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' || required) {
      throw new SC2Error(
        'SC2_IO_ERROR',
        `Cannot read config file: ${candidate}`,
        { path: candidate, recoverable: true, suggestedAction: 'Create the file or omit --config to use defaults.' },
        { cause: error },
      );
    }
  }

  if (raw !== undefined) {
    try {
      fileLayer = JSON.parse(raw);
    } catch (error) {
      throw new SC2Error(
        'SC2_PARSE_ERROR',
        `Config file is not valid JSON: ${candidate}`,
        { path: candidate, recoverable: true },
        { cause: error },
      );
    }
    sourcePath = candidate;
  }

  const parsed = ConfigFileSchema.safeParse(fileLayer);
  if (!parsed.success) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `Config file is invalid: ${candidate}`, {
      path: candidate,
      recoverable: true,
      context: { issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`) },
    });
  }

  return finalize(applyEnv(parsed.data, env), sourcePath);
}

/** Builds a config directly, bypassing disk. For tests and the CLI's in-memory paths. */
export function configFromObject(input: unknown, sourcePath: string | null = null): ServerConfig {
  const parsed = ConfigFileSchema.safeParse(input);
  if (!parsed.success) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', 'Configuration is invalid.', {
      recoverable: true,
      context: { issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`) },
    });
  }
  return finalize(parsed.data, sourcePath);
}
