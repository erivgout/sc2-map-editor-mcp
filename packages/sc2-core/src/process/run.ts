/**
 * Safe external-process execution (PLAN.md §35 "Process security").
 *
 * Everything that leaves this process — the `sc2mpq` sidecar, `reg.exe`, the SC2
 * editor — goes through here. The contract is narrow on purpose:
 *
 *   - the executable is a path we chose, never caller-supplied;
 *   - arguments are an array, never a concatenated string, so there is no shell to
 *     inject into (`shell: false` is the `spawn` default and is asserted here);
 *   - a timeout always applies;
 *   - stdout/stderr are capped, so a runaway child cannot exhaust memory.
 */

import { spawn } from 'node:child_process';

import { SC2Error } from '../errors.js';

export interface RunProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly cwd?: string | undefined;
  /**
   * Extra environment on top of a conservative base. The full parent environment is
   * NOT inherited by default (PLAN.md §35 "environment inherited conservatively").
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Cap for each stream. Beyond this the child is killed. */
  readonly maxOutputBytes?: number;
}

export interface RunProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** True when the child was killed for exceeding {@link RunProcessOptions.timeoutMs}. */
  readonly timedOut: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * The environment a child actually needs.
 *
 * Passing the whole parent environment leaks tokens and per-user configuration into
 * tools that have no business seeing them; these are the variables Windows and POSIX
 * child processes genuinely require to start.
 */
function baseEnvironment(): Record<string, string> {
  const keep =
    process.platform === 'win32'
      ? ['SystemRoot', 'SystemDrive', 'windir', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']
      : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'];

  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export async function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = process.hrtime.bigint();

  return new Promise<RunProcessResult>((resolve, reject) => {
    const child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: { ...baseEnvironment(), ...(options.env ?? {}) },
      // Explicit, even though it is the default: this is the property that makes the
      // argument array safe, so it should be visible at the call site.
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    const finish = (result: RunProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        new SC2Error(
          'SC2_IO_ERROR',
          code === 'ENOENT'
            ? `Executable not found: ${options.executable}`
            : `Cannot start process: ${options.executable}`,
          {
            path: options.executable,
            recoverable: code === 'ENOENT',
            ...(code === 'ENOENT' ? { suggestedAction: 'Check the configured helper path, or build the helper first.' } : {}),
          },
          { cause: error },
        ),
      );
    });

    child.on('close', (exitCode, signal) => {
      if (overflowed) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new SC2Error('SC2_LIMIT_EXCEEDED', `Process produced more than ${maxOutputBytes} bytes of output: ${options.executable}`, {
            path: options.executable,
            recoverable: false,
          }),
        );
        return;
      }

      finish({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        timedOut,
      });
    });
  });
}

/** {@link runProcess} that additionally requires exit code 0. */
export async function runProcessChecked(options: RunProcessOptions): Promise<RunProcessResult> {
  const result = await runProcess(options);
  if (result.timedOut) {
    throw new SC2Error('SC2_IO_ERROR', `Process timed out after ${options.timeoutMs} ms: ${options.executable}`, {
      path: options.executable,
      recoverable: true,
      suggestedAction: 'Raise "processTimeoutMs" in the server configuration if the operation is legitimately slow.',
    });
  }
  if (result.exitCode !== 0) {
    throw new SC2Error(
      'SC2_IO_ERROR',
      `Process exited with code ${String(result.exitCode)}: ${options.executable}`,
      {
        path: options.executable,
        recoverable: false,
        // stderr is the actionable part; keep it short so it stays model-friendly.
        context: { stderr: result.stderr.slice(0, 2000) },
      },
    );
  }
  return result;
}
