// The five archive operations the MCP server needs (PLAN.md §10).
//
// Every command writes exactly one JSON object to stdout and returns an exit code:
// 0 on success, non-zero on failure. Diagnostics never go to stdout, because stdout is
// the machine-readable channel.

#pragma once

#include <cstdint>
#include <filesystem>
#include <string>

namespace sc2mpq {

struct PackOptions {
    // 0 means "let StormLib choose its default" rather than a real sector size of zero.
    //
    // The right value for a round-trip is whatever the source archive used, which the
    // caller learns from `info` and passes back here. Guessing a fixed size would
    // silently reformat every file in the archive.
    std::uint32_t sectorSize = 0;
    // MPQ format version 1-4. 0 means default (v1). SC2 documents are typically v4.
    std::uint32_t mpqVersion = 0;
    // 0 means "derive from the file count", with headroom.
    std::uint32_t maxFileCount = 0;
};

int commandVersion();
int commandInfo(const std::filesystem::path& archive);
int commandList(const std::filesystem::path& archive);
int commandExtract(const std::filesystem::path& archive, const std::filesystem::path& destination);
int commandPack(const std::filesystem::path& sourceDir, const std::filesystem::path& output, const PackOptions& options);
int commandVerify(const std::filesystem::path& archive);

// Emits a single `{"ok":false,...}` object. Shared with argument parsing in main.
int emitError(const std::string& code, const std::string& message, const std::string& path = {});

}  // namespace sc2mpq
