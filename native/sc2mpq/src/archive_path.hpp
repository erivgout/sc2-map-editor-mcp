// Archive-path handling.
//
// Paths that come out of an MPQ are untrusted input: the archive was authored by
// someone else and may be hostile. Extraction is the point where a crafted path becomes
// a file written outside the destination, so normalisation here is deliberately strict
// and *rejects* rather than sanitises. A quietly-rewritten path is a corrupted repack
// waiting to happen.
//
// This mirrors `normalizeArchivePath` in packages/sc2-core/src/paths.ts. The two must
// agree; where they disagree, the stricter one wins and the difference is a bug.

#pragma once

#include <filesystem>
#include <string>

namespace sc2mpq {

struct PathResult {
    bool ok = false;
    std::string value;   // Normalised path when ok.
    std::string reason;  // Why it was rejected when !ok.
};

// Converts an in-archive path to the canonical forward-slash form, or explains why it
// cannot be used. Rejects traversal, absolute paths, drive letters, NUL bytes, Windows
// reserved device names, and segments ending in a dot or space.
PathResult normalizeArchivePath(const std::string& archivePath);

// Maps a normalised archive path onto a host path beneath `destination`, refusing
// anything that would resolve outside it even after symlink-free lexical normalisation.
PathResult resolveWithin(const std::filesystem::path& destination, const std::string& archivePath,
                         std::filesystem::path& resolved);

// Converts a host path relative to `root` into an archive path (forward slashes).
std::string toArchivePath(const std::filesystem::path& root, const std::filesystem::path& file);

// UTF-8 <-> native filesystem path. On Windows the native encoding is UTF-16, so the
// conversion is not a no-op and must not be skipped.
std::filesystem::path fromUtf8(const std::string& utf8);
std::string toUtf8(const std::filesystem::path& path);

}  // namespace sc2mpq
