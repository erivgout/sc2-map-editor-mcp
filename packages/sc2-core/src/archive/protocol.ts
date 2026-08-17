/**
 * Wire protocol between the TypeScript adapter and the `sc2mpq` sidecar.
 *
 * These schemas are the contract. They mirror the JSON emitted by
 * `native/sc2mpq/src/commands.cpp` exactly; if the two drift, the adapter fails loudly
 * at parse time rather than acting on a half-understood response — which, for a program
 * that repacks people's maps, is the only acceptable failure mode.
 *
 * `.strict()` is deliberate: an unexpected field means the helper is a different version
 * from the one this build expects, and the protocol-version probe should have caught it.
 */

import { z } from 'zod';

/**
 * Bumped whenever the sidecar's JSON shape or CLI changes incompatibly.
 * Must match `SC2MPQ_PROTOCOL_VERSION` in `native/sc2mpq/CMakeLists.txt`.
 */
export const MPQ_HELPER_PROTOCOL_VERSION = 1;

export const HelperErrorSchema = z
  .object({
    ok: z.literal(false),
    code: z.string(),
    message: z.string(),
    path: z.string().nullable(),
  })
  .strict();

export const VersionResultSchema = z
  .object({
    ok: z.literal(true),
    tool: z.literal('sc2mpq'),
    version: z.string(),
    protocolVersion: z.number().int(),
    stormLib: z.string(),
  })
  .strict();

export const InfoResultSchema = z
  .object({
    ok: z.literal(true),
    headerSizeIsV1: z.boolean(),
    /**
     * The archive's sector size. Feed this back into `pack` to round-trip a document:
     * repacking with a different sector size rewrites every compressed file.
     */
    sectorSize: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
    maxFileCount: z.number().int().nonnegative(),
    hasUserData: z.boolean(),
    hasListfile: z.boolean(),
    hasAttributes: z.boolean(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export const ArchiveFileSchema = z
  .object({
    path: z.string(),
    size: z.number().int().nonnegative(),
    compressedSize: z.number().int().nonnegative(),
    flags: z.number().int().nonnegative(),
    locale: z.number().int().nonnegative(),
  })
  .strict();

export const ListResultSchema = z
  .object({
    ok: z.literal(true),
    /** MPQ enumeration depends on `(listfile)`. Without one, `files` is empty but the
     *  archive is not: `headerFileCount` is how the caller learns that. */
    listfilePresent: z.boolean(),
    enumeratedCount: z.number().int().nonnegative(),
    headerFileCount: z.number().int().nonnegative(),
    files: z.array(ArchiveFileSchema),
  })
  .strict();

export const FailureSchema = z.object({ path: z.string(), reason: z.string() }).strict();

export const ExtractResultSchema = z
  .object({
    /** False when any member failed. A partial extraction is never reported as success. */
    ok: z.boolean(),
    listfilePresent: z.boolean(),
    extractedCount: z.number().int().nonnegative(),
    files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative() }).strict()),
    failures: z.array(FailureSchema),
  })
  .strict();

export const PackResultSchema = z
  .object({
    ok: z.literal(true),
    output: z.string(),
    fileCount: z.number().int().nonnegative(),
    sectorSize: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
    files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative() }).strict()),
  })
  .strict();

export const VerifyResultSchema = z
  .object({
    ok: z.boolean(),
    listfilePresent: z.boolean(),
    enumeratedCount: z.number().int().nonnegative(),
    readableCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    failures: z.array(FailureSchema),
  })
  .strict();

export type HelperError = z.infer<typeof HelperErrorSchema>;
export type VersionResult = z.infer<typeof VersionResultSchema>;
export type InfoResult = z.infer<typeof InfoResultSchema>;
export type ListResult = z.infer<typeof ListResultSchema>;
export type ExtractResult = z.infer<typeof ExtractResultSchema>;
export type PackResult = z.infer<typeof PackResultSchema>;
export type VerifyResult = z.infer<typeof VerifyResultSchema>;
export type ArchiveFile = z.infer<typeof ArchiveFileSchema>;

export interface PackOptions {
  /** Preserve the source archive's sector size for a faithful round-trip. */
  readonly sectorSize?: number | undefined;
  /** MPQ format version 1-4. Omit for the helper's default. */
  readonly mpqVersion?: 1 | 2 | 3 | 4 | undefined;
  readonly maxFileCount?: number | undefined;
}
