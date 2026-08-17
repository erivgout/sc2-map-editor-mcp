/**
 * Real-child-process tests for the process runner (PLAN.md §35).
 *
 * These spawn `process.execPath` — the Node binary already running the tests — with
 * `-e <script>`. That gives a genuine executable on every platform without needing a
 * shell shim, which matters because `runProcess` deliberately sets `shell: false` and a
 * `.cmd`/`.bat` stub cannot be spawned that way on modern Node.
 */

import { describe, expect, it } from 'vitest';

import { runProcess, runProcessChecked, type RunProcessOptions, type RunProcessResult } from './run.js';

/** Spawns Node with an inline script. */
function node(script: string, overrides: Partial<RunProcessOptions> = {}): Promise<RunProcessResult> {
  return runProcess({
    executable: process.execPath,
    args: ['-e', script],
    timeoutMs: 30_000,
    ...overrides,
  });
}

describe('runProcess', () => {
  it('captures stdout and a zero exit code', async () => {
    const result = await node('process.stdout.write("hello")');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr separately from stdout', async () => {
    const result = await node('process.stdout.write("out"); process.stderr.write("err")');

    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
  });

  it('reports a non-zero exit code without throwing', async () => {
    const result = await node('process.exit(3)');
    expect(result.exitCode).toBe(3);
  });

  it('kills a process that exceeds its timeout and reports it', async () => {
    // Busy-waits so it cannot be interrupted by an event-loop trick; only a kill ends it.
    const result = await node('const end = Date.now() + 10000; while (Date.now() < end) {}', { timeoutMs: 300 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('passes arguments through without shell interpretation', async () => {
    // If a shell were involved, the `&&` and quotes would be interpreted rather than
    // arriving as a literal argument. This is the property that makes the argument-array
    // contract safe.
    const hostile = 'a" && echo pwned && "b';
    const result = await node('process.stdout.write(process.argv[1] ?? "")', {
      args: ['-e', 'process.stdout.write(process.argv[1] ?? "")', hostile],
    });

    // Arriving byte-identical is the proof: a shell would have split on `&&`, stripped
    // the quotes, and run `echo` as a separate command.
    expect(result.stdout).toBe(hostile);
  });

  it('does not pass the full parent environment to the child', async () => {
    process.env['SC2MCP_LEAK_CANARY'] = 'should-not-be-inherited';
    try {
      const result = await node('process.stdout.write(String(process.env.SC2MCP_LEAK_CANARY))');
      expect(result.stdout).toBe('undefined');
    } finally {
      delete process.env['SC2MCP_LEAK_CANARY'];
    }
  });

  it('passes explicitly requested environment variables', async () => {
    const result = await node('process.stdout.write(String(process.env.SC2MCP_EXPLICIT))', {
      env: { SC2MCP_EXPLICIT: 'yes' },
    });
    expect(result.stdout).toBe('yes');
  });

  it('rejects with SC2_IO_ERROR when the executable does not exist', async () => {
    await expect(
      runProcess({ executable: 'C:/definitely/not/here/sc2mpq-missing.exe', args: [], timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: 'SC2_IO_ERROR' });
  });

  it('rejects when a child floods stdout past the cap', async () => {
    await expect(
      node('const chunk = "x".repeat(64 * 1024); for (;;) process.stdout.write(chunk);', {
        maxOutputBytes: 256 * 1024,
      }),
    ).rejects.toMatchObject({ code: 'SC2_LIMIT_EXCEEDED' });
  });
});

describe('runProcessChecked', () => {
  it('returns normally on success', async () => {
    await expect(node('process.stdout.write("ok")').then(() => 'reached')).resolves.toBe('reached');
    const result = await runProcessChecked({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("ok")'],
      timeoutMs: 30_000,
    });
    expect(result.stdout).toBe('ok');
  });

  it('throws on a non-zero exit, carrying stderr as context', async () => {
    await expect(
      runProcessChecked({
        executable: process.execPath,
        args: ['-e', 'process.stderr.write("boom"); process.exit(2)'],
        timeoutMs: 30_000,
      }),
    ).rejects.toMatchObject({ code: 'SC2_IO_ERROR' });
  });

  it('throws a recoverable error on timeout', async () => {
    await expect(
      runProcessChecked({
        executable: process.execPath,
        args: ['-e', 'const end = Date.now() + 10000; while (Date.now() < end) {}'],
        timeoutMs: 300,
      }),
    ).rejects.toMatchObject({ code: 'SC2_IO_ERROR', details: { recoverable: true } });
  });
});
