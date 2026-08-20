/**
 * Galaxy Editor Test Document integration (PLAN.md §29).
 *
 * This is based on an observed editor 5.0.16 / build 97563 launch, not a guessed game
 * switch. The editor stages the current map beneath `Maps\\Test`, writes an
 * `SC2TestConfig`, and invokes `SC2Switcher_x64.exe`. The switcher then starts the
 * current `SC2_x64.exe` with `-run` and the editor's test settings.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

import { SC2Error } from '../errors.js';
import { copyDirectory, ensureDir, removeTree, writeFileAtomic } from '../fs/index.js';
import type { Sc2Installation } from '../install/detect.js';
import { runProcess } from '../process/index.js';

export const RUNTIME_TEST_MAP_NAME = 'SC2MCPTest.SC2Map';
export const RUNTIME_TEST_CONFIG_NAME = 'SC2MCPTest.SC2TestConfig';

/** Byte-for-byte equivalent in meaning to the config emitted by Test Document. */
export const RUNTIME_TEST_CONFIG =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<TestConfig>\r\n' +
  '    <Attribute AttNamespace="0" Id="1" Player="1" Value="0001"/>\r\n' +
  '    <Attribute AttNamespace="0" Id="1" Player="2" Value="0001"/>\r\n' +
  '    <Attribute AttNamespace="0" Id="1" Player="4" Value="0001"/>\r\n' +
  '    <Attribute AttNamespace="0" Id="1" Player="3" Value="0001"/>\r\n' +
  '    <Attribute AttNamespace="0" Id="1" Player="5" Value="0001"/>\r\n' +
  '    <Attribute AttNamespace="0" Id="2" Player="16" Value="0001"/>\r\n' +
  '</TestConfig>\r\n';

export interface RuntimeTestPaths {
  readonly testRoot: string;
  readonly stagedDocumentPath: string;
  readonly configPath: string;
  readonly switcherPath: string;
  readonly gameExecutablePath: string;
}

export interface StageRuntimeTestOptions {
  readonly maxFiles: number;
  readonly maxSingleFileBytes: number;
  /** A workspace staging directory has no extension, but its descriptor has already proved it is a map. */
  readonly documentIsMap?: boolean;
}

export interface RuntimeLauncherHandle {
  readonly pid: number | null;
  getExitCode(): number | null;
}

export interface RuntimeTestDependencies {
  readonly launch: (
    executablePath: string,
    args: readonly string[],
    workingDirectory: string,
  ) => Promise<RuntimeLauncherHandle>;
  readonly listGameProcessIds: (imageName: string) => Promise<ReadonlySet<number>>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => Date;
  readonly isProcessRunning: (pid: number) => boolean;
}

export interface LaunchRuntimeTestInput extends StageRuntimeTestOptions {
  readonly installation: Sc2Installation;
  readonly documentPath: string;
  readonly startupTimeoutMs: number;
  /** Snapshot taken before launch so later log reads can exclude unrelated older files. */
  readonly gameLogNamesBefore?: readonly string[];
}

export type RuntimeTestStatus = 'running' | 'exited';

export interface RuntimeTestRun {
  readonly id: string;
  readonly startedAt: string;
  readonly sourceDocumentPath: string;
  readonly stagedDocumentPath: string;
  readonly configPath: string;
  readonly executablePath: string;
  readonly launcherPid: number | null;
  readonly gamePid: number;
  readonly status: RuntimeTestStatus;
  /** Internal correlation data. MCP output deliberately exposes only logs created after launch. */
  readonly gameLogNamesBefore: readonly string[];
}

export interface Sc2RuntimeDiagnostic {
  readonly severity: 'error' | 'warning' | 'info';
  readonly channel: string;
  readonly message: string;
}

/** Resolves only fixed, installation-owned paths. No caller input contributes to them. */
export function resolveRuntimeTestPaths(installation: Sc2Installation): RuntimeTestPaths {
  if (installation.switcherPath === null || installation.gameExecutablePath === null) {
    throw new SC2Error(
      'SC2_TEST_LAUNCH_FAILED',
      `The StarCraft II runtime test launcher is incomplete under ${installation.path}.`,
      {
        path: installation.path,
        recoverable: false,
        suggestedAction: 'Repair the StarCraft II installation so SC2Switcher and the current game executable are present.',
      },
    );
  }

  const testRoot = path.resolve(installation.path, 'Maps', 'Test');
  return {
    testRoot,
    stagedDocumentPath: path.join(testRoot, RUNTIME_TEST_MAP_NAME),
    configPath: path.join(testRoot, RUNTIME_TEST_CONFIG_NAME),
    switcherPath: installation.switcherPath,
    gameExecutablePath: installation.gameExecutablePath,
  };
}

/** Arguments observed from the current editor's Test Document process tree. */
export function buildRuntimeTestArguments(configPath: string): string[] {
  return [
    '-run',
    path.win32.join('Test', RUNTIME_TEST_MAP_NAME),
    '-displaymode',
    '2',
    '-preload',
    '1',
    '-NoUserCheats',
    '-reloadcheck',
    '-meleeMod',
    'Void',
    '-difficulty',
    '2',
    '-speed',
    '2',
    '-testconfig',
    configPath,
  ];
}

/**
 * Copies a packed or unpacked map into the exact location searched by `-run`.
 * Only the two `SC2MCPTest` artifacts are replaced; editor-owned `EditorTest` files are
 * never touched.
 */
export async function stageRuntimeTestDocument(
  installation: Sc2Installation,
  documentPath: string,
  options: StageRuntimeTestOptions,
): Promise<RuntimeTestPaths> {
  if (!/\.SC2Map$/i.test(documentPath) && options.documentIsMap !== true) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', 'Runtime testing is only supported for .SC2Map documents.', {
      path: documentPath,
      recoverable: true,
      suggestedAction: 'Pass a packed map or an unpacked map directory whose name ends in .SC2Map.',
    });
  }

  const paths = resolveRuntimeTestPaths(installation);
  const incoming = `${paths.stagedDocumentPath}.incoming-${process.pid}`;

  try {
    const sourceInfo = await stat(documentPath);
    if (!sourceInfo.isFile() && !sourceInfo.isDirectory()) {
      throw new SC2Error('SC2_INVALID_ARGUMENT', 'The runtime-test document must be a file or directory.', {
        path: documentPath,
        recoverable: true,
      });
    }

    await ensureDir(paths.testRoot);
    await removeTree(incoming);

    if (sourceInfo.isDirectory()) {
      await copyDirectory(documentPath, incoming, {
        maxFiles: options.maxFiles,
        maxFileBytes: options.maxSingleFileBytes,
      });
    } else {
      if (sourceInfo.size > options.maxSingleFileBytes) {
        throw new SC2Error(
          'SC2_LIMIT_EXCEEDED',
          `Map exceeds the configured single-file limit of ${options.maxSingleFileBytes} bytes.`,
          { path: documentPath, recoverable: true, context: { size: sourceInfo.size } },
        );
      }
      await copyFile(documentPath, incoming);
    }

    await removeTree(paths.stagedDocumentPath);
    await rename(incoming, paths.stagedDocumentPath);
    await removeTree(paths.configPath);
    await writeFileAtomic(paths.configPath, RUNTIME_TEST_CONFIG);
    return paths;
  } catch (error) {
    await removeTree(incoming).catch(() => {});
    if (error instanceof SC2Error) throw error;
    throw new SC2Error(
      'SC2_TEST_LAUNCH_FAILED',
      `Could not stage the map for StarCraft II under ${paths.testRoot}.`,
      {
        path: paths.testRoot,
        recoverable: false,
        suggestedAction: 'Check that the current user can write to the StarCraft II Maps\\Test directory.',
      },
      { cause: error },
    );
  }
}

/** Parses the stable CSV form emitted by Windows tasklist.exe. */
export function parseTasklistProcessIds(output: string, imageName = 'SC2_x64.exe'): Set<number> {
  const processIds = new Set<number>();
  for (const line of output.split(/\r?\n/u)) {
    const fields = [...line.matchAll(/"((?:[^"]|"")*)"/gu)].map((match) => (match[1] ?? '').replaceAll('""', '"'));
    if ((fields[0] ?? '').toLowerCase() !== imageName.toLowerCase()) continue;
    const pid = Number(fields[1]);
    if (Number.isSafeInteger(pid) && pid > 0) processIds.add(pid);
  }
  return processIds;
}

export function parseSc2AlertDiagnostics(content: string): Sc2RuntimeDiagnostic[] {
  const diagnostics: Sc2RuntimeDiagnostic[] = [];
  const ignored = /^(?:=+|StarCraft II \(|Executable\s|<|Parent Executable|Grandparent Executable|LocalTime\s)/u;

  for (const line of content.split(/\r?\n/u)) {
    const match = /^([A-Z]+)\s+\d+\s+\d+\.\d+\s+\d+\.\d+\s+(.*)$/u.exec(line);
    if (match === null) continue;
    const channel = match[1] ?? 'USER';
    const message = (match[2] ?? '').trim();
    if (message === '' || ignored.test(message)) continue;
    const severity =
      channel === 'ERROR' || channel === 'FATAL' || /\b(?:error|failed|fatal|invalid)\b/iu.test(message)
        ? 'error'
        : channel === 'WARNING' || /\bmissing\b/iu.test(message)
          ? 'warning'
          : 'info';
    diagnostics.push({ severity, channel, message });
  }

  return diagnostics;
}

async function launchWithNode(
  executablePath: string,
  args: readonly string[],
  workingDirectory: string,
): Promise<RuntimeLauncherHandle> {
  const child = spawn(executablePath, [...args], {
    cwd: workingDirectory,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
  });

  try {
    await once(child, 'spawn');
  } catch (error) {
    throw new SC2Error(
      'SC2_TEST_LAUNCH_FAILED',
      `Could not start the StarCraft II switcher: ${executablePath}`,
      { path: executablePath, recoverable: false },
      { cause: error },
    );
  }

  child.unref();
  return {
    pid: child.pid ?? null,
    getExitCode: () => child.exitCode,
  };
}

async function listWindowsGameProcessIds(imageName: string): Promise<ReadonlySet<number>> {
  if (process.platform !== 'win32') return new Set<number>();
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  const result = await runProcess({
    executable: path.join(systemRoot, 'System32', 'tasklist.exe'),
    args: ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'],
    timeoutMs: 5_000,
    maxOutputBytes: 128 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new SC2Error('SC2_TEST_LAUNCH_FAILED', 'Could not inspect running StarCraft II processes.', {
      recoverable: false,
      context: { exitCode: result.exitCode, stderr: result.stderr.slice(0, 1000) },
    });
  }
  return parseTasklistProcessIds(result.stdout, imageName);
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const DEFAULT_DEPENDENCIES: RuntimeTestDependencies = {
  launch: launchWithNode,
  listGameProcessIds: listWindowsGameProcessIds,
  sleep: async (milliseconds) => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  },
  now: () => new Date(),
  isProcessRunning: processIsRunning,
};

export class RuntimeTestService {
  readonly #dependencies: RuntimeTestDependencies;
  #lastRun: RuntimeTestRun | null = null;
  #launching = false;

  constructor(dependencies: RuntimeTestDependencies = DEFAULT_DEPENDENCIES) {
    this.#dependencies = dependencies;
  }

  async launch(input: LaunchRuntimeTestInput): Promise<RuntimeTestRun> {
    if (this.#launching) {
      throw new SC2Error('SC2_CONFLICT', 'A StarCraft II runtime test is already starting.', {
        recoverable: true,
        suggestedAction: 'Wait for sc2_test_document to finish, then retry.',
      });
    }

    const previous = this.getLastRun();
    if (previous?.status === 'running') {
      throw new SC2Error('SC2_CONFLICT', `Runtime test ${previous.id} is still running.`, {
        recoverable: true,
        suggestedAction: 'Close the running StarCraft II test window before launching another test.',
        context: { gamePid: previous.gamePid },
      });
    }

    this.#launching = true;
    try {
      const launchPaths = resolveRuntimeTestPaths(input.installation);
      const gameImageName = path.basename(launchPaths.gameExecutablePath);
      const before = await this.#dependencies.listGameProcessIds(gameImageName);
      if (before.size > 0) {
        throw new SC2Error('SC2_CONFLICT', 'StarCraft II is already running, so a new test process cannot be identified reliably.', {
          recoverable: true,
          suggestedAction: 'Close the existing StarCraft II window and retry sc2_test_document.',
          context: { processIds: [...before] },
        });
      }

      const startedAt = this.#dependencies.now();
      const paths = await stageRuntimeTestDocument(input.installation, input.documentPath, input);
      const args = buildRuntimeTestArguments(paths.configPath);
      const launcher = await this.#dependencies.launch(paths.switcherPath, args, input.installation.path);
      const deadline = startedAt.getTime() + input.startupTimeoutMs;
      let gamePid: number | null = null;

      while (this.#dependencies.now().getTime() <= deadline) {
        const current = await this.#dependencies.listGameProcessIds(gameImageName);
        const started = [...current].filter((pid) => !before.has(pid));
        if (started.length === 1) {
          gamePid = started[0] ?? null;
          break;
        }
        if (started.length > 1) {
          throw new SC2Error('SC2_TEST_LAUNCH_FAILED', 'Several StarCraft II processes appeared during test launch.', {
            recoverable: true,
            context: { processIds: started },
          });
        }
        const exitCode = launcher.getExitCode();
        if (exitCode !== null && exitCode !== 0) {
          throw new SC2Error('SC2_TEST_LAUNCH_FAILED', `SC2Switcher exited with code ${exitCode}.`, {
            path: paths.switcherPath,
            recoverable: false,
          });
        }
        await this.#dependencies.sleep(250);
      }

      if (gamePid === null) {
        throw new SC2Error('SC2_TEST_LAUNCH_FAILED', `StarCraft II did not start within ${input.startupTimeoutMs} ms.`, {
          path: paths.gameExecutablePath,
          recoverable: true,
          suggestedAction: 'Call sc2_get_last_test_log for any startup diagnostics, then retry after closing Blizzard processes.',
          context: { launcherPid: launcher.pid, launcherExitCode: launcher.getExitCode() },
        });
      }

      const run: RuntimeTestRun = {
        id: randomUUID(),
        startedAt: startedAt.toISOString(),
        sourceDocumentPath: input.documentPath,
        stagedDocumentPath: paths.stagedDocumentPath,
        configPath: paths.configPath,
        executablePath: paths.gameExecutablePath,
        launcherPid: launcher.pid,
        gamePid,
        status: 'running',
        gameLogNamesBefore: [...(input.gameLogNamesBefore ?? [])],
      };
      this.#lastRun = run;
      return run;
    } finally {
      this.#launching = false;
    }
  }

  getLastRun(): RuntimeTestRun | null {
    if (this.#lastRun === null) return null;
    const status = this.#dependencies.isProcessRunning(this.#lastRun.gamePid) ? 'running' : 'exited';
    if (status === this.#lastRun.status) return this.#lastRun;
    this.#lastRun = { ...this.#lastRun, status };
    return this.#lastRun;
  }
}
