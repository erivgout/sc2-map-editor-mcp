/**
 * Bridges {@link MpqHelper} to the {@link MpqExtractor} interface the workspace service
 * depends on, so the service knows nothing about sidecars or JSON protocols.
 */

import { SC2Error } from '../errors.js';
import type { MpqPacker } from '../workspace/commit.js';
import type { MpqExtractor } from '../workspace/service.js';
import type { MpqHelper } from './helper.js';

export function createMpqExtractor(helper: MpqHelper): MpqExtractor {
  return {
    async extract(archivePath: string, destination: string): Promise<{ fileCount: number }> {
      const result = await helper.extract(archivePath, destination);

      if (!result.ok) {
        // A partial extraction must not become a workspace. Anything built on top of it
        // — a catalog index, a diff, a repack — would silently omit whatever failed.
        throw new SC2Error('SC2_PARSE_ERROR', `Could not extract ${result.failures.length} file(s) from the archive.`, {
          path: archivePath,
          recoverable: false,
          context: {
            failures: result.failures.slice(0, 20),
            extractedCount: result.extractedCount,
          },
        });
      }

      if (!result.listfilePresent) {
        // Without `(listfile)` an MPQ cannot be fully enumerated: members whose names we
        // never learn are invisible, so "extracted everything" would be a guess.
        throw new SC2Error('SC2_UNSUPPORTED_COMPONENT', 'The archive has no (listfile), so its contents cannot be fully enumerated.', {
          path: archivePath,
          recoverable: false,
          suggestedAction:
            'Open the document in the StarCraft II Editor and save it once; the editor writes a listfile. Protected maps deliberately omit it and are out of scope.',
          context: { extractedCount: result.extractedCount },
        });
      }

      return { fileCount: result.extractedCount };
    },
  };
}

/**
 * Bridges {@link MpqHelper} to the {@link MpqPacker} interface the commit flow needs.
 *
 * `pack` already deletes a half-written archive on failure, and `verify` reopens and reads
 * every member, so commit's own verification step is a genuine reopen rather than a
 * restatement of what pack believed.
 */
export function createMpqPacker(helper: MpqHelper): MpqPacker {
  return {
    async pack(sourceDir, output, options) {
      const result = await helper.pack(sourceDir, output, { sectorSize: options.sectorSize });
      return { fileCount: result.fileCount };
    },
    async verify(archivePath) {
      const result = await helper.verify(archivePath);
      return { ok: result.ok, failures: result.failures };
    },
  };
}
