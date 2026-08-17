import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDir, type TempDir } from '@sc2mcp/test-utils';

import { WorkspaceStore, assertValidWorkspaceId, generateWorkspaceId } from './store.js';

function makeStore(root: string): WorkspaceStore {
  return new WorkspaceStore({ workspaceRoot: root, serverVersion: '0.0.0-test' });
}

const SAMPLE_INPUT = {
  sourcePath: 'C:\\maps\\Test.SC2Map',
  sourceKind: 'directory',
  documentKind: 'map',
  sourceHash: 'sha256:deadbeef',
  readOnly: false,
} as const;

describe('workspace ids', () => {
  it('generates ids that pass validation', () => {
    for (let index = 0; index < 20; index += 1) {
      expect(() => {
        assertValidWorkspaceId(generateWorkspaceId());
      }).not.toThrow();
    }
  });

  it('rejects ids that could be used as path segments', () => {
    for (const bad of ['', '..', 'ws_../../etc', 'ws_' + 'z'.repeat(32), 'not-a-workspace']) {
      expect(() => {
        assertValidWorkspaceId(bad);
      }).toThrow();
    }
  });
});

describe('WorkspaceStore', () => {
  let temp: TempDir;
  let store: WorkspaceStore;

  beforeEach(async () => {
    temp = await createTempDir('sc2mcp-store-');
    store = makeStore(temp.path);
  });

  afterEach(async () => {
    await temp.cleanup();
  });

  it('creates the full directory skeleton', async () => {
    const { state, layout } = await store.create(SAMPLE_INPUT);

    expect(state.revision).toBe(0);
    expect(state.dirty).toBe(false);
    expect(layout.root).toBe(path.join(temp.path, 'workspaces', state.id));

    const persisted = JSON.parse(await readFile(layout.statePath, 'utf8')) as Record<string, unknown>;
    expect(persisted['id']).toBe(state.id);
    expect(persisted['stateVersion']).toBe(1);
  });

  it('round-trips state through disk', async () => {
    const { state } = await store.create(SAMPLE_INPUT);
    // A brand-new store instance: proves nothing is cached in memory.
    const reread = await makeStore(temp.path).read(state.id);
    expect(reread).toEqual(state);
  });

  it('reports an unknown workspace as SC2_WORKSPACE_NOT_FOUND', async () => {
    await expect(store.read(generateWorkspaceId())).rejects.toMatchObject({ code: 'SC2_WORKSPACE_NOT_FOUND' });
  });

  it('refuses a state file from a future schema version instead of guessing', async () => {
    const { state, layout } = await store.create(SAMPLE_INPUT);
    const raw = JSON.parse(await readFile(layout.statePath, 'utf8')) as Record<string, unknown>;
    raw['stateVersion'] = 99;
    await writeFile(layout.statePath, JSON.stringify(raw));

    await expect(store.read(state.id)).rejects.toMatchObject({ code: 'SC2_UNSUPPORTED_OPERATION' });
  });

  it('reports a corrupt state file as a parse error', async () => {
    const { state, layout } = await store.create(SAMPLE_INPUT);
    await writeFile(layout.statePath, '{ not json');
    await expect(store.read(state.id)).rejects.toMatchObject({ code: 'SC2_PARSE_ERROR' });
  });

  it('omits unreadable workspaces from list() rather than failing the whole call', async () => {
    const good = await store.create(SAMPLE_INPUT);
    const bad = await store.create(SAMPLE_INPUT);
    await writeFile(bad.layout.statePath, 'corrupt');

    const listed = await store.list();
    expect(listed.map((entry) => entry.id)).toEqual([good.state.id]);
  });

  it('returns an empty list when nothing has been created', async () => {
    await expect(store.list()).resolves.toEqual([]);
  });
});

describe('WorkspaceStore.withLock', () => {
  let temp: TempDir;
  let store: WorkspaceStore;

  beforeEach(async () => {
    temp = await createTempDir('sc2mcp-lock-');
    store = makeStore(temp.path);
  });

  afterEach(async () => {
    await temp.cleanup();
  });

  it('serialises overlapping critical sections on one workspace', async () => {
    const { state } = await store.create(SAMPLE_INPUT);
    const events: string[] = [];

    const task = (label: string, delayMs: number): Promise<void> =>
      store.withLock(state.id, async () => {
        events.push(`${label}:enter`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        events.push(`${label}:exit`);
      });

    // Started together; if the lock works they cannot interleave.
    await Promise.all([task('a', 30), task('b', 1)]);

    expect(events).toEqual(['a:enter', 'a:exit', 'b:enter', 'b:exit']);
  });

  it('does not let a failed section block the next one', async () => {
    const { state } = await store.create(SAMPLE_INPUT);

    await expect(
      store.withLock(state.id, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    await expect(store.withLock(state.id, () => Promise.resolve('recovered'))).resolves.toBe('recovered');
  });

  it('allows different workspaces to run concurrently', async () => {
    const first = await store.create(SAMPLE_INPUT);
    const second = await store.create(SAMPLE_INPUT);

    let secondStarted = false;
    const slow = store.withLock(first.state.id, async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      // The other workspace must not have been forced to wait on this one.
      expect(secondStarted).toBe(true);
    });
    const fast = store.withLock(second.state.id, () => {
      secondStarted = true;
      return Promise.resolve();
    });

    await Promise.all([slow, fast]);
  });
});
