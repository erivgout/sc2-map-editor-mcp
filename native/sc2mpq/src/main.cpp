// sc2mpq — a narrow MPQ sidecar for the SC2 Map Editor MCP server.
//
// Why a separate process rather than a Node native addon (PLAN.md §6): a crash in
// StormLib while parsing a hostile archive takes down whatever it is linked into. As a
// sidecar that is a non-zero exit code the server reports as a structured error; as an
// addon it would take the MCP server with it, losing every open workspace.
//
// Contract: one JSON object on stdout, always. Exit 0 on success, non-zero otherwise.

#include "commands.hpp"

#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

namespace {

const char* kUsage =
    "sc2mpq — MPQ helper for the SC2 Map Editor MCP server\n"
    "\n"
    "Usage:\n"
    "  sc2mpq version\n"
    "  sc2mpq info <archive>\n"
    "  sc2mpq list <archive>\n"
    "  sc2mpq extract <archive> <destination-dir>\n"
    "  sc2mpq pack <source-dir> <output-archive> [--sector-size N] [--mpq-version 1..4]\n"
    "                                            [--max-file-count N]\n"
    "  sc2mpq verify <archive>\n"
    "\n"
    "Every command writes a single JSON object to stdout.\n";

bool parseUnsigned(const std::string& text, std::uint32_t& out) {
    if (text.empty()) return false;
    std::uint64_t accumulated = 0;
    for (const char character : text) {
        if (character < '0' || character > '9') return false;
        accumulated = accumulated * 10 + static_cast<std::uint64_t>(character - '0');
        if (accumulated > 0xFFFFFFFFull) return false;
    }
    out = static_cast<std::uint32_t>(accumulated);
    return true;
}

#ifdef _WIN32
// Arguments arrive as UTF-16 on Windows; converting to UTF-8 keeps the rest of the
// program encoding-agnostic and matches what the JSON output promises.
std::string toUtf8(const std::wstring& wide) {
    if (wide.empty()) return {};
    const int needed = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()),
                                           nullptr, 0, nullptr, nullptr);
    std::string result(static_cast<std::size_t>(needed), '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()),
                        result.data(), needed, nullptr, nullptr);
    return result;
}
#endif

int run(const std::vector<std::string>& args, const std::vector<std::filesystem::path>& paths) {
    if (args.empty()) {
        std::cerr << kUsage;
        return sc2mpq::emitError("SC2MPQ_INVALID_ARGUMENT", "No command given.");
    }

    const std::string& command = args[0];

    if (command == "--help" || command == "-h" || command == "help") {
        std::cerr << kUsage;
        return 0;
    }
    if (command == "version" || command == "--version") {
        return sc2mpq::commandVersion();
    }

    if (command == "info" || command == "list" || command == "verify") {
        if (paths.size() < 2) {
            return sc2mpq::emitError("SC2MPQ_INVALID_ARGUMENT", command + " requires an archive path.");
        }
        if (command == "info") return sc2mpq::commandInfo(paths[1]);
        if (command == "list") return sc2mpq::commandList(paths[1]);
        return sc2mpq::commandVerify(paths[1]);
    }

    if (command == "extract") {
        if (paths.size() < 3) {
            return sc2mpq::emitError("SC2MPQ_INVALID_ARGUMENT", "extract requires an archive and a destination directory.");
        }
        return sc2mpq::commandExtract(paths[1], paths[2]);
    }

    if (command == "pack") {
        if (paths.size() < 3) {
            return sc2mpq::emitError("SC2MPQ_INVALID_ARGUMENT", "pack requires a source directory and an output path.");
        }

        sc2mpq::PackOptions options;
        for (std::size_t index = 3; index < args.size(); ++index) {
            const std::string& flag = args[index];
            const bool hasValue = index + 1 < args.size();
            if (flag == "--sector-size" && hasValue) {
                if (!parseUnsigned(args[++index], options.sectorSize)) {
                    return sc2mpq::emitError("SC2MPQ_INVALID_ARGUMENT", "--sector-size must be a positive integer.");
                }
            } else if (flag == "--mpq-version" && hasValue) {
                if (!parseUnsigned(args[++index], options.mpqVersion) || options.mpqVersion < 1 || options.mpqVersion > 4) {
                    return sc2mpq::emitError("SC2MPQ_INVALID_ARGUMENT", "--mpq-version must be 1, 2, 3, or 4.");
                }
            } else if (flag == "--max-file-count" && hasValue) {
                if (!parseUnsigned(args[++index], options.maxFileCount)) {
                    return sc2mpq::emitError("SC2MPQ_INVALID_ARGUMENT", "--max-file-count must be a positive integer.");
                }
            } else {
                return sc2mpq::emitError("SC2MPQ_INVALID_ARGUMENT", "Unrecognised option: " + flag);
            }
        }

        return sc2mpq::commandPack(paths[1], paths[2], options);
    }

    std::cerr << kUsage;
    return sc2mpq::emitError("SC2MPQ_INVALID_ARGUMENT", "Unrecognised command: " + command);
}

}  // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
    // Binary stdout: the JSON must reach the caller byte-for-byte, without CRLF
    // translation mangling offsets or the parser's expectations.
    _setmode(_fileno(stdout), _O_BINARY);

    // `args` and `paths` are parallel: index 0 is the command, index 1 the first operand.
    std::vector<std::string> args;
    std::vector<std::filesystem::path> paths;
    for (int index = 1; index < argc; ++index) {
        args.push_back(toUtf8(argv[index]));
        // Keep the native (UTF-16) form for anything used as a filesystem path, so no
        // round-trip through a narrow encoding can lose characters.
        paths.emplace_back(argv[index]);
    }

    return run(args, paths);
}
#else
int main(int argc, char** argv) {
    // Parallel arrays, same convention as the Windows entry point above.
    std::vector<std::string> args;
    std::vector<std::filesystem::path> paths;
    for (int index = 1; index < argc; ++index) {
        args.emplace_back(argv[index]);
        paths.emplace_back(argv[index]);
    }
    return run(args, paths);
}
#endif
