/**
 * Galaxy Editor integration (PLAN.md §29).
 *
 * Scope, stated up front because the plan is emphatic about it: the editor is a
 * **validator and a convenience**, never the editing mechanism. Everything this server
 * changes it changes by manipulating files. This module only opens the editor so a human
 * — or a later verification step — can confirm the result loads.
 *
 * Runtime testing is implemented separately in `runtime.ts`. It mirrors the launch path
 * observed from the editor's Test Document command without using editor UI automation.
 */

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { SC2Error } from '../errors.js';
import { readdirSafe } from '../fs/index.js';
import type { Sc2Installation } from '../install/detect.js';

export interface LaunchEditorInput {
  readonly installation: Sc2Installation;
  /** Document to open. Must already exist and have been guarded. `null` opens a blank editor. */
  readonly documentPath: string | null;
}

export interface LaunchEditorResult {
  readonly executablePath: string;
  readonly documentPath: string | null;
  readonly pid: number | null;
}

/**
 * Opens a document in the Galaxy Editor.
 *
 * The child is **detached** and its stdio discarded: the editor is a long-running GUI
 * application, and holding it as a child would tie its lifetime to this server and fill
 * our pipes with output nobody reads.
 */
export function launchEditor(input: LaunchEditorInput): LaunchEditorResult {
  const executablePath = input.installation.editorPath;
  if (executablePath === null) {
    throw new SC2Error('SC2_EDITOR_NOT_FOUND', `No Galaxy Editor executable under ${input.installation.path}.`, {
      path: input.installation.path,
      recoverable: false,
      suggestedAction: 'Set "sc2InstallPath" in the configuration to an installation that includes the editor.',
    });
  }

  let child;
  try {
    child = spawn(executablePath, input.documentPath === null ? [] : [input.documentPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      // Argument array, no shell — the same rule as every other spawn here (PLAN.md §35).
      shell: false,
    });
  } catch (error) {
    throw new SC2Error(
      'SC2_TEST_LAUNCH_FAILED',
      `Could not start the Galaxy Editor: ${executablePath}`,
      { path: executablePath, recoverable: false },
      { cause: error },
    );
  }

  // Let the editor outlive this process.
  child.unref();

  return { executablePath, documentPath: input.documentPath, pid: child.pid ?? null };
}

export interface EditorLogEntry {
  readonly name: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  /** `Graphics`, `Cutscenes`, `Crash`, … taken from the filename the editor writes. */
  readonly kind: string;
  /** True for crash reports, which the editor writes as a directory rather than a file. */
  readonly isDirectory: boolean;
}

/**
 * Parses the editor's log naming convention.
 *
 * Observed forms in a real installation:
 *   `2025-01-21 23.02.47 Graphics.txt`
 *   `2025-02-18 16.46.08 DESKTOP-XXXX B93333 Crash`   (a directory)
 */
function logKind(name: string): string {
  const withoutExtension = name.replace(/\.txt$/i, '');
  const parts = withoutExtension.split(' ');
  return parts[parts.length - 1] ?? withoutExtension;
}

/** Lists editor logs, newest first. */
export async function listEditorLogs(editorLogsPath: string, limit = 20): Promise<EditorLogEntry[]> {
  const entries = await readdirSafe(editorLogsPath);
  const logs: EditorLogEntry[] = [];

  for (const entry of entries) {
    const fullPath = path.join(editorLogsPath, entry.name);
    try {
      const info = await stat(fullPath);
      logs.push({
        name: entry.name,
        path: fullPath,
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString(),
        kind: logKind(entry.name),
        isDirectory: entry.isDirectory(),
      });
    } catch {
      // A log that vanished between listing and stat is not worth failing over.
    }
  }

  logs.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  return logs.slice(0, limit);
}

/** Reads one editor log, capped so a large crash dump cannot flood a tool result. */
export async function readEditorLog(logPath: string, maxBytes = 64 * 1024): Promise<string> {
  const info = await stat(logPath);
  if (info.isDirectory()) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `${logPath} is a crash report directory, not a log file.`, {
      path: logPath,
      recoverable: true,
      suggestedAction: 'Open the directory yourself; it holds a dump the editor wrote, not text this server can summarise.',
    });
  }

  const content = await readFile(logPath, 'utf8');
  return content.length > maxBytes
    ? `${content.slice(0, maxBytes)}\n… truncated (${content.length} characters total).`
    : content;
}
