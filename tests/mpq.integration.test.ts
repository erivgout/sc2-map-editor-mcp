/**
 * Round-trip tests against the **real** `sc2mpq` binary (PLAN.md §10).
 *
 * Skipped when the binary is absent, which is the normal case: building it needs a C++
 * toolchain and the Windows SDK. Run `scripts/bootstrap.ps1` then
 * `scripts/build-native.ps1` to enable these.
 *
 * Scope and its limits. These tests prove the machinery: that a directory packs, that
 * the archive reopens, enumerates, verifies, and extracts back to byte-identical
 * contents, and that hostile archive paths are refused. A generated fixture alone does
 * not prove SC2 compatibility. The separate real-map integration test and the manual
 * editor corpus recorded in docs/native-helper.md provide that evidence, which is why
 * `capabilities.mpq.write` is true when the helper probe passes.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MINIMAL_DOCUMENT, createTempDir, writeTree, type TempDir } from '@sc2mcp/test-utils';
import { MpqHelper, defaultHelperPaths, hashFile, walkFiles } from '@sc2mcp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const helperPath = defaultHelperPaths()[0] ?? '';

describe.skipIf(!existsSync(helperPath))('sc2mpq round trip', () => {
  let temp: TempDir;
  let helper: MpqHelper;
  let sourceDir: string;
  let archivePath: string;

  beforeAll(async () => {
    temp = await createTempDir('sc2mcp-mpq-rt-');
    sourceDir = path.join(temp.path, 'document');
    archivePath = path.join(temp.path, 'Packed.SC2Map');

    await writeTree(sourceDir, { ...MINIMAL_DOCUMENT });
    // A binary member, so the test is not only exercising text compression.
    await writeFile(path.join(sourceDir, 'Minimap.tga'), Buffer.from([0, 1, 2, 253, 254, 255, 0, 0, 42]));

    const probe = await MpqHelper.probe({ helperPath, timeoutMs: 120_000 });
    if (!probe.available) throw new Error(`helper present but unusable: ${probe.reason}`);
    helper = MpqHelper.fromProbe(probe, 120_000);
  }, 120_000);

  afterAll(async () => {
    await temp.cleanup();
  });

  it('packs a directory into a readable archive', async () => {
    const result = await helper.pack(sourceDir, archivePath, { sectorSize: 4096 });

    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(Object.keys(MINIMAL_DOCUMENT).length + 1);
    expect(existsSync(archivePath)).toBe(true);
  });

  it('reports info that can be fed back into pack', async () => {
    const info = await helper.info(archivePath);

    expect(info.sectorSize).toBe(4096);
    // A regenerated listfile is what makes the archive enumerable again.
    expect(info.hasListfile).toBe(true);
    expect(info.sizeBytes).toBeGreaterThan(0);
  });

  it('enumerates exactly the files that were packed', async () => {
    const listed = await helper.list(archivePath);

    expect(listed.listfilePresent).toBe(true);
    const paths = listed.files.map((file) => file.path).filter((file) => !file.startsWith('('));
    expect(paths.sort()).toEqual([...Object.keys(MINIMAL_DOCUMENT), 'Minimap.tga'].sort());
  });

  it('verifies every member by reading it back', async () => {
    const verified = await helper.verify(archivePath);

    expect(verified.ok).toBe(true);
    expect(verified.failures).toEqual([]);
    expect(verified.readableCount).toBe(verified.enumeratedCount);
  });

  it('extracts back to byte-identical contents', async () => {
    const destination = path.join(temp.path, 'extracted');
    const extracted = await helper.extract(archivePath, destination);

    expect(extracted.ok).toBe(true);
    expect(extracted.failures).toEqual([]);

    const original = await walkFiles(sourceDir, { maxFiles: 1000 });
    const roundTripped = await walkFiles(destination, { maxFiles: 1000 });

    // Internal MPQ bookkeeping files are regenerated on pack and deliberately not
    // extracted, so the two trees must match exactly.
    expect(roundTripped.map((file) => file.relativePath)).toEqual(original.map((file) => file.relativePath));

    for (const file of original) {
      const before = await hashFile(file.absolutePath);
      const after = await hashFile(path.join(destination, ...file.relativePath.split('/')));
      expect(after, `content changed for ${file.relativePath}`).toBe(before);
    }
  });

  it('preserves CRLF line endings exactly', async () => {
    // A "lossless" pipeline that normalises newlines is not lossless, and SC2 editor
    // output uses CRLF (PLAN.md §12).
    const extracted = await readFile(path.join(temp.path, 'extracted', 'DocumentInfo'));
    expect(extracted.includes(Buffer.from('\r\n'))).toBe(true);
  });

  it('is deterministic: packing the same input twice yields the same file list', async () => {
    const secondArchive = path.join(temp.path, 'Packed2.SC2Map');
    const first = await helper.list(archivePath);
    await helper.pack(sourceDir, secondArchive, { sectorSize: 4096 });
    const second = await helper.list(secondArchive);

    expect(second.files.map((file) => file.path)).toEqual(first.files.map((file) => file.path));
  });

  it('refuses to open something that is not an archive', async () => {
    const notAnArchive = path.join(temp.path, 'notes.txt');
    await writeFile(notAnArchive, 'plain text');

    await expect(helper.info(notAnArchive)).rejects.toMatchObject({ code: 'SC2_PACK_FAILED' });
  });

  it('refuses a source directory with nothing in it', async () => {
    const emptyDir = path.join(temp.path, 'empty');
    await writeTree(emptyDir, { 'placeholder.txt': 'x' });
    const { rm } = await import('node:fs/promises');
    await rm(path.join(emptyDir, 'placeholder.txt'));

    await expect(helper.pack(emptyDir, path.join(temp.path, 'Empty.SC2Map'))).rejects.toMatchObject({
      code: 'SC2_PACK_FAILED',
    });
  });
});
