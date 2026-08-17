/**
 * Adapter for the `sc2mpq` sidecar (PLAN.md §6, §10).
 *
 * The MCP server never links StormLib. It spawns a small helper binary with an argument
 * array and parses one JSON object from its stdout. That boundary is the point: a crash
 * while parsing a hostile archive becomes an exit code we can report, instead of taking
 * the server and every open workspace down with it.
 *
 * Nothing here trusts the helper blindly. Its protocol version is probed once and
 * checked, and every response is validated against {@link protocol}'s strict schemas
 * before a single byte of it influences a repack.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SC2Error } from '../errors.js';
import { pathExists } from '../fs/index.js';
import { runProcess, type RunProcessOptions, type RunProcessResult } from '../process/run.js';
import {
  ExtractResultSchema,
  HelperErrorSchema,
  InfoResultSchema,
  ListResultSchema,
  MPQ_HELPER_PROTOCOL_VERSION,
  PackResultSchema,
  VerifyResultSchema,
  VersionResultSchema,
  type ExtractResult,
  type InfoResult,
  type ListResult,
  type PackOptions,
  type PackResult,
  type VerifyResult,
  type VersionResult,
} from './protocol.js';

const EXECUTABLE_NAME = process.platform === 'win32' ? 'sc2mpq.exe' : 'sc2mpq';

/**
 * Candidate locations, in preference order.
 *
 * The repo-relative path is what makes `pnpm build && build-native.ps1` produce a
 * working server with no configuration at all.
 */
export function defaultHelperPaths(): string[] {
  // `import.meta.url` resolves to `<pkg>/dist/archive/helper.js` after a build and
  // `<pkg>/src/archive/helper.ts` under vitest; both are three levels below the package
  // root, so one expression covers each case.
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const repoRoot = path.resolve(packageRoot, '..', '..');
  return [path.join(repoRoot, 'native', 'sc2mpq', 'bin', EXECUTABLE_NAME)];
}

/**
 * How the adapter actually invokes the helper.
 *
 * Injectable so the protocol layer can be tested without a compiled binary — building
 * it needs a C++ toolchain that CI does not have. `runProcess` itself is covered
 * separately in `process/run.test.ts`, so the seam does not hide the spawning path.
 */
export type ProcessRunner = (options: RunProcessOptions) => Promise<RunProcessResult>;

export interface MpqHelperOptions {
  /** Explicit path from configuration. Takes precedence over discovery. */
  readonly helperPath?: string | null | undefined;
  readonly timeoutMs: number;
  readonly runner?: ProcessRunner | undefined;
}

/** Why the helper is unavailable, in words a caller can act on. */
export interface HelperUnavailable {
  readonly available: false;
  readonly reason: string;
  readonly searched: readonly string[];
}

export interface HelperAvailable {
  readonly available: true;
  readonly executablePath: string;
  readonly version: VersionResult;
}

export type HelperProbe = HelperAvailable | HelperUnavailable;

/** Carried from the probe to {@link MpqHelper.fromProbe} so the same runner is reused. */
const probeRunners = new WeakMap<HelperAvailable, ProcessRunner>();

function helperFailure(commandName: string, executablePath: string, stdout: string, stderr: string, exitCode: number | null): SC2Error {
  // The helper reports its own failures as JSON, which carries far more than an exit
  // code. Fall back to the raw streams only when that parse fails.
  const parsed = tryParseJson(stdout);
  const structured = parsed === undefined ? undefined : HelperErrorSchema.safeParse(parsed);

  if (structured?.success === true) {
    return new SC2Error('SC2_PACK_FAILED', structured.data.message, {
      ...(structured.data.path !== null ? { path: structured.data.path } : {}),
      recoverable: false,
      context: { helperCode: structured.data.code, command: commandName },
    });
  }

  return new SC2Error('SC2_PACK_FAILED', `The sc2mpq helper failed during "${commandName}".`, {
    path: executablePath,
    recoverable: false,
    context: {
      exitCode,
      stderr: stderr.slice(0, 2000),
      stdout: stdout.slice(0, 2000),
    },
  });
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export class MpqHelper {
  readonly #executablePath: string;
  readonly #timeoutMs: number;
  readonly #runner: ProcessRunner;

  private constructor(executablePath: string, timeoutMs: number, runner: ProcessRunner) {
    this.#executablePath = executablePath;
    this.#timeoutMs = timeoutMs;
    this.#runner = runner;
  }

  get executablePath(): string {
    return this.#executablePath;
  }

  /**
   * Locates the helper and verifies it speaks our protocol version.
   *
   * Returns a description of the problem instead of throwing, because "no helper" is an
   * expected state — the binary requires a C++ toolchain that most users will not have —
   * and it must degrade into an honest capability flag, not a startup crash.
   */
  static async probe(options: MpqHelperOptions): Promise<HelperProbe> {
    const configured = options.helperPath;
    const candidates =
      configured !== null && configured !== undefined && configured !== ''
        ? [path.resolve(configured)]
        : defaultHelperPaths();

    let executablePath: string | undefined;
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        executablePath = candidate;
        break;
      }
    }

    if (executablePath === undefined) {
      return {
        available: false,
        reason:
          'The sc2mpq helper binary was not found. Build it with scripts/build-native.ps1, or set "mpqHelperPath" in the configuration.',
        searched: candidates,
      };
    }

    const runner = options.runner ?? runProcess;

    let result;
    try {
      result = await runner({
        executable: executablePath,
        args: ['version'],
        timeoutMs: options.timeoutMs,
        maxOutputBytes: 64 * 1024,
      });
    } catch (error) {
      return {
        available: false,
        reason: `The sc2mpq helper could not be started: ${error instanceof Error ? error.message : 'unknown error'}`,
        searched: [executablePath],
      };
    }

    const parsed = VersionResultSchema.safeParse(tryParseJson(result.stdout));
    if (!parsed.success) {
      return {
        available: false,
        reason: 'The sc2mpq helper did not answer the version probe with a response this build understands.',
        searched: [executablePath],
      };
    }

    if (parsed.data.protocolVersion !== MPQ_HELPER_PROTOCOL_VERSION) {
      return {
        available: false,
        reason: `The sc2mpq helper speaks protocol version ${parsed.data.protocolVersion}, but this server expects ${MPQ_HELPER_PROTOCOL_VERSION}. Rebuild the helper from this checkout.`,
        searched: [executablePath],
      };
    }

    const probe: HelperAvailable = { available: true, executablePath, version: parsed.data };
    if (options.runner !== undefined) probeRunners.set(probe, options.runner);
    return probe;
  }

  /** Builds an adapter for an already-probed helper. */
  static fromProbe(probe: HelperAvailable, timeoutMs: number): MpqHelper {
    return new MpqHelper(probe.executablePath, timeoutMs, probeRunners.get(probe) ?? runProcess);
  }

  async #run<T>(commandName: string, args: readonly string[], schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }): Promise<T> {
    const result = await this.#runner({
      executable: this.#executablePath,
      args,
      timeoutMs: this.#timeoutMs,
    });

    if (result.timedOut) {
      throw new SC2Error('SC2_PACK_FAILED', `The sc2mpq helper timed out during "${commandName}" after ${this.#timeoutMs} ms.`, {
        path: this.#executablePath,
        recoverable: true,
        suggestedAction: 'Raise "processTimeoutMs" if the archive is genuinely large.',
      });
    }

    if (result.exitCode !== 0) {
      throw helperFailure(commandName, this.#executablePath, result.stdout, result.stderr, result.exitCode);
    }

    const parsed = schema.safeParse(tryParseJson(result.stdout));
    if (!parsed.success || parsed.data === undefined) {
      // Exit code 0 with unparseable output means the helper and this build disagree
      // about the protocol. Acting on a guess here could corrupt a document.
      throw new SC2Error('SC2_PACK_FAILED', `The sc2mpq helper returned output for "${commandName}" that this build cannot parse.`, {
        path: this.#executablePath,
        recoverable: false,
        suggestedAction: 'Rebuild the helper from this checkout so both sides speak the same protocol.',
        context: { stdout: result.stdout.slice(0, 2000) },
      });
    }

    return parsed.data;
  }

  async info(archivePath: string): Promise<InfoResult> {
    return this.#run('info', ['info', archivePath], InfoResultSchema);
  }

  async list(archivePath: string): Promise<ListResult> {
    return this.#run('list', ['list', archivePath], ListResultSchema);
  }

  /**
   * Extracts every member into `destination`.
   *
   * Path traversal is rejected inside the helper as well as here; the double check is
   * deliberate, since the helper is the side actually creating files.
   */
  async extract(archivePath: string, destination: string): Promise<ExtractResult> {
    return this.#run('extract', ['extract', archivePath, destination], ExtractResultSchema);
  }

  async pack(sourceDir: string, output: string, options: PackOptions = {}): Promise<PackResult> {
    const args = ['pack', sourceDir, output];
    if (options.sectorSize !== undefined) args.push('--sector-size', String(options.sectorSize));
    if (options.mpqVersion !== undefined) args.push('--mpq-version', String(options.mpqVersion));
    if (options.maxFileCount !== undefined) args.push('--max-file-count', String(options.maxFileCount));
    return this.#run('pack', args, PackResultSchema);
  }

  async verify(archivePath: string): Promise<VerifyResult> {
    return this.#run('verify', ['verify', archivePath], VerifyResultSchema);
  }
}
