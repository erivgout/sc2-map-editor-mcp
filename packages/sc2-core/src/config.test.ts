import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDir, writeTree, type TempDir } from '@sc2mcp/test-utils';

import { configFromObject, loadConfig } from './config.js';

describe('configFromObject', () => {
  it('applies documented defaults', () => {
    const config = configFromObject({});
    expect(config.allowedRoots).toEqual([]);
    expect(config.defaultLocale).toBe('enUS');
    // Overwriting the user's document must never be the default (PLAN.md §9).
    expect(config.allowOverwrite).toBe(false);
    expect(config.logLevel).toBe('info');
  });

  it('resolves allowed roots to absolute paths', () => {
    const config = configFromObject({ allowedRoots: ['./maps'] });
    expect(config.allowedRoots[0]).toBe(path.resolve('./maps'));
  });

  it('rejects unknown keys instead of ignoring them', () => {
    // A typo'd key that silently does nothing is how a security setting goes missing.
    expect(() => configFromObject({ allowedRoot: ['/maps'] })).toThrow();
  });

  it('rejects a non-positive limit', () => {
    expect(() => configFromObject({ maxArchiveBytes: 0 })).toThrow();
  });
});

describe('loadConfig', () => {
  let temp: TempDir;

  beforeEach(async () => {
    temp = await createTempDir('sc2mcp-config-');
  });

  afterEach(async () => {
    await temp.cleanup();
  });

  it('reads a config file and records where it came from', async () => {
    await writeTree(temp.path, {
      'config.json': JSON.stringify({ allowedRoots: [temp.path], defaultLocale: 'deDE' }),
    });
    const configPath = path.join(temp.path, 'config.json');

    const config = await loadConfig({ configPath, env: {} });
    expect(config.defaultLocale).toBe('deDE');
    expect(config.sourcePath).toBe(configPath);
  });

  it('fails loudly when an explicitly requested config file is missing', async () => {
    await expect(loadConfig({ configPath: path.join(temp.path, 'nope.json'), env: {} })).rejects.toMatchObject({
      code: 'SC2_IO_ERROR',
    });
  });

  it('reports invalid JSON as a parse error', async () => {
    await writeTree(temp.path, { 'config.json': '{ broken' });
    await expect(loadConfig({ configPath: path.join(temp.path, 'config.json'), env: {} })).rejects.toMatchObject({
      code: 'SC2_PARSE_ERROR',
    });
  });

  it('lets environment variables override the file', async () => {
    await writeTree(temp.path, {
      'config.json': JSON.stringify({ allowedRoots: ['/from-file'], defaultLocale: 'enUS' }),
    });

    const config = await loadConfig({
      configPath: path.join(temp.path, 'config.json'),
      env: {
        SC2MCP_ALLOWED_ROOTS: ['/from-env-a', '/from-env-b'].join(path.delimiter),
        SC2MCP_DEFAULT_LOCALE: 'koKR',
        SC2MCP_ALLOW_OVERWRITE: 'true',
        SC2MCP_LOG_LEVEL: 'debug',
      },
    });

    expect(config.allowedRoots).toEqual([path.resolve('/from-env-a'), path.resolve('/from-env-b')]);
    expect(config.defaultLocale).toBe('koKR');
    expect(config.allowOverwrite).toBe(true);
    expect(config.logLevel).toBe('debug');
  });

  it('rejects a malformed environment override rather than falling back silently', async () => {
    await expect(loadConfig({ configPath: undefined, env: { SC2MCP_LOG_LEVEL: 'shouty' } })).rejects.toMatchObject({
      code: 'SC2_INVALID_ARGUMENT',
    });
    await expect(
      loadConfig({ configPath: undefined, env: { SC2MCP_MAX_ARCHIVE_BYTES: 'lots' } }),
    ).rejects.toMatchObject({ code: 'SC2_INVALID_ARGUMENT' });
  });
});
