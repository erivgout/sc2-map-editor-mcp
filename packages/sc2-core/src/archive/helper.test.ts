/**
 * Adapter tests that do not need the compiled helper.
 *
 * The sidecar needs a C++ toolchain, so neither CI nor most developers will have it. What
 * matters for correctness here is the *protocol* discipline — version gating, strict
 * response validation, and refusing to act on output we do not fully understand — which
 * is exercised against an injected runner.
 *
 * The spawning path itself is not stubbed away: `process/run.test.ts` covers it against
 * a real child process.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createTempDir, type TempDir } from '@sc2mcp/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunProcessOptions, RunProcessResult } from '../process/run.js';
import { createMpqExtractor } from './extractor.js';
import { MpqHelper, defaultHelperPaths, type ProcessRunner } from './helper.js';
import { ExtractResultSchema, InfoResultSchema, ListResultSchema, MPQ_HELPER_PROTOCOL_VERSION } from './protocol.js';

const VERSION_OK = JSON.stringify({
  ok: true,
  tool: 'sc2mpq',
  version: '0.1.0',
  protocolVersion: MPQ_HELPER_PROTOCOL_VERSION,
  stormLib: '9.40',
});

interface StubResponse {
  stdout: string;
  exitCode?: number;
}

/** Records every invocation so argument arrays can be asserted. */
interface StubRunner {
  runner: ProcessRunner;
  calls: RunProcessOptions[];
}

function stubRunner(responses: Record<string, StubResponse>): StubRunner {
  const calls: RunProcessOptions[] = [];
  const runner: ProcessRunner = (options) => {
    calls.push(options);
    const command = options.args[0] ?? '';
    const response = responses[command];
    const result: RunProcessResult = {
      exitCode: response === undefined ? 1 : (response.exitCode ?? 0),
      signal: null,
      stdout: response?.stdout ?? '',
      stderr: response === undefined ? `no stub for ${command}` : '',
      durationMs: 1,
      timedOut: false,
    };
    return Promise.resolve(result);
  };
  return { runner, calls };
}

/** The probe requires the path to exist on disk before it runs anything. */
async function touchFakeBinary(directory: string): Promise<string> {
  const binaryPath = path.join(directory, process.platform === 'win32' ? 'sc2mpq.exe' : 'sc2mpq');
  await writeFile(binaryPath, '');
  return binaryPath;
}

describe('MpqHelper.probe', () => {
  let temp: TempDir;

  beforeEach(async () => {
    temp = await createTempDir('sc2mcp-mpq-');
  });

  afterEach(async () => {
    await temp.cleanup();
  });

  it('reports the searched locations when the binary is missing', async () => {
    const probe = await MpqHelper.probe({ helperPath: path.join(temp.path, 'nope.exe'), timeoutMs: 10_000 });

    expect(probe.available).toBe(false);
    if (!probe.available) {
      expect(probe.searched).toHaveLength(1);
      // The message must say how to fix it, not merely that it failed.
      expect(probe.reason).toMatch(/build-native|mpqHelperPath/);
    }
  });

  it('accepts a helper that reports the expected protocol version', async () => {
    const helperPath = await touchFakeBinary(temp.path);
    const { runner, calls } = stubRunner({ version: { stdout: VERSION_OK } });

    const probe = await MpqHelper.probe({ helperPath, timeoutMs: 30_000, runner });

    expect(probe.available).toBe(true);
    if (probe.available) expect(probe.version.stormLib).toBe('9.40');
    expect(calls[0]?.args).toEqual(['version']);
  });

  it('refuses a helper built from a different protocol version', async () => {
    const helperPath = await touchFakeBinary(temp.path);
    const { runner } = stubRunner({
      version: {
        stdout: JSON.stringify({ ok: true, tool: 'sc2mpq', version: '9.9.9', protocolVersion: 999, stormLib: '9.40' }),
      },
    });

    const probe = await MpqHelper.probe({ helperPath, timeoutMs: 30_000, runner });

    // A mismatched sidecar must not be used at all: its JSON could mean something else.
    expect(probe.available).toBe(false);
    if (!probe.available) expect(probe.reason).toContain('protocol version 999');
  });

  it('refuses a helper whose version output does not match the schema', async () => {
    const helperPath = await touchFakeBinary(temp.path);
    const { runner } = stubRunner({ version: { stdout: '{"ok":true,"tool":"something-else"}' } });

    const probe = await MpqHelper.probe({ helperPath, timeoutMs: 30_000, runner });
    expect(probe.available).toBe(false);
  });

  it('reports a helper that cannot be started, rather than throwing at startup', async () => {
    const helperPath = await touchFakeBinary(temp.path);
    const runner: ProcessRunner = () => Promise.reject(new Error('spawn EACCES'));

    const probe = await MpqHelper.probe({ helperPath, timeoutMs: 30_000, runner });
    expect(probe.available).toBe(false);
    if (!probe.available) expect(probe.reason).toContain('spawn EACCES');
  });

  it('looks in the repo-relative build output by default', () => {
    const [first] = defaultHelperPaths();
    expect(first).toMatch(/native[\\/]sc2mpq[\\/]bin[\\/]sc2mpq/);
  });
});

describe('MpqHelper command handling', () => {
  let temp: TempDir;

  beforeEach(async () => {
    temp = await createTempDir('sc2mcp-mpq-cmd-');
  });

  afterEach(async () => {
    await temp.cleanup();
  });

  async function helperWith(responses: Record<string, StubResponse>): Promise<{ helper: MpqHelper; calls: RunProcessOptions[] }> {
    const helperPath = await touchFakeBinary(temp.path);
    const { runner, calls } = stubRunner({ version: { stdout: VERSION_OK }, ...responses });
    const probe = await MpqHelper.probe({ helperPath, timeoutMs: 30_000, runner });
    if (!probe.available) throw new Error(`stub helper rejected: ${probe.reason}`);
    return { helper: MpqHelper.fromProbe(probe, 30_000), calls };
  }

  it('parses a well-formed info response', async () => {
    const { helper } = await helperWith({
      info: {
        stdout: JSON.stringify({
          ok: true,
          headerSizeIsV1: false,
          sectorSize: 16777216,
          fileCount: 143,
          maxFileCount: 256,
          hasUserData: true,
          hasListfile: true,
          hasAttributes: false,
          sizeBytes: 4096,
        }),
      },
    });

    const info = await helper.info('C:/maps/Test.SC2Map');
    expect(info.sectorSize).toBe(16777216);
    expect(info.fileCount).toBe(143);
  });

  it("surfaces the helper's own structured error rather than a bare exit code", async () => {
    const { helper } = await helperWith({
      info: {
        stdout: JSON.stringify({
          ok: false,
          code: 'SC2MPQ_OPEN_FAILED',
          message: 'Cannot open archive: bad archive format',
          path: 'C:/maps/Broken.SC2Map',
        }),
        exitCode: 1,
      },
    });

    await expect(helper.info('C:/maps/Broken.SC2Map')).rejects.toMatchObject({
      code: 'SC2_PACK_FAILED',
      message: 'Cannot open archive: bad archive format',
    });
  });

  it('falls back to raw streams when a failure is not reported as JSON', async () => {
    const { helper } = await helperWith({ info: { stdout: 'segmentation fault', exitCode: 139 } });

    await expect(helper.info('C:/maps/Test.SC2Map')).rejects.toMatchObject({
      code: 'SC2_PACK_FAILED',
      message: expect.stringContaining('failed during "info"'),
    });
  });

  it('refuses output it cannot fully validate, even on a zero exit code', async () => {
    // An unknown field means this helper is not the one this build was written against.
    // Acting on it could mean repacking with the wrong sector size.
    const { helper } = await helperWith({
      list: {
        stdout: JSON.stringify({
          ok: true,
          listfilePresent: true,
          enumeratedCount: 0,
          headerFileCount: 0,
          files: [],
          somethingNew: 42,
        }),
      },
    });

    await expect(helper.list('C:/maps/Test.SC2Map')).rejects.toMatchObject({ code: 'SC2_PACK_FAILED' });
  });

  it('reports a timeout as recoverable, with the knob to change', async () => {
    const helperPath = await touchFakeBinary(temp.path);
    const { runner: probeRunner } = stubRunner({ version: { stdout: VERSION_OK } });
    const probe = await MpqHelper.probe({ helperPath, timeoutMs: 30_000, runner: probeRunner });
    expect(probe.available).toBe(true);
    if (!probe.available) return;

    const timingOutRunner: ProcessRunner = () =>
      Promise.resolve({ exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', durationMs: 30_000, timedOut: true });
    // Rebuild against the timing-out runner via a second probe so the adapter carries it.
    const timedProbe = await MpqHelper.probe({
      helperPath,
      timeoutMs: 30_000,
      runner: (options) => (options.args[0] === 'version' ? probeRunner(options) : timingOutRunner(options)),
    });
    if (!timedProbe.available) return;

    await expect(MpqHelper.fromProbe(timedProbe, 30_000).verify('C:/maps/Test.SC2Map')).rejects.toMatchObject({
      code: 'SC2_PACK_FAILED',
      details: { recoverable: true },
    });
  });

  it('passes pack options as separate argv entries, never a joined string', async () => {
    const { helper, calls } = await helperWith({
      pack: {
        stdout: JSON.stringify({ ok: true, output: '/out.SC2Map', fileCount: 0, sectorSize: 4096, sizeBytes: 0, files: [] }),
      },
    });

    await helper.pack('/src', '/out.SC2Map', { sectorSize: 4096, mpqVersion: 4 });

    const packCall = calls.find((call) => call.args[0] === 'pack');
    // One argv entry per token: a concatenated string would reintroduce the shell-quoting
    // problems PLAN.md §35 exists to prevent.
    expect(packCall?.args).toEqual(['pack', '/src', '/out.SC2Map', '--sector-size', '4096', '--mpq-version', '4']);
    // Omitted options must not be sent, so the helper applies its own default.
    expect(packCall?.args).not.toContain('--max-file-count');
  });
});

describe('createMpqExtractor', () => {
  const baseResult = { ok: true, listfilePresent: true, extractedCount: 3, files: [], failures: [] };

  function stubHelper(result: unknown): MpqHelper {
    return { extract: () => Promise.resolve(ExtractResultSchema.parse(result)) } as unknown as MpqHelper;
  }

  it('returns the extracted count on success', async () => {
    const extractor = createMpqExtractor(stubHelper(baseResult));
    await expect(extractor.extract('a.SC2Map', 'dest')).resolves.toEqual({ fileCount: 3 });
  });

  it('refuses a partial extraction rather than staging an incomplete document', async () => {
    const extractor = createMpqExtractor(
      stubHelper({
        ...baseResult,
        ok: false,
        failures: [{ path: 'Base.SC2Data/Broken.xml', reason: 'sector CRC mismatch' }],
      }),
    );

    await expect(extractor.extract('a.SC2Map', 'dest')).rejects.toMatchObject({ code: 'SC2_PARSE_ERROR' });
  });

  it('refuses an archive with no listfile, since it cannot be fully enumerated', async () => {
    const extractor = createMpqExtractor(stubHelper({ ...baseResult, listfilePresent: false }));

    await expect(extractor.extract('a.SC2Map', 'dest')).rejects.toMatchObject({
      code: 'SC2_UNSUPPORTED_COMPONENT',
    });
  });
});

describe('protocol schemas', () => {
  it('reject responses with missing or unexpected fields', () => {
    expect(InfoResultSchema.safeParse({ ok: true }).success).toBe(false);
    expect(ListResultSchema.safeParse({ ok: true, listfilePresent: true }).success).toBe(false);
  });

  it('accept the extract result shape the helper emits on partial failure', () => {
    const parsed = ExtractResultSchema.safeParse({
      ok: false,
      listfilePresent: true,
      extractedCount: 1,
      files: [{ path: 'DocumentInfo', size: 12 }],
      failures: [{ path: '../evil', reason: 'archive path contains a traversal segment' }],
    });
    expect(parsed.success).toBe(true);
  });
});
