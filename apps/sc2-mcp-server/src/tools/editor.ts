/**
 * Galaxy Editor tools (PLAN.md §29, §42 Phase 13).
 *
 * These exist so a change can be *checked* — opened in the real editor, and its logs read
 * afterwards. They are not how anything gets edited.
 *
 * `sc2_launch_editor` starts a GUI application on the user's machine, which is the most
 * outward-facing thing this server does, so it is marked non-read-only and open-world and
 * its description says plainly what will appear on screen.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import {
  SC2Error,
  findSc2DocumentsFolder,
  launchEditor,
  listEditorLogs,
  parseSc2AlertDiagnostics,
  readEditorLog,
  RUNTIME_TEST_MAP_NAME,
} from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

export function registerEditorTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger, config, pathGuard } = context;

  server.registerTool(
    'sc2_launch_editor',
    {
      title: 'Open a document in the Galaxy Editor',
      description:
        'Starts the StarCraft II Editor with a document open. This opens a window on the user\'s machine and leaves it running independently of this server. Use it to inspect a staged or committed document. Use sc2_test_document when the map must actually run in StarCraft II.',
      inputSchema: z.object({
        document_path: z
          .string()
          .optional()
          .describe('Absolute path of a document to open. Must be inside an allowed root. Omit to open the editor with nothing loaded.'),
        workspace_id: z
          .string()
          .optional()
          .describe('Open this workspace\'s staging copy instead. Handy for checking work before committing.'),
      }),
      outputSchema: z.object({
        executablePath: z.string(),
        documentPath: z.string().nullable(),
        pid: z.number().int().nullable(),
        note: z.string(),
      }),
      // Starts an external GUI application: not read-only, and its effects are outside
      // this server's world.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    toolHandler({ name: 'sc2_launch_editor', logger }, async (args) => {
      const installation = context.selectedInstallation;
      if (installation === null) {
        throw new SC2Error('SC2_EDITOR_NOT_FOUND', 'No unambiguous StarCraft II installation was detected.', {
          recoverable: true,
          suggestedAction: 'Run sc2_detect_installations, then set "sc2InstallPath" in the configuration.',
        });
      }

      let documentPath: string | null = null;
      if (args.workspace_id !== undefined) {
        const descriptor = await workspaces.getDescriptor(args.workspace_id);
        documentPath = descriptor.stagingPath;
      } else if (args.document_path !== undefined) {
        // Guarded like any other caller-supplied path, even though we only read it.
        documentPath = await pathGuard.resolve(args.document_path, { mode: 'must-exist' });
      }

      const result = launchEditor({
        installation,
        documentPath,
      });

      const note =
        documentPath === null
          ? 'The editor was started with no document.'
          : 'The editor was started. Loading is asynchronous — check the window, and sc2_get_editor_logs afterwards if it fails.';

      return ok(
        [`Started ${result.executablePath}${documentPath === null ? '' : ` with ${documentPath}`} (pid ${result.pid ?? 'unknown'}).`, note].join(
          '\n',
        ),
        { executablePath: result.executablePath, documentPath, pid: result.pid, note },
      );
    }),
  );

  server.registerTool(
    'sc2_test_document',
    {
      title: 'Run a map through StarCraft II Test Document',
      description:
        'Stages one .SC2Map in the installation-owned Maps\\Test area, writes the editor-compatible test configuration, invokes SC2Switcher, and waits until the real SC2 game process appears. This opens StarCraft II on the user\'s machine. Only one game client may be running so the process can be identified reliably. Call sc2_get_last_test_log for status and GameLogs diagnostics.',
      inputSchema: z.object({
        document_path: z
          .string()
          .optional()
          .describe('Absolute path of a packed or unpacked .SC2Map inside an allowed root.'),
        workspace_id: z
          .string()
          .optional()
          .describe('Test this workspace\'s current staging copy, including uncommitted edits.'),
        startup_timeout_ms: z.number().int().min(1_000).max(60_000).optional(),
      }),
      outputSchema: z.object({
        runId: z.string(),
        startedAt: z.string(),
        sourceDocumentPath: z.string(),
        stagedDocumentPath: z.string(),
        configPath: z.string(),
        executablePath: z.string(),
        launcherPid: z.number().int().nullable(),
        gamePid: z.number().int(),
        status: z.enum(['running', 'exited']),
        note: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    toolHandler({ name: 'sc2_test_document', logger }, async (args) => {
      const installation = context.selectedInstallation;
      if (installation === null) {
        throw new SC2Error('SC2_EDITOR_NOT_FOUND', 'No unambiguous StarCraft II installation was detected.', {
          recoverable: true,
          suggestedAction: 'Run sc2_detect_installations, then set "sc2InstallPath" in the configuration.',
        });
      }
      if (args.workspace_id !== undefined && args.document_path !== undefined) {
        throw new SC2Error('SC2_INVALID_ARGUMENT', 'Pass workspace_id or document_path, not both.', {
          recoverable: true,
        });
      }
      if (args.workspace_id === undefined && args.document_path === undefined) {
        throw new SC2Error('SC2_INVALID_ARGUMENT', 'Pass workspace_id or document_path.', { recoverable: true });
      }

      let documentPath: string;
      let documentIsMap = false;
      if (args.workspace_id !== undefined) {
        const descriptor = await workspaces.getDescriptor(args.workspace_id);
        if (descriptor.documentKind !== 'map') {
          throw new SC2Error('SC2_INVALID_ARGUMENT', 'Only map workspaces can be run in StarCraft II.', {
            workspaceId: descriptor.id,
            recoverable: true,
            context: { documentKind: descriptor.documentKind },
          });
        }
        documentPath = descriptor.stagingPath;
        documentIsMap = true;
      } else {
        documentPath = await pathGuard.resolve(args.document_path ?? '', { mode: 'must-exist' });
      }

      const documentsBefore = await findSc2DocumentsFolder();
      const gameLogNamesBefore =
        documentsBefore === null
          ? []
          : (await listEditorLogs(documentsBefore.gameLogs, 1_000)).map((entry) => entry.name);
      const run = await context.runtimeTests.launch({
        installation,
        documentPath,
        startupTimeoutMs: args.startup_timeout_ms ?? Math.min(config.processTimeoutMs, 30_000),
        maxFiles: config.maxExtractedFiles,
        maxSingleFileBytes: config.maxSingleFileBytes,
        documentIsMap,
        gameLogNamesBefore,
      });
      const note =
        'StarCraft II accepted the test launch and began loading the staged map. Inspect gameplay as needed and call sc2_get_last_test_log for status and alerts.';

      return ok(`Started runtime test ${run.id} in StarCraft II (game pid ${run.gamePid}).\n${note}`, {
        runId: run.id,
        startedAt: run.startedAt,
        sourceDocumentPath: run.sourceDocumentPath,
        stagedDocumentPath: run.stagedDocumentPath,
        configPath: run.configPath,
        executablePath: run.executablePath,
        launcherPid: run.launcherPid,
        gamePid: run.gamePid,
        status: run.status,
        note,
      });
    }),
  );

  server.registerTool(
    'sc2_get_last_test_log',
    {
      title: 'Get the last StarCraft II test status and logs',
      description:
        'Returns the last runtime test process status, GameLogs created for that launch, the newest Alerts log, and parsed alert messages. Use this after sc2_test_document to distinguish a running client, a clean exit, and map/runtime diagnostics.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        run: z
          .object({
            runId: z.string(),
            startedAt: z.string(),
            sourceDocumentPath: z.string(),
            stagedDocumentPath: z.string(),
            configPath: z.string(),
            executablePath: z.string(),
            launcherPid: z.number().int().nullable(),
            gamePid: z.number().int(),
            status: z.enum(['running', 'exited']),
          })
          .nullable(),
        gameLogsRoot: z.string().nullable(),
        logs: z.array(
          z.object({
            name: z.string(),
            sizeBytes: z.number().int(),
            modifiedAt: z.string(),
            kind: z.string(),
            isDirectory: z.boolean(),
          }),
        ),
        diagnostics: z.array(
          z.object({ severity: z.enum(['error', 'warning', 'info']), channel: z.string(), message: z.string() }),
        ),
        alertsContent: z.string().nullable(),
        note: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_last_test_log', logger }, async () => {
      const run = context.runtimeTests.getLastRun();
      if (run === null) {
        const note = 'No runtime test has been launched by this server process.';
        return ok(note, {
          run: null,
          gameLogsRoot: null,
          logs: [],
          diagnostics: [],
          alertsContent: null,
          note,
        });
      }

      const documents = await findSc2DocumentsFolder();
      const allLogs = documents === null ? [] : await listEditorLogs(documents.gameLogs, 100);
      const threshold = Date.parse(run.startedAt) - 2_000;
      const previousNames = new Set(run.gameLogNamesBefore);
      const logs = allLogs
        .filter((entry) => !previousNames.has(entry.name) && Date.parse(entry.modifiedAt) >= threshold)
        .slice(0, 20);
      let alertsContent: string | null = null;
      for (const alerts of logs.filter((entry) => entry.kind.toLowerCase() === 'alerts' && !entry.isDirectory)) {
        const candidate = await readEditorLog(alerts.path);
        if (candidate.includes(RUNTIME_TEST_MAP_NAME)) {
          alertsContent = candidate;
          break;
        }
      }
      const diagnostics = alertsContent === null ? [] : parseSc2AlertDiagnostics(alertsContent);
      const note =
        run.status === 'running'
          ? 'The StarCraft II test process is still running.'
          : alertsContent === null
            ? 'The StarCraft II test process exited. No Alerts log was found for this launch.'
            : `The StarCraft II test process exited. Parsed ${diagnostics.length} alert message(s).`;

      return ok(
        [
          `Runtime test ${run.id}: ${run.status} (game pid ${run.gamePid}).`,
          ...diagnostics.map((entry) => `${entry.severity.toUpperCase()} [${entry.channel}] ${entry.message}`),
          note,
        ].join('\n'),
        {
          run: {
            runId: run.id,
            startedAt: run.startedAt,
            sourceDocumentPath: run.sourceDocumentPath,
            stagedDocumentPath: run.stagedDocumentPath,
            configPath: run.configPath,
            executablePath: run.executablePath,
            launcherPid: run.launcherPid,
            gamePid: run.gamePid,
            status: run.status,
          },
          gameLogsRoot: documents?.gameLogs ?? null,
          logs: logs.map((entry) => ({
            name: entry.name,
            sizeBytes: entry.sizeBytes,
            modifiedAt: entry.modifiedAt,
            kind: entry.kind,
            isDirectory: entry.isDirectory,
          })),
          diagnostics,
          alertsContent,
          note,
        },
      );
    }),
  );

  server.registerTool(
    'sc2_get_editor_logs',
    {
      title: 'List or read Galaxy Editor logs',
      description:
        'Lists the editor\'s own logs, newest first, or reads one. The editor writes these to the user\'s StarCraft II documents folder. Crash reports are directories rather than text files and are listed but not readable here. This is the closest thing to a diagnostic channel after opening a document in the editor.',
      inputSchema: z.object({
        log_name: z.string().optional().describe('Read this log instead of listing. Use a name from a previous listing.'),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: z.object({
        documentsRoot: z.string().nullable(),
        logs: z.array(
          z.object({
            name: z.string(),
            sizeBytes: z.number().int(),
            modifiedAt: z.string(),
            kind: z.string(),
            isDirectory: z.boolean(),
          }),
        ),
        content: z.string().nullable(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_editor_logs', logger }, async (args) => {
      const documents = await findSc2DocumentsFolder({ override: config.sc2InstallPath === null ? undefined : undefined });
      if (documents === null) {
        throw new SC2Error('SC2_NOT_FOUND', 'Could not locate the StarCraft II documents folder.', {
          recoverable: false,
          suggestedAction:
            'It is normally under Documents\\StarCraft II. OneDrive may have moved it; this server checks the registry and both usual locations.',
        });
      }

      const logs = await listEditorLogs(documents.editorLogs, args.limit ?? 20);

      if (args.log_name === undefined) {
        return ok(
          [
            `Editor logs in ${documents.editorLogs}:`,
            ...logs.map((log) => `  ${log.name} — ${log.kind} — ${log.sizeBytes} bytes — ${log.modifiedAt}${log.isDirectory ? ' (crash report directory)' : ''}`),
          ].join('\n'),
          {
            documentsRoot: documents.root,
            logs: logs.map((log) => ({
              name: log.name,
              sizeBytes: log.sizeBytes,
              modifiedAt: log.modifiedAt,
              kind: log.kind,
              isDirectory: log.isDirectory,
            })),
            content: null,
          },
        );
      }

      const wanted = logs.find((log) => log.name === args.log_name);
      if (wanted === undefined) {
        throw new SC2Error('SC2_NOT_FOUND', `No editor log named "${args.log_name}" in the most recent ${logs.length}.`, {
          recoverable: true,
          suggestedAction: 'Call this tool without log_name to list them, or raise "limit".',
        });
      }

      const content = await readEditorLog(wanted.path);
      return ok(content, {
        documentsRoot: documents.root,
        logs: [
          {
            name: wanted.name,
            sizeBytes: wanted.sizeBytes,
            modifiedAt: wanted.modifiedAt,
            kind: wanted.kind,
            isDirectory: wanted.isDirectory,
          },
        ],
        content,
      });
    }),
  );

  server.registerTool(
    'sc2_get_user_maps',
    {
      title: 'List the user\'s own maps',
      description:
        'Lists documents in the user\'s StarCraft II Maps folder — where the editor saves by default. Resolves the real Documents location through the registry, because OneDrive commonly moves it and the obvious %USERPROFILE%\\Documents path is then wrong and empty.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        documentsRoot: z.string().nullable(),
        mapsRoot: z.string().nullable(),
        maps: z.array(z.object({ name: z.string(), path: z.string(), isDirectory: z.boolean() })),
        note: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_user_maps', logger }, async () => {
      const documents = await findSc2DocumentsFolder();
      if (documents === null) {
        return ok('Could not locate the StarCraft II documents folder.', {
          documentsRoot: null,
          mapsRoot: null,
          maps: [],
          note: 'Checked the registry Documents path and both the OneDrive and profile locations.',
        });
      }

      const { readdirSafe } = await import('@sc2mcp/core');
      const entries = await readdirSafe(documents.maps);
      const maps = entries
        .filter((entry) => /\.(SC2Map|SC2Mod|SC2Campaign)$/i.test(entry.name))
        .map((entry) => ({
          name: entry.name,
          path: `${documents.maps}\\${entry.name}`,
          isDirectory: entry.isDirectory(),
        }));

      const note =
        'These paths must be inside a configured allowed root before sc2_open_document will accept them.';

      return ok(
        [`${maps.length} document(s) in ${documents.maps}:`, ...maps.map((map) => `  ${map.name}`), note].join('\n'),
        { documentsRoot: documents.root, mapsRoot: documents.maps, maps, note },
      );
    }),
  );
}
