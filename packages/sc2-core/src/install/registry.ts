/**
 * Windows registry lookup for the StarCraft II install location.
 *
 * Kept separate from `detect.ts` so that discovery logic stays pure and testable, and
 * so the one place that spawns a process is obvious.
 *
 * Which key: ADR 0001 recorded that on the development machine
 * `HKLM\SOFTWARE\WOW6432Node\Blizzard Entertainment\StarCraft II` exists but carries
 * **no values**, while the 32-bit uninstall key does carry `InstallLocation`. Both are
 * queried, strongest first, because neither is guaranteed on an arbitrary machine.
 */

import { runProcess } from '../process/run.js';

interface RegistryQuery {
  readonly key: string;
  readonly value: string;
}

/** Queried in order; the first hit wins. */
const QUERIES: readonly RegistryQuery[] = [
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\StarCraft II', value: 'InstallLocation' },
  { key: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\StarCraft II', value: 'InstallLocation' },
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\StarCraft II', value: 'InstallPath' },
  { key: 'HKLM\\SOFTWARE\\Blizzard Entertainment\\StarCraft II', value: 'InstallPath' },
  { key: 'HKCU\\Software\\Blizzard Entertainment\\StarCraft II', value: 'InstallPath' },
];

/**
 * Parses `reg.exe query` output.
 *
 * The payload line looks like:
 * `    InstallLocation    REG_SZ    C:\Program Files (x86)\StarCraft II`
 *
 * Splitting on runs of whitespace would corrupt paths containing spaces, so the value
 * is taken as everything after the type token.
 */
export function parseRegQueryOutput(stdout: string, valueName: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith(valueName.toLowerCase())) continue;
    const match = /^\S+\s+(REG_[A-Z_]+)\s+(.*)$/.exec(trimmed);
    const captured = match?.[2]?.trim();
    if (captured !== undefined && captured !== '') return captured;
  }
  return null;
}

/**
 * Returns install paths found in the registry, in preference order.
 *
 * Never throws: a missing key, a missing `reg.exe`, or a non-Windows platform all
 * mean "the registry told us nothing", which is a normal outcome rather than an error.
 */
export async function queryRegistryInstallPaths(timeoutMs = 10_000): Promise<string[]> {
  if (process.platform !== 'win32') return [];

  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  const regExecutable = `${systemRoot}\\System32\\reg.exe`;

  const found: string[] = [];
  for (const query of QUERIES) {
    try {
      const result = await runProcess({
        executable: regExecutable,
        args: ['query', query.key, '/v', query.value],
        timeoutMs,
        maxOutputBytes: 64 * 1024,
      });
      if (result.exitCode !== 0) continue;
      const value = parseRegQueryOutput(result.stdout, query.value);
      if (value !== null && !found.includes(value)) found.push(value);
    } catch {
      // reg.exe absent or unreadable: treat as no result.
    }
  }
  return found;
}
