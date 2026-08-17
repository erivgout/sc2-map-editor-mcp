/**
 * Locating the user's StarCraft II documents folder.
 *
 * This deserves its own module because the obvious answer is wrong. ADR 0001 recorded
 * that `%USERPROFILE%\Documents` does not point at the real Documents folder on the
 * development machine: OneDrive's Known Folder Move relocates it to
 * `%USERPROFILE%\OneDrive\Documents`. Any code that joins `USERPROFILE` with `Documents`
 * silently looks in an empty directory and concludes the user has no maps.
 *
 * The authoritative answer on Windows is the `Personal` value under the Shell Folders
 * registry key, which Windows keeps pointing at the real location.
 */

import path from 'node:path';

import { pathExists } from '../fs/index.js';
import { runProcess } from '../process/run.js';
import { parseRegQueryOutput } from './registry.js';

/** Subdirectories the editor and game write into, relative to the SC2 documents folder. */
export interface Sc2DocumentsLayout {
  readonly root: string;
  readonly maps: string;
  readonly editorLogs: string;
  readonly gameLogs: string;
  readonly editorBackup: string;
}

/** Reads the real Documents path from the registry. Returns `null` off Windows or on failure. */
export async function queryDocumentsFolder(timeoutMs = 10_000): Promise<string | null> {
  if (process.platform !== 'win32') return null;

  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  try {
    const result = await runProcess({
      executable: `${systemRoot}\\System32\\reg.exe`,
      args: ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders', '/v', 'Personal'],
      timeoutMs,
      maxOutputBytes: 64 * 1024,
    });
    if (result.exitCode !== 0) return null;
    return parseRegQueryOutput(result.stdout, 'Personal');
  } catch {
    return null;
  }
}

/**
 * Finds the StarCraft II documents folder, trying the registry first and falling back to
 * the conventional locations — including the OneDrive-redirected one.
 *
 * Returns `null` rather than guessing when nothing exists; a wrong path here produces
 * "you have no maps", which is worse than "I could not find your maps folder".
 */
export async function findSc2DocumentsFolder(options: { override?: string | undefined } = {}): Promise<Sc2DocumentsLayout | null> {
  const candidates: string[] = [];

  if (options.override !== undefined && options.override !== '') candidates.push(options.override);

  const documents = await queryDocumentsFolder();
  if (documents !== null) candidates.push(path.join(documents, 'StarCraft II'));

  const userProfile = process.env['USERPROFILE'] ?? process.env['HOME'];
  if (userProfile !== undefined && userProfile !== '') {
    // Both forms, because which one is real depends on whether OneDrive moved it.
    candidates.push(path.join(userProfile, 'OneDrive', 'Documents', 'StarCraft II'));
    candidates.push(path.join(userProfile, 'Documents', 'StarCraft II'));
  }

  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue;
    return {
      root: candidate,
      maps: path.join(candidate, 'Maps'),
      editorLogs: path.join(candidate, 'EditorLogs'),
      gameLogs: path.join(candidate, 'GameLogs'),
      editorBackup: path.join(candidate, 'EditorBackup'),
    };
  }

  return null;
}
