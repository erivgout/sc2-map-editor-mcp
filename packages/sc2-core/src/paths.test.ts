import { symlink } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SC2Error } from './errors.js';
import { ensureDir } from './fs/index.js';
import { createTempDir, writeTree, type TempDir } from '@sc2mcp/test-utils';

import { PathGuard, archivePathKey, isWithinRoot, normalizeArchivePath, resolveArchiveMemberPath } from './paths.js';

describe('isWithinRoot', () => {
  it('accepts the root itself and descendants', () => {
    expect(isWithinRoot('/a/b', '/a/b')).toBe(true);
    expect(isWithinRoot('/a/b', '/a/b/c/d')).toBe(true);
  });

  it('rejects a sibling whose name merely starts with the root name', () => {
    // The classic prefix-comparison bug: "/a/bc" is not inside "/a/b".
    expect(isWithinRoot('/a/b', '/a/bc')).toBe(false);
  });

  it('rejects ancestors and traversal', () => {
    expect(isWithinRoot('/a/b', '/a')).toBe(false);
    expect(isWithinRoot('/a/b', '/a/b/../../c')).toBe(false);
  });
});

describe('PathGuard', () => {
  let temp: TempDir;
  let outside: TempDir;

  beforeEach(async () => {
    temp = await createTempDir('sc2mcp-guard-');
    outside = await createTempDir('sc2mcp-outside-');
    await writeTree(temp.path, { 'doc/DocumentInfo': '<info/>' });
    await writeTree(outside.path, { 'secret.txt': 'do not read' });
  });

  afterEach(async () => {
    await temp.cleanup();
    await outside.cleanup();
  });

  it('resolves a path inside an allowed root', async () => {
    const guard = new PathGuard({ allowedRoots: [temp.path] });
    const resolved = await guard.resolve(path.join(temp.path, 'doc', 'DocumentInfo'));
    expect(resolved).toBe(path.join(temp.path, 'doc', 'DocumentInfo'));
  });

  it('denies a path outside every allowed root', async () => {
    const guard = new PathGuard({ allowedRoots: [temp.path] });
    await expect(guard.resolve(path.join(outside.path, 'secret.txt'))).rejects.toMatchObject({
      code: 'SC2_PATH_DENIED',
    });
  });

  it('denies traversal that climbs out of an allowed root', async () => {
    const guard = new PathGuard({ allowedRoots: [path.join(temp.path, 'doc')] });
    const escape = path.join(temp.path, 'doc', '..', '..', path.basename(outside.path), 'secret.txt');
    await expect(guard.resolve(escape)).rejects.toBeInstanceOf(SC2Error);
  });

  it('denies relative paths outright', async () => {
    const guard = new PathGuard({ allowedRoots: [temp.path] });
    await expect(guard.resolve('doc/DocumentInfo')).rejects.toMatchObject({ code: 'SC2_PATH_DENIED' });
  });

  it('denies everything when no roots are configured', async () => {
    const guard = new PathGuard({ allowedRoots: [] });
    await expect(guard.resolve(path.join(temp.path, 'doc'))).rejects.toMatchObject({ code: 'SC2_PATH_DENIED' });
  });

  it('reports a missing path as SC2_NOT_FOUND, not as a denial', async () => {
    const guard = new PathGuard({ allowedRoots: [temp.path] });
    await expect(guard.resolve(path.join(temp.path, 'nope'))).rejects.toMatchObject({ code: 'SC2_NOT_FOUND' });
  });

  it('allows a not-yet-existing path in may-create mode', async () => {
    const guard = new PathGuard({ allowedRoots: [temp.path] });
    const target = path.join(temp.path, 'out', 'New.SC2Map');
    await expect(guard.resolveForCreate(target)).resolves.toBe(target);
  });

  it('denies traversal hidden in the not-yet-existing remainder', async () => {
    const guard = new PathGuard({ allowedRoots: [path.join(temp.path, 'doc')] });
    await expect(guard.resolveForCreate(path.join(temp.path, 'doc', 'missing', '..', '..', 'escaped.txt'))).rejects.toMatchObject({
      code: 'SC2_PATH_DENIED',
    });
  });

  it('follows symlinks when canonicalising, so a link out of the root is denied', async () => {
    const guard = new PathGuard({ allowedRoots: [temp.path] });
    const link = path.join(temp.path, 'escape-link');

    try {
      await symlink(outside.path, link, 'dir');
    } catch (error) {
      // Windows needs Developer Mode or elevation to create symlinks. Skipping is
      // honest; asserting nothing would silently drop the check.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    await expect(guard.resolve(path.join(link, 'secret.txt'))).rejects.toMatchObject({ code: 'SC2_PATH_DENIED' });
  });

  it('accepts a symlink that stays inside the root', async () => {
    const guard = new PathGuard({ allowedRoots: [temp.path] });
    await ensureDir(path.join(temp.path, 'real'));
    const link = path.join(temp.path, 'inner-link');

    try {
      await symlink(path.join(temp.path, 'real'), link, 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    await expect(guard.resolve(link)).resolves.toBe(path.join(temp.path, 'real'));
  });
});

describe('normalizeArchivePath', () => {
  it('converts backslashes and collapses redundant segments', () => {
    expect(normalizeArchivePath('Base.SC2Data\\GameData\\UnitData.xml')).toBe('Base.SC2Data/GameData/UnitData.xml');
    expect(normalizeArchivePath('a//b/./c')).toBe('a/b/c');
  });

  it('rejects traversal, absolute paths, and drive letters', () => {
    for (const bad of ['../escape', 'a/../../b', '/absolute', 'C:\\Windows\\System32']) {
      expect(() => normalizeArchivePath(bad)).toThrow(SC2Error);
    }
  });

  it('rejects NUL bytes and empty input', () => {
    expect(() => normalizeArchivePath('a\u0000b')).toThrow(SC2Error);
    expect(() => normalizeArchivePath('')).toThrow(SC2Error);
    expect(() => normalizeArchivePath('///')).toThrow(SC2Error);
  });

  it('keys are case-insensitive, matching SC2 archive semantics', () => {
    expect(archivePathKey('Base.SC2Data/GameData/UnitData.xml')).toBe(archivePathKey('BASE.SC2DATA\\gamedata\\unitdata.XML'));
  });
});

describe('resolveArchiveMemberPath', () => {
  it('maps a member under the destination', () => {
    const target = resolveArchiveMemberPath('/dest', 'Base.SC2Data/GameData/UnitData.xml');
    expect(target).toBe(path.resolve('/dest', 'Base.SC2Data', 'GameData', 'UnitData.xml'));
  });

  it('refuses a member that would land outside the destination', () => {
    expect(() => resolveArchiveMemberPath('/dest', '..\\..\\evil.dll')).toThrow(SC2Error);
  });
});
