#!/usr/bin/env node
/**
 * Entry point.
 *
 * Two modes share one implementation (PLAN.md §52 — the CLI must call the same domain
 * services as MCP, never a parallel one):
 *
 *   - `sc2-mcp` (default) serves MCP over stdio. **stdout is the protocol wire**, so
 *     this mode writes nothing to it except JSON-RPC frames.
 *   - `sc2-mcp doctor` prints a human-readable diagnostic to stdout and exits.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createLogger, loadConfig, toErrorPayload } from '@sc2mcp/core';

import { createContext } from './context.js';
import { createMcpServer } from './server.js';
import { MCP_PROTOCOL_TARGET, SERVER_NAME, SERVER_VERSION } from './version.js';

interface ParsedArgs {
  command: 'serve' | 'doctor' | 'help' | 'version';
  configPath: string | undefined;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: ParsedArgs['command'] = 'serve';
  let configPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (arg === '--help' || arg === '-h') return { command: 'help', configPath };
    if (arg === '--version' || arg === '-V') return { command: 'version', configPath };
    if (arg === '--config' || arg === '-c') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error('--config requires a path argument.');
      }
      configPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
      continue;
    }
    if (arg === 'serve' || arg === 'doctor') {
      command = arg;
      continue;
    }
    throw new Error(`Unrecognised argument: ${arg}`);
  }

  return { command, configPath };
}

const HELP = `${SERVER_NAME} ${SERVER_VERSION} — MCP server for StarCraft II maps and mods

Usage:
  sc2-mcp [serve] [--config <path>]   Serve MCP over stdio (default).
  sc2-mcp doctor  [--config <path>]   Print a configuration and environment diagnostic.
  sc2-mcp --help | --version

Configuration is read from --config, else $SC2MCP_CONFIG, else
%LOCALAPPDATA%/sc2-map-editor-mcp/config.json. Environment variables prefixed
SC2MCP_ override the file. See docs/configuration.md.
`;

async function runDoctor(configPath: string | undefined): Promise<number> {
  const config = await loadConfig({ configPath });
  // Doctor is a human-facing CLI, not an MCP session, so logs may go to stderr freely.
  const logger = createLogger({ level: config.logLevel });
  const context = await createContext({ config, logger });

  const lines: string[] = [
    `${SERVER_NAME} ${SERVER_VERSION}`,
    `MCP protocol target: ${MCP_PROTOCOL_TARGET}`,
    `Node: ${process.versions.node} on ${process.platform}`,
    '',
    `Config file: ${config.sourcePath ?? '(none — using defaults)'}`,
    `Workspace root: ${config.workspaceRoot}`,
    `Allowed roots: ${config.allowedRoots.length === 0 ? '(none — every path-taking tool will refuse)' : ''}`,
    ...config.allowedRoots.map((root) => `  - ${root}`),
    '',
    `StarCraft II candidates: ${context.installations.length}`,
    ...context.installations.map(
      (candidate) =>
        `  - ${candidate.path} [${candidate.source}] build ${candidate.latestBuild ?? 'unknown'}${candidate.usable ? '' : ' (no editor executable)'}`,
    ),
    `Selected: ${context.selectedInstallation?.path ?? '(none)'}`,
    '',
    'Capabilities:',
    ...Object.entries(context.capabilities).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`),
  ];

  process.stdout.write(`${lines.join('\n')}\n`);

  // Non-zero exit when the server would be unable to do anything useful, so a scripted
  // health check can act on it.
  return config.allowedRoots.length === 0 ? 1 : 0;
}

async function runServe(configPath: string | undefined): Promise<void> {
  const config = await loadConfig({ configPath });
  const logger = createLogger({ level: config.logLevel, base: { server: SERVER_VERSION } });
  const context = await createContext({ config, logger });

  const handle = serveStdio(() => createMcpServer(context), {
    onerror: (error) => {
      logger.error('stdio transport error', { message: error.message });
    },
  });

  logger.info('serving MCP over stdio', { protocolTarget: MCP_PROTOCOL_TARGET });

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    void handle.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  switch (parsed.command) {
    case 'help':
      process.stdout.write(HELP);
      return;
    case 'version':
      process.stdout.write(`${SERVER_VERSION}\n`);
      return;
    case 'doctor':
      process.exitCode = await runDoctor(parsed.configPath);
      return;
    case 'serve':
      await runServe(parsed.configPath);
      return;
  }
}

main().catch((error: unknown) => {
  const payload = toErrorPayload(error);
  // Startup failures cannot use the structured logger (it may not exist yet) and must
  // not touch stdout, which may already be an MCP wire.
  process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'startup failed', ...payload })}\n`);
  process.exitCode = 1;
});
