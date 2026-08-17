import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MINIMAL_DOCUMENT, createTempDir, writeTree, type TempDir } from '@sc2mcp/test-utils';

import { configFromObject } from '../config.js';
import { createNullLogger } from '../logging.js';
import { PathGuard } from '../paths.js';
import { WorkspaceService } from './service.js';
import { WorkspaceStore } from './store.js';

const DOCUMENT_FIXTURE = MINIMAL_DOCUMENT;

interface Harness {
  service: WorkspaceService;
  store: WorkspaceStore;
  sourceDir: string;
  temp: TempDir;
}

async function createHarness(): Promise<Harness> {
  const temp = await createTempDir('sc2mcp-ws-');
  const sourceDir = path.join(temp.path, 'source', 'TestMap.SC2Map');
  const stateRoot = path.join(temp.path, 'state');

  await writeTree(sourceDir, { ...DOCUMENT_FIXTURE });

  const config = configFromObject({
    allowedRoots: [temp.path],
    workspaceRoot: stateRoot,
  });
  const store = new WorkspaceStore({ workspaceRoot: stateRoot, serverVersion: '0.0.0-test' });
  const service = new WorkspaceService({
    config,
    pathGuard: new PathGuard({ allowedRoots: config.allowedRoots }),
    store,
    logger: createNullLogger(),
  });

  return { service, store, sourceDir, temp };
}

describe('WorkspaceService.openDocument', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.temp.cleanup();
  });

  it('stages every file and infers the document kind from the extension', async () => {
    const result = await harness.service.openDocument({ sourcePath: harness.sourceDir });

    expect(result.workspace.documentKind).toBe('map');
    expect(result.workspace.sourceKind).toBe('directory');
    expect(result.workspace.revision).toBe(0);
    expect(result.workspace.dirty).toBe(false);
    expect(result.stagedFileCount).toBe(Object.keys(DOCUMENT_FIXTURE).length);

    const staged = await readFile(path.join(result.workspace.stagingPath, 'DocumentInfo'), 'utf8');
    expect(staged).toBe(DOCUMENT_FIXTURE['DocumentInfo']);
  });

  it('copies bytes verbatim, preserving CRLF line endings', async () => {
    const result = await harness.service.openDocument({ sourcePath: harness.sourceDir });
    const staged = await readFile(path.join(result.workspace.stagingPath, 'DocumentInfo'));
    const original = await readFile(path.join(harness.sourceDir, 'DocumentInfo'));
    expect(staged.equals(original)).toBe(true);
    expect(staged.includes(Buffer.from('\r\n'))).toBe(true);
  });

  it('leaves the source untouched when the staging copy is modified', async () => {
    const result = await harness.service.openDocument({ sourcePath: harness.sourceDir });
    await writeFile(path.join(result.workspace.stagingPath, 'DocumentInfo'), 'MUTATED');

    const source = await readFile(path.join(harness.sourceDir, 'DocumentInfo'), 'utf8');
    expect(source).toBe(DOCUMENT_FIXTURE['DocumentInfo']);
  });

  it('refuses a source outside the allowed roots', async () => {
    const elsewhere = await createTempDir('sc2mcp-elsewhere-');
    try {
      await writeTree(elsewhere.path, { DocumentInfo: '<x/>' });
      await expect(harness.service.openDocument({ sourcePath: elsewhere.path })).rejects.toMatchObject({
        code: 'SC2_PATH_DENIED',
      });
    } finally {
      await elsewhere.cleanup();
    }
  });

  it('refuses a packed archive while no MPQ extractor is available', async () => {
    const archivePath = path.join(harness.temp.path, 'Packed.SC2Map');
    // `MPQ\x1a` followed by filler: enough for the signature probe.
    await writeFile(archivePath, Buffer.concat([Buffer.from([0x4d, 0x50, 0x51, 0x1a]), Buffer.alloc(64)]));

    await expect(harness.service.openDocument({ sourcePath: archivePath })).rejects.toMatchObject({
      code: 'SC2_UNSUPPORTED_OPERATION',
    });
  });

  it('refuses a file that is not an SC2 archive', async () => {
    const notAnArchive = path.join(harness.temp.path, 'notes.txt');
    await writeFile(notAnArchive, 'just text');

    await expect(harness.service.openDocument({ sourcePath: notAnArchive })).rejects.toMatchObject({
      code: 'SC2_INVALID_ARGUMENT',
    });
  });

  it('gives each open its own workspace', async () => {
    const first = await harness.service.openDocument({ sourcePath: harness.sourceDir });
    const second = await harness.service.openDocument({ sourcePath: harness.sourceDir });
    expect(first.workspace.id).not.toBe(second.workspace.id);
    expect(first.workspace.stagingPath).not.toBe(second.workspace.stagingPath);
    // Same bytes in, same source hash out.
    expect(first.workspace.sourceHash).toBe(second.workspace.sourceHash);
  });
});

describe('WorkspaceService source-change detection', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.temp.cleanup();
  });

  it('reports the source as unchanged right after opening', async () => {
    const { workspace } = await harness.service.openDocument({ sourcePath: harness.sourceDir });
    const check = await harness.service.checkSourceUnchanged(workspace.id);
    expect(check.unchanged).toBe(true);
    expect(check.actual).toBe(workspace.sourceHash);
  });

  it('detects an external edit to the source', async () => {
    const { workspace } = await harness.service.openDocument({ sourcePath: harness.sourceDir });
    await writeFile(path.join(harness.sourceDir, 'DocumentInfo'), 'CHANGED BEHIND OUR BACK');

    const check = await harness.service.checkSourceUnchanged(workspace.id);
    expect(check.unchanged).toBe(false);
    expect(check.actual).not.toBe(check.expected);
  });
});

describe('WorkspaceService.discard', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.temp.cleanup();
  });

  it('removes the workspace but never the source', async () => {
    const { workspace } = await harness.service.openDocument({ sourcePath: harness.sourceDir });

    const result = await harness.service.discard(workspace.id);
    expect(result.discarded).toBe(true);
    expect(await harness.store.exists(workspace.id)).toBe(false);

    // Source survives.
    await expect(readFile(path.join(harness.sourceDir, 'DocumentInfo'), 'utf8')).resolves.toBe(
      DOCUMENT_FIXTURE['DocumentInfo'],
    );
  });

  it('is idempotent', async () => {
    const { workspace } = await harness.service.openDocument({ sourcePath: harness.sourceDir });
    await harness.service.discard(workspace.id);
    await expect(harness.service.discard(workspace.id)).resolves.toMatchObject({ discarded: false });
  });
});

describe('WorkspaceService.resolveWorkingPath', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.temp.cleanup();
  });

  it('resolves an archive-style path inside the staging tree', async () => {
    const { workspace } = await harness.service.openDocument({ sourcePath: harness.sourceDir });
    const resolved = await harness.service.resolveWorkingPath(workspace.id, 'Base.SC2Data\\GameData\\UnitData.xml');
    expect(resolved).toBe(path.join(workspace.stagingPath, 'Base.SC2Data', 'GameData', 'UnitData.xml'));
  });

  it('refuses to escape the staging tree', async () => {
    const { workspace } = await harness.service.openDocument({ sourcePath: harness.sourceDir });
    await expect(harness.service.resolveWorkingPath(workspace.id, '../../../etc/passwd')).rejects.toMatchObject({
      code: 'SC2_PATH_DENIED',
    });
  });
});
