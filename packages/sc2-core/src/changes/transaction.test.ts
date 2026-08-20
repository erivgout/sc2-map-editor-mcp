import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MINIMAL_DOCUMENT, createTempDir, writeTree, type TempDir } from '@sc2mcp/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configFromObject } from '../config.js';
import { createNullLogger } from '../logging.js';
import { PathGuard } from '../paths.js';
import { WorkspaceService } from '../workspace/service.js';
import { WorkspaceStore } from '../workspace/store.js';
import { TransactionEngine } from './transaction.js';

interface Harness {
  temp: TempDir;
  service: WorkspaceService;
  store: WorkspaceStore;
  engine: TransactionEngine;
  workspaceId: string;
  workingPath: string;
}

async function createHarness(options: { readOnly?: boolean } = {}): Promise<Harness> {
  const temp = await createTempDir('sc2mcp-txn-');
  const sourceDir = path.join(temp.path, 'source', 'TestMap.SC2Map');
  await writeTree(sourceDir, { ...MINIMAL_DOCUMENT });

  const config = configFromObject({ allowedRoots: [temp.path], workspaceRoot: path.join(temp.path, 'state') });
  const store = new WorkspaceStore({ workspaceRoot: config.workspaceRoot, serverVersion: '0.0.0-test' });
  const service = new WorkspaceService({
    config,
    pathGuard: new PathGuard({ allowedRoots: config.allowedRoots }),
    store,
    logger: createNullLogger(),
  });

  const opened = await service.openDocument({ sourcePath: sourceDir, readOnly: options.readOnly ?? false });

  return {
    temp,
    service,
    store,
    engine: service.transactions,
    workspaceId: opened.workspace.id,
    workingPath: opened.workspace.stagingPath,
  };
}

const DOCUMENT_INFO_PATH = 'DocumentInfo';

describe('TransactionEngine.run', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.temp.cleanup();
  });

  it('writes nothing on a dry run but still produces the diff', async () => {
    const before = await readFile(path.join(harness.workingPath, DOCUMENT_INFO_PATH), 'utf8');

    const result = await harness.engine.run({
      workspaceId: harness.workspaceId,
      operation: 'test',
      dryRun: true,
      summary: ['set the name'],
      files: [{ kind: 'write', path: DOCUMENT_INFO_PATH, content: 'CHANGED' }],
    });

    expect(result.dryRun).toBe(true);
    expect(result.filesChanged).toHaveLength(1);
    expect(result.filesChanged[0]?.diff).toContain('+CHANGED');
    // Revision does not move, and the file is untouched.
    expect(result.revisionAfter).toBe(result.revisionBefore);
    expect(result.snapshotId).toBeNull();
    await expect(readFile(path.join(harness.workingPath, DOCUMENT_INFO_PATH), 'utf8')).resolves.toBe(before);
  });

  it('applies the change and bumps the revision exactly once', async () => {
    const result = await harness.engine.run({
      workspaceId: harness.workspaceId,
      operation: 'test',
      dryRun: false,
      summary: ['set the name'],
      files: [{ kind: 'write', path: DOCUMENT_INFO_PATH, content: 'CHANGED' }],
    });

    expect(result.dryRun).toBe(false);
    expect(result.revisionAfter).toBe(result.revisionBefore + 1);
    expect(result.requiresRepack).toBe(true);
    await expect(readFile(path.join(harness.workingPath, DOCUMENT_INFO_PATH), 'utf8')).resolves.toBe('CHANGED');

    const state = await harness.store.read(harness.workspaceId);
    expect(state.revision).toBe(result.revisionAfter);
    expect(state.dirty).toBe(true);
  });

  it('produces the same diff on the dry run as on the real run', async () => {
    const shared = {
      workspaceId: harness.workspaceId,
      operation: 'test',
      summary: ['edit'],
      files: [{ kind: 'write' as const, path: DOCUMENT_INFO_PATH, content: 'CHANGED' }],
    };

    const preview = await harness.engine.run({ ...shared, dryRun: true });
    const applied = await harness.engine.run({ ...shared, dryRun: false });

    // The preview a caller approves must be produced by the same code path as the write.
    expect(applied.filesChanged[0]?.diff).toBe(preview.filesChanged[0]?.diff);
    expect(applied.filesChanged[0]?.afterHash).toBe(preview.filesChanged[0]?.afterHash);
  });

  it('writes binary files without UTF-8 conversion', async () => {
    const content = Uint8Array.from([0x00, 0xff, 0x80, 0x41]);
    const result = await harness.engine.run({
      workspaceId: harness.workspaceId,
      operation: 'binary-test',
      dryRun: false,
      summary: ['write binary bytes'],
      files: [{ kind: 'write', path: 't3HeightMap', content }],
    });

    await expect(readFile(path.join(harness.workingPath, 't3HeightMap'))).resolves.toEqual(Buffer.from(content));
    expect(result.filesChanged[0]).toMatchObject({ addedLines: 0, removedLines: 0, diff: null });
  });

  it('reports a no-op without burning a revision or taking a snapshot', async () => {
    const current = await readFile(path.join(harness.workingPath, DOCUMENT_INFO_PATH), 'utf8');

    const result = await harness.engine.run({
      workspaceId: harness.workspaceId,
      operation: 'test',
      dryRun: false,
      summary: ['no change'],
      files: [{ kind: 'write', path: DOCUMENT_INFO_PATH, content: current }],
    });

    expect(result.filesChanged).toEqual([]);
    expect(result.revisionAfter).toBe(result.revisionBefore);
    expect(result.summary.join(' ')).toContain('No files changed');
    await expect(harness.engine.listSnapshots(harness.workspaceId)).resolves.toEqual([]);
  });

  it('deletes a file and reports it as removed', async () => {
    const result = await harness.engine.run({
      workspaceId: harness.workspaceId,
      operation: 'test',
      dryRun: false,
      summary: ['delete'],
      files: [{ kind: 'delete', path: DOCUMENT_INFO_PATH }],
    });

    expect(result.filesChanged[0]?.afterHash).toBeNull();
    await expect(readFile(path.join(harness.workingPath, DOCUMENT_INFO_PATH), 'utf8')).rejects.toThrow();
  });

  it('treats deleting an absent file as a no-op, not an error', async () => {
    const result = await harness.engine.run({
      workspaceId: harness.workspaceId,
      operation: 'test',
      dryRun: false,
      summary: ['delete missing'],
      files: [{ kind: 'delete', path: 'NotThere' }],
    });

    expect(result.filesChanged).toEqual([]);
  });

  it('rejects a path that would escape the workspace', async () => {
    await expect(
      harness.engine.run({
        workspaceId: harness.workspaceId,
        operation: 'test',
        dryRun: false,
        summary: ['escape'],
        files: [{ kind: 'write', path: '../../escaped.txt', content: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'SC2_PATH_DENIED' });
  });

  it('rejects the same file appearing twice in one transaction', async () => {
    await expect(
      harness.engine.run({
        workspaceId: harness.workspaceId,
        operation: 'test',
        dryRun: false,
        summary: ['double'],
        files: [
          { kind: 'write', path: DOCUMENT_INFO_PATH, content: 'a' },
          { kind: 'write', path: DOCUMENT_INFO_PATH, content: 'b' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'SC2_CONFLICT' });
  });

  it('refuses a stale expected_revision with SC2_CONFLICT', async () => {
    await harness.engine.run({
      workspaceId: harness.workspaceId,
      operation: 'first',
      dryRun: false,
      summary: ['first'],
      files: [{ kind: 'write', path: DOCUMENT_INFO_PATH, content: 'one' }],
    });

    // The caller still believes the workspace is at revision 0.
    await expect(
      harness.engine.run({
        workspaceId: harness.workspaceId,
        operation: 'second',
        dryRun: false,
        expectedRevision: 0,
        summary: ['second'],
        files: [{ kind: 'write', path: DOCUMENT_INFO_PATH, content: 'two' }],
      }),
    ).rejects.toMatchObject({ code: 'SC2_CONFLICT' });

    // And the stale write did not land.
    await expect(readFile(path.join(harness.workingPath, DOCUMENT_INFO_PATH), 'utf8')).resolves.toBe('one');
  });

  it('accepts a matching expected_revision', async () => {
    const state = await harness.store.read(harness.workspaceId);
    await expect(
      harness.engine.run({
        workspaceId: harness.workspaceId,
        operation: 'test',
        dryRun: false,
        expectedRevision: state.revision,
        summary: ['ok'],
        files: [{ kind: 'write', path: DOCUMENT_INFO_PATH, content: 'fine' }],
      }),
    ).resolves.toMatchObject({ dryRun: false });
  });
});

describe('TransactionEngine rollback', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.temp.cleanup();
  });

  /**
   * A write that passes planning but fails at write time.
   *
   * `DocumentInfo` is a regular file, so `DocumentInfo/child.txt` cannot exist and cannot
   * be created — but nothing is detectable until the directory creation actually runs.
   * That is exactly the shape of failure rollback has to survive.
   */
  const FAILS_AT_WRITE_TIME = `${DOCUMENT_INFO_PATH}/child.txt`;

  it('leaves no partial edits when a later write in the same transaction fails', async () => {
    const firstPath = 'Base.SC2Data/GameData/UnitData.xml';
    const originalFirst = await readFile(path.join(harness.workingPath, ...firstPath.split('/')), 'utf8');

    await expect(
      harness.engine.run({
        workspaceId: harness.workspaceId,
        operation: 'multi-file',
        dryRun: false,
        summary: ['write two files, second fails'],
        files: [
          { kind: 'write', path: firstPath, content: 'FIRST WRITE LANDED' },
          { kind: 'write', path: FAILS_AT_WRITE_TIME, content: 'cannot be written' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'SC2_IO_ERROR' });

    // PLAN.md §37 Integration Test 7: no partial changes may remain.
    await expect(readFile(path.join(harness.workingPath, ...firstPath.split('/')), 'utf8')).resolves.toBe(originalFirst);

    // And the revision did not move, so a later expected_revision check stays meaningful.
    const state = await harness.store.read(harness.workspaceId);
    expect(state.revision).toBe(0);
  });

  it('points at the snapshot in the failure message', async () => {
    let thrown: unknown;
    try {
      await harness.engine.run({
        workspaceId: harness.workspaceId,
        operation: 'multi-file',
        dryRun: false,
        summary: ['fails'],
        files: [
          { kind: 'write', path: DOCUMENT_INFO_PATH, content: 'x' },
          { kind: 'write', path: FAILS_AT_WRITE_TIME, content: 'y' },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(String((thrown as { details?: { suggestedAction?: string } }).details?.suggestedAction)).toContain('snap_');
  });

  it('rejects a target that exists but is not a regular file, before writing anything', async () => {
    await mkdir(path.join(harness.workingPath, 'ADirectory'), { recursive: true });
    await writeFile(path.join(harness.workingPath, 'ADirectory', 'keep.txt'), 'x');

    await expect(
      harness.engine.run({
        workspaceId: harness.workspaceId,
        operation: 'test',
        dryRun: false,
        summary: ['write over a directory'],
        files: [{ kind: 'write', path: 'ADirectory', content: 'nope' }],
      }),
    ).rejects.toMatchObject({ code: 'SC2_INVALID_ARGUMENT' });
  });
});

describe('TransactionEngine snapshots and history', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.temp.cleanup();
  });

  async function applyChange(content: string, operation = 'test'): Promise<string> {
    const result = await harness.engine.run({
      workspaceId: harness.workspaceId,
      operation,
      dryRun: false,
      summary: [`set to ${content}`],
      files: [{ kind: 'write', path: DOCUMENT_INFO_PATH, content }],
    });
    return result.changeId;
  }

  it('records a change with its snapshot and file hashes', async () => {
    const changeId = await applyChange('one');
    const records = await harness.engine.listChanges(harness.workspaceId);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ changeId, operation: 'test', reverted: false });
    expect(records[0]?.snapshotId).toMatch(/^snap_/);
    expect(records[0]?.files[0]?.path).toBe(DOCUMENT_INFO_PATH);
  });

  it('lists changes oldest first', async () => {
    const first = await applyChange('one', 'first');
    const second = await applyChange('two', 'second');

    expect((await harness.engine.listChanges(harness.workspaceId)).map((record) => record.changeId)).toEqual([first, second]);
  });

  it('reverts the most recent change and restores the prior contents', async () => {
    const original = await readFile(path.join(harness.workingPath, DOCUMENT_INFO_PATH), 'utf8');
    const changeId = await applyChange('one');

    const result = await harness.engine.revertChange(harness.workspaceId, changeId);

    await expect(readFile(path.join(harness.workingPath, DOCUMENT_INFO_PATH), 'utf8')).resolves.toBe(original);
    // A revert is itself a change: the revision moves forward, never back.
    expect(result.revisionAfter).toBe(2);
  });

  it('refuses to revert a change that is not the most recent', async () => {
    const first = await applyChange('one', 'first');
    await applyChange('two', 'second');

    // Restoring the older snapshot would silently discard the second change.
    await expect(harness.engine.revertChange(harness.workspaceId, first)).rejects.toMatchObject({
      code: 'SC2_CONFLICT',
    });
  });

  it('allows reverting several changes in order', async () => {
    const original = await readFile(path.join(harness.workingPath, DOCUMENT_INFO_PATH), 'utf8');
    const first = await applyChange('one', 'first');
    const second = await applyChange('two', 'second');

    await harness.engine.revertChange(harness.workspaceId, second);
    await harness.engine.revertChange(harness.workspaceId, first);

    await expect(readFile(path.join(harness.workingPath, DOCUMENT_INFO_PATH), 'utf8')).resolves.toBe(original);
  });

  it('refuses to revert the same change twice', async () => {
    const changeId = await applyChange('one');
    await harness.engine.revertChange(harness.workspaceId, changeId);

    await expect(harness.engine.revertChange(harness.workspaceId, changeId)).rejects.toMatchObject({
      code: 'SC2_CONFLICT',
    });
  });

  it('keeps reverted changes in the history, flagged', async () => {
    const changeId = await applyChange('one');
    await harness.engine.revertChange(harness.workspaceId, changeId);

    const records = await harness.engine.listChanges(harness.workspaceId);
    expect(records[0]?.reverted).toBe(true);
  });

  it('creates and restores an explicit snapshot', async () => {
    const original = await readFile(path.join(harness.workingPath, DOCUMENT_INFO_PATH), 'utf8');
    const snapshot = await harness.engine.createSnapshot(harness.workspaceId, 'known good');

    await applyChange('one');
    await applyChange('two');

    await harness.engine.restoreSnapshot(harness.workspaceId, snapshot.snapshotId);
    await expect(readFile(path.join(harness.workingPath, DOCUMENT_INFO_PATH), 'utf8')).resolves.toBe(original);
  });

  it('lists snapshots with their labels', async () => {
    await harness.engine.createSnapshot(harness.workspaceId, 'known good');
    const snapshots = await harness.engine.listSnapshots(harness.workspaceId);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.label).toBe('known good');
  });

  it('reports an unknown snapshot as SC2_NOT_FOUND', async () => {
    await expect(harness.engine.restoreSnapshot(harness.workspaceId, 'snap_nope')).rejects.toMatchObject({
      code: 'SC2_NOT_FOUND',
    });
  });

  it('diffs the staged tree against a snapshot', async () => {
    const snapshot = await harness.engine.createSnapshot(harness.workspaceId);
    await applyChange('CHANGED');

    const changed = await harness.engine.diffAgainstSnapshot(harness.workspaceId, snapshot.snapshotId);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.path).toBe(DOCUMENT_INFO_PATH);
    expect(changed[0]?.diff).toContain('+CHANGED');
  });
});

describe('TransactionEngine read-only workspaces', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({ readOnly: true });
  });

  afterEach(async () => {
    await harness.temp.cleanup();
  });

  it('refuses every mutation', async () => {
    await expect(
      harness.engine.run({
        workspaceId: harness.workspaceId,
        operation: 'test',
        dryRun: false,
        summary: ['nope'],
        files: [{ kind: 'write', path: DOCUMENT_INFO_PATH, content: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'SC2_UNSUPPORTED_OPERATION' });
  });

  it('refuses even a dry run, so the refusal is discovered before work is done', async () => {
    await expect(
      harness.engine.run({
        workspaceId: harness.workspaceId,
        operation: 'test',
        dryRun: true,
        summary: ['nope'],
        files: [{ kind: 'write', path: DOCUMENT_INFO_PATH, content: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'SC2_UNSUPPORTED_OPERATION' });
  });
});

describe('TransactionEngine concurrency', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.temp.cleanup();
  });

  it('serialises overlapping transactions so revisions do not collide', async () => {
    const results = await Promise.all(
      ['a', 'b', 'c'].map((value) =>
        harness.engine.run({
          workspaceId: harness.workspaceId,
          operation: `write-${value}`,
          dryRun: false,
          summary: [`write ${value}`],
          files: [{ kind: 'write', path: `File${value}.txt`, content: value }],
        }),
      ),
    );

    // Each transaction saw a distinct revision; none reused a number.
    const revisions = results.map((result) => result.revisionAfter).sort((left, right) => left - right);
    expect(revisions).toEqual([1, 2, 3]);

    const state = await harness.store.read(harness.workspaceId);
    expect(state.revision).toBe(3);
  });
});
