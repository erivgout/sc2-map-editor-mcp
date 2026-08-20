import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createTempDir, writeTree, type TempDir } from '@sc2mcp/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveCapabilities } from '../capabilities.js';
import { inspectInstallation, type Sc2Installation } from '../install/detect.js';
import {
  RUNTIME_TEST_CONFIG,
  RUNTIME_TEST_CONFIG_NAME,
  RUNTIME_TEST_MAP_NAME,
  RuntimeTestService,
  buildRuntimeTestArguments,
  parseSc2AlertDiagnostics,
  parseTasklistProcessIds,
  stageRuntimeTestDocument,
  type RuntimeTestDependencies,
} from './runtime.js';

function fakeInstallation(root: string): Sc2Installation {
  return {
    path: root,
    source: 'config',
    editorPath: path.join(root, 'StarCraft II Editor_x64.exe'),
    latestBuild: 97563,
    gameExecutablePath: path.join(root, 'Versions', 'Base97563', 'SC2_x64.exe'),
    switcherPath: path.join(root, 'Support64', 'SC2Switcher_x64.exe'),
    usable: true,
  };
}

describe('runtime test staging', () => {
  let temp: TempDir;

  beforeEach(async () => {
    temp = await createTempDir('sc2mcp-runtime-');
  });

  afterEach(async () => {
    await temp.cleanup();
  });

  it('stages a packed map and the observed editor test configuration', async () => {
    const documentPath = path.join(temp.path, 'Source.SC2Map');
    await writeTree(temp.path, { 'Source.SC2Map': Buffer.from([0x4d, 0x50, 0x51]) });

    const result = await stageRuntimeTestDocument(fakeInstallation(temp.path), documentPath, {
      maxFiles: 100,
      maxSingleFileBytes: 1024,
    });

    expect(result.stagedDocumentPath).toBe(path.join(temp.path, 'Maps', 'Test', RUNTIME_TEST_MAP_NAME));
    expect(await readFile(result.stagedDocumentPath)).toEqual(Buffer.from([0x4d, 0x50, 0x51]));
    expect(await readFile(result.configPath, 'utf8')).toBe(RUNTIME_TEST_CONFIG);
    expect(result.configPath).toBe(path.join(temp.path, 'Maps', 'Test', RUNTIME_TEST_CONFIG_NAME));
  });

  it('discovers the preferred 64-bit editor, switcher, and current game build', async () => {
    await writeTree(temp.path, {
      'StarCraft II Editor_x64.exe': '',
      'Support64/SC2Switcher_x64.exe': '',
      'Versions/Base97563/SC2_x64.exe': '',
    });

    const installation = await inspectInstallation(temp.path, 'config');
    expect(installation.editorPath).toBe(path.join(temp.path, 'StarCraft II Editor_x64.exe'));
    expect(installation.switcherPath).toBe(path.join(temp.path, 'Support64', 'SC2Switcher_x64.exe'));
    expect(installation.gameExecutablePath).toBe(path.join(temp.path, 'Versions', 'Base97563', 'SC2_x64.exe'));
    expect(installation.latestBuild).toBe(97563);
  });

  it('stages an extensionless workspace tree only when its descriptor already proved it is a map', async () => {
    const working = path.join(temp.path, 'state', 'workspace', 'working');
    await writeTree(working, { DocumentInfo: '<DocInfo/>', 'Base.SC2Data/GameData/UnitData.xml': '<Catalog/>' });

    await expect(
      stageRuntimeTestDocument(fakeInstallation(temp.path), working, {
        maxFiles: 100,
        maxSingleFileBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'SC2_INVALID_ARGUMENT' });

    const result = await stageRuntimeTestDocument(fakeInstallation(temp.path), working, {
      maxFiles: 100,
      maxSingleFileBytes: 1024,
      documentIsMap: true,
    });
    expect(await readFile(path.join(result.stagedDocumentPath, 'DocumentInfo'), 'utf8')).toBe('<DocInfo/>');
    expect(await readFile(path.join(result.stagedDocumentPath, 'Base.SC2Data', 'GameData', 'UnitData.xml'), 'utf8')).toBe(
      '<Catalog/>',
    );
  });
});

describe('runtime test process protocol', () => {
  it('builds the command observed from Galaxy Editor Test Document', () => {
    expect(buildRuntimeTestArguments('C:\\StarCraft II\\Maps\\Test\\SC2MCPTest.SC2TestConfig')).toEqual([
      '-run',
      'Test\\SC2MCPTest.SC2Map',
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
      'C:\\StarCraft II\\Maps\\Test\\SC2MCPTest.SC2TestConfig',
    ]);
  });

  it('parses tasklist CSV without mistaking its no-task message for a process', () => {
    const output =
      '"SC2_x64.exe","6812","Console","1","1,234,567 K"\r\n' +
      '"Other.exe","20","Console","1","10 K"\r\n';
    expect([...parseTasklistProcessIds(output)]).toEqual([6812]);
    expect([...parseTasklistProcessIds('INFO: No tasks are running which match the specified criteria.')]).toEqual([]);
  });

  it('extracts actionable messages from an Alerts log and ignores launch metadata', () => {
    const content =
      'USER                  0    0.000    0.063 StarCraft II (B97563)\r\n' +
      'USER                  0    0.000    0.063 <Parameters> -run Test\\SC2MCPTest.SC2Map\r\n' +
      "USER                  0    0.000    0.063 Invalid preplaced unit: ''.\r\n" +
      'WARNING               0    0.000    0.063 Missing actor\r\n';
    expect(parseSc2AlertDiagnostics(content)).toEqual([
      { severity: 'error', channel: 'USER', message: "Invalid preplaced unit: ''." },
      { severity: 'warning', channel: 'WARNING', message: 'Missing actor' },
    ]);
  });

  it('waits for and records the real game pid rather than the short-lived switcher pid', async () => {
    const temp = await createTempDir('sc2mcp-runtime-service-');
    try {
      const documentPath = path.join(temp.path, 'Source.SC2Map');
      await writeTree(temp.path, { 'Source.SC2Map': 'map' });
      let processProbe = 0;
      let running = true;
      const launches: { executablePath: string; args: readonly string[]; workingDirectory: string }[] = [];
      const dependencies: RuntimeTestDependencies = {
        launch: (executablePath, args, workingDirectory) => {
          launches.push({ executablePath, args, workingDirectory });
          return Promise.resolve({ pid: 111, getExitCode: () => 0 });
        },
        listGameProcessIds: () => {
          processProbe += 1;
          return Promise.resolve(processProbe === 1 ? new Set<number>() : new Set([222]));
        },
        sleep: () => Promise.resolve(),
        now: () => new Date('2026-08-20T16:00:00.000Z'),
        isProcessRunning: () => running,
      };
      const service = new RuntimeTestService(dependencies);

      const run = await service.launch({
        installation: fakeInstallation(temp.path),
        documentPath,
        startupTimeoutMs: 5_000,
        maxFiles: 100,
        maxSingleFileBytes: 1024,
      });

      expect(run.launcherPid).toBe(111);
      expect(run.gamePid).toBe(222);
      expect(run.status).toBe('running');
      expect(launches).toHaveLength(1);
      expect(launches[0]?.executablePath).toContain('SC2Switcher_x64.exe');
      expect(launches[0]?.args).toContain('Test\\SC2MCPTest.SC2Map');

      running = false;
      expect(service.getLastRun()?.status).toBe('exited');
    } finally {
      await temp.cleanup();
    }
  });

  it('advertises runtime testing only when its launcher backend is available', () => {
    const base = { mpqHelperAvailable: false, editorAvailable: true, toolkitAvailable: false };
    expect(deriveCapabilities({ ...base, runtimeLauncherAvailable: true }).runtimeSmokeTest).toBe(true);
    expect(deriveCapabilities({ ...base, runtimeLauncherAvailable: false }).runtimeSmokeTest).toBe(false);
  });
});
