#include "commands.hpp"

#include "archive_path.hpp"
#include "json.hpp"

#include <StormLib.h>

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <system_error>
#include <vector>

namespace sc2mpq {
namespace {

// StormLib reports failures through the platform's last-error channel.
std::string lastErrorText() {
    const int code = static_cast<int>(GetLastError());
    switch (code) {
        case ERROR_FILE_NOT_FOUND:   return "file not found";
        case ERROR_ACCESS_DENIED:    return "access denied";
        case ERROR_INVALID_HANDLE:   return "invalid handle";
        case ERROR_NOT_ENOUGH_MEMORY:return "out of memory";
        case ERROR_BAD_FORMAT:       return "bad archive format";
        case ERROR_NO_MORE_FILES:    return "no more files";
        case ERROR_HANDLE_EOF:       return "unexpected end of file";
        case ERROR_FILE_CORRUPT:     return "file is corrupt";
        case ERROR_AVI_FILE:         return "not an MPQ archive (looks like an AVI)";
        case ERROR_UNKNOWN_FILE_KEY: return "unknown file key (encrypted file could not be decrypted)";
        case ERROR_CHECKSUM_ERROR:   return "sector CRC mismatch";
        default:                     return "StormLib error " + std::to_string(code);
    }
}

// RAII for archive and file handles: several commands have multiple failure exits and a
// leaked MPQ handle keeps the file locked on Windows.
class ArchiveHandle {
public:
    ArchiveHandle() = default;
    ArchiveHandle(const ArchiveHandle&) = delete;
    ArchiveHandle& operator=(const ArchiveHandle&) = delete;
    ~ArchiveHandle() { close(); }

    bool openRead(const std::filesystem::path& path) {
        close();
        return SFileOpenArchive(path.c_str(), 0, MPQ_OPEN_READ_ONLY, &handle_);
    }
    void adopt(HANDLE handle) { close(); handle_ = handle; }
    void close() {
        if (handle_ != nullptr) {
            SFileCloseArchive(handle_);
            handle_ = nullptr;
        }
    }
    HANDLE get() const { return handle_; }
    HANDLE* address() { return &handle_; }

private:
    HANDLE handle_ = nullptr;
};

class FileHandle {
public:
    FileHandle() = default;
    FileHandle(const FileHandle&) = delete;
    FileHandle& operator=(const FileHandle&) = delete;
    ~FileHandle() { close(); }

    void close() {
        if (handle_ != nullptr) {
            SFileCloseFile(handle_);
            handle_ = nullptr;
        }
    }
    HANDLE get() const { return handle_; }
    HANDLE* address() { return &handle_; }

private:
    HANDLE handle_ = nullptr;
};

std::uint32_t readDwordInfo(HANDLE target, SFileInfoClass infoClass, std::uint32_t fallback = 0) {
    DWORD value = 0;
    DWORD needed = 0;
    if (SFileGetFileInfo(target, infoClass, &value, sizeof(value), &needed)) {
        return static_cast<std::uint32_t>(value);
    }
    return fallback;
}

struct ArchiveEntry {
    std::string path;   // As stored in the archive, forward-slash normalised for output.
    std::string rawPath;// Exactly as StormLib reported it; needed to reopen the file.
    std::uint32_t size = 0;
    std::uint32_t compressedSize = 0;
    std::uint32_t flags = 0;
    std::uint32_t locale = 0;
};

// Enumerates archive members.
//
// Enumeration depends on `(listfile)`. An archive without one yields nothing, which is a
// real and reportable state — not an empty archive — so `listfilePresent` is returned
// separately rather than folded into the count.
bool enumerate(HANDLE archive, std::vector<ArchiveEntry>& entries, bool& listfilePresent, std::string& error) {
    listfilePresent = SFileHasFile(archive, LISTFILE_NAME);

    SFILE_FIND_DATA findData{};
    HANDLE find = SFileFindFirstFile(archive, "*", &findData, nullptr);
    if (find == nullptr) {
        const int code = static_cast<int>(GetLastError());
        if (code == ERROR_NO_MORE_FILES) return true;  // Genuinely empty.
        error = lastErrorText();
        return false;
    }

    do {
        ArchiveEntry entry;
        entry.rawPath = findData.cFileName;
        std::string normalized = entry.rawPath;
        std::replace(normalized.begin(), normalized.end(), '\\', '/');
        entry.path = normalized;
        entry.size = static_cast<std::uint32_t>(findData.dwFileSize);
        entry.compressedSize = static_cast<std::uint32_t>(findData.dwCompSize);
        entry.flags = static_cast<std::uint32_t>(findData.dwFileFlags);
        entry.locale = static_cast<std::uint32_t>(findData.lcLocale);
        entries.push_back(std::move(entry));
    } while (SFileFindNextFile(find, &findData));

    SFileFindClose(find);

    // Deterministic output regardless of hash-table order (PLAN.md §10).
    std::sort(entries.begin(), entries.end(), [](const ArchiveEntry& left, const ArchiveEntry& right) {
        return left.path < right.path;
    });
    return true;
}

// Reads one member fully into memory.
bool readMember(HANDLE archive, const std::string& name, std::vector<char>& buffer, std::string& error) {
    FileHandle file;
    if (!SFileOpenFileEx(archive, name.c_str(), 0, file.address())) {
        error = lastErrorText();
        return false;
    }

    DWORD sizeHigh = 0;
    const DWORD sizeLow = SFileGetFileSize(file.get(), &sizeHigh);
    if (sizeLow == SFILE_INVALID_SIZE) {
        error = lastErrorText();
        return false;
    }
    if (sizeHigh != 0) {
        // A >4 GiB member inside an SC2 document is not a thing; treat it as corruption
        // rather than attempting an allocation that would fail anyway.
        error = "member is larger than 4 GiB";
        return false;
    }

    buffer.resize(sizeLow);
    if (sizeLow == 0) return true;

    DWORD read = 0;
    if (!SFileReadFile(file.get(), buffer.data(), sizeLow, &read, nullptr) || read != sizeLow) {
        error = lastErrorText();
        return false;
    }
    return true;
}

// Collects files under `root`, sorted by archive path.
//
// Symlinks are not followed, matching the TypeScript walker: a link inside a staged
// document must not let a pack reach outside it.
bool collectFiles(const std::filesystem::path& root, std::vector<std::filesystem::path>& files, std::string& error) {
    std::error_code ec;
    auto iterator = std::filesystem::recursive_directory_iterator(
        root, std::filesystem::directory_options::skip_permission_denied, ec);
    if (ec) {
        error = ec.message();
        return false;
    }

    for (const auto& entry : iterator) {
        if (entry.is_symlink()) continue;
        if (!entry.is_regular_file()) continue;
        files.push_back(entry.path());
    }

    std::sort(files.begin(), files.end(), [&root](const std::filesystem::path& left, const std::filesystem::path& right) {
        return toArchivePath(root, left) < toArchivePath(root, right);
    });
    return true;
}

}  // namespace

int emitError(const std::string& code, const std::string& message, const std::string& path) {
    JsonWriter json(std::cout);
    json.beginObject();
    json.field("ok", false);
    json.field("code", code);
    json.field("message", message);
    if (path.empty()) {
        json.nullField("path");
    } else {
        json.field("path", path);
    }
    json.endObject();
    std::cout << '\n';
    return 1;
}

int commandVersion() {
    JsonWriter json(std::cout);
    json.beginObject();
    json.field("ok", true);
    json.field("tool", "sc2mpq");
    json.field("version", SC2MPQ_VERSION);
    json.field("protocolVersion", static_cast<std::uint32_t>(SC2MPQ_PROTOCOL_VERSION));
    json.field("stormLib", "9.40");
    json.endObject();
    std::cout << '\n';
    return 0;
}

int commandInfo(const std::filesystem::path& archive) {
    ArchiveHandle mpq;
    if (!mpq.openRead(archive)) {
        return emitError("SC2MPQ_OPEN_FAILED", "Cannot open archive: " + lastErrorText(), toUtf8(archive));
    }

    const std::uint32_t formatVersion = readDwordInfo(mpq.get(), SFileMpqHeaderSize) == 32 ? 1u : 0u;
    const std::uint32_t sectorSize = readDwordInfo(mpq.get(), SFileMpqSectorSize);
    const std::uint32_t fileCount = readDwordInfo(mpq.get(), SFileMpqNumberOfFiles);
    const std::uint32_t maxFileCount = readDwordInfo(mpq.get(), SFileMpqMaxFileCount);

    ULONGLONG userDataOffset = 0;
    DWORD needed = 0;
    const bool hasUserData =
        SFileGetFileInfo(mpq.get(), SFileMpqUserDataOffset, &userDataOffset, sizeof(userDataOffset), &needed);

    std::error_code ec;
    const auto sizeBytes = std::filesystem::file_size(archive, ec);

    JsonWriter json(std::cout);
    json.beginObject();
    json.field("ok", true);
    // `formatVersion` above is a crude v1 test from the header size; the authoritative
    // value is the header's wFormatVersion, which StormLib does not expose as a scalar.
    // Reporting the header size lets the caller decide rather than trusting a guess.
    json.field("headerSizeIsV1", formatVersion == 1);
    json.field("sectorSize", sectorSize);
    json.field("fileCount", fileCount);
    json.field("maxFileCount", maxFileCount);
    json.field("hasUserData", hasUserData);
    json.field("hasListfile", static_cast<bool>(SFileHasFile(mpq.get(), LISTFILE_NAME)));
    json.field("hasAttributes", static_cast<bool>(SFileHasFile(mpq.get(), ATTRIBUTES_NAME)));
    json.field("sizeBytes", ec ? std::uint64_t{0} : static_cast<std::uint64_t>(sizeBytes));
    json.endObject();
    std::cout << '\n';
    return 0;
}

int commandList(const std::filesystem::path& archive) {
    ArchiveHandle mpq;
    if (!mpq.openRead(archive)) {
        return emitError("SC2MPQ_OPEN_FAILED", "Cannot open archive: " + lastErrorText(), toUtf8(archive));
    }

    std::vector<ArchiveEntry> entries;
    bool listfilePresent = false;
    std::string error;
    if (!enumerate(mpq.get(), entries, listfilePresent, error)) {
        return emitError("SC2MPQ_LIST_FAILED", "Cannot enumerate archive: " + error, toUtf8(archive));
    }

    const std::uint32_t headerCount = readDwordInfo(mpq.get(), SFileMpqNumberOfFiles);

    JsonWriter json(std::cout);
    json.beginObject();
    json.field("ok", true);
    json.field("listfilePresent", listfilePresent);
    json.field("enumeratedCount", static_cast<std::uint64_t>(entries.size()));
    // When these disagree the archive holds members whose names we do not know. Saying so
    // is the whole point; a caller that repacked from this list would silently drop them.
    json.field("headerFileCount", headerCount);
    json.key("files");
    json.beginArray();
    for (const ArchiveEntry& entry : entries) {
        json.beginObject();
        json.field("path", entry.path);
        json.field("size", entry.size);
        json.field("compressedSize", entry.compressedSize);
        json.field("flags", entry.flags);
        json.field("locale", entry.locale);
        json.endObject();
    }
    json.endArray();
    json.endObject();
    std::cout << '\n';
    return 0;
}

int commandExtract(const std::filesystem::path& archive, const std::filesystem::path& destination) {
    ArchiveHandle mpq;
    if (!mpq.openRead(archive)) {
        return emitError("SC2MPQ_OPEN_FAILED", "Cannot open archive: " + lastErrorText(), toUtf8(archive));
    }

    std::vector<ArchiveEntry> entries;
    bool listfilePresent = false;
    std::string error;
    if (!enumerate(mpq.get(), entries, listfilePresent, error)) {
        return emitError("SC2MPQ_LIST_FAILED", "Cannot enumerate archive: " + error, toUtf8(archive));
    }

    std::error_code ec;
    std::filesystem::create_directories(destination, ec);
    if (ec) {
        return emitError("SC2MPQ_IO_FAILED", "Cannot create destination: " + ec.message(), toUtf8(destination));
    }

    struct Extracted { std::string path; std::uint64_t size; };
    struct Failure { std::string path; std::string reason; };
    std::vector<Extracted> extracted;
    std::vector<Failure> failures;

    for (const ArchiveEntry& entry : entries) {
        // Internal bookkeeping files are archive metadata, not document content. They are
        // regenerated on pack, so extracting them would make a round-trip look lossy.
        if (entry.path == LISTFILE_NAME || entry.path == ATTRIBUTES_NAME ||
            entry.path == SIGNATURE_NAME || entry.path == PATCH_METADATA_NAME) {
            continue;
        }

        std::filesystem::path target;
        const PathResult resolved = resolveWithin(destination, entry.path, target);
        if (!resolved.ok) {
            failures.push_back({entry.path, resolved.reason});
            continue;
        }

        std::vector<char> buffer;
        std::string readError;
        if (!readMember(mpq.get(), entry.rawPath, buffer, readError)) {
            failures.push_back({entry.path, readError});
            continue;
        }

        std::filesystem::create_directories(target.parent_path(), ec);
        if (ec) {
            failures.push_back({entry.path, "cannot create parent directory: " + ec.message()});
            ec.clear();
            continue;
        }

        std::ofstream out(target, std::ios::binary | std::ios::trunc);
        if (!out) {
            failures.push_back({entry.path, "cannot open output file for writing"});
            continue;
        }
        if (!buffer.empty()) out.write(buffer.data(), static_cast<std::streamsize>(buffer.size()));
        out.close();
        if (!out) {
            failures.push_back({entry.path, "write failed"});
            continue;
        }

        extracted.push_back({resolved.value, static_cast<std::uint64_t>(buffer.size())});
    }

    JsonWriter json(std::cout);
    json.beginObject();
    // Any failure makes the whole extraction untrustworthy. PLAN.md §10 forbids silently
    // skipping files, so a partial extraction reports ok:false and lists what went wrong.
    json.field("ok", failures.empty());
    json.field("listfilePresent", listfilePresent);
    json.field("extractedCount", static_cast<std::uint64_t>(extracted.size()));
    json.key("files");
    json.beginArray();
    for (const Extracted& item : extracted) {
        json.beginObject();
        json.field("path", item.path);
        json.field("size", item.size);
        json.endObject();
    }
    json.endArray();
    json.key("failures");
    json.beginArray();
    for (const Failure& failure : failures) {
        json.beginObject();
        json.field("path", failure.path);
        json.field("reason", failure.reason);
        json.endObject();
    }
    json.endArray();
    json.endObject();
    std::cout << '\n';
    return failures.empty() ? 0 : 1;
}

int commandPack(const std::filesystem::path& sourceDir, const std::filesystem::path& output, const PackOptions& options) {
    std::error_code ec;
    if (!std::filesystem::is_directory(sourceDir, ec)) {
        return emitError("SC2MPQ_INVALID_ARGUMENT", "Source is not a directory.", toUtf8(sourceDir));
    }

    std::vector<std::filesystem::path> files;
    std::string error;
    if (!collectFiles(sourceDir, files, error)) {
        return emitError("SC2MPQ_IO_FAILED", "Cannot read source directory: " + error, toUtf8(sourceDir));
    }
    if (files.empty()) {
        return emitError("SC2MPQ_INVALID_ARGUMENT", "Source directory contains no files.", toUtf8(sourceDir));
    }

    // Validate every path before creating the output, so an unusable name fails without
    // leaving a half-written archive behind.
    std::vector<std::string> archiveNames;
    archiveNames.reserve(files.size());
    for (const std::filesystem::path& file : files) {
        const std::string candidate = toArchivePath(sourceDir, file);
        const PathResult normalized = normalizeArchivePath(candidate);
        if (!normalized.ok) {
            return emitError("SC2MPQ_INVALID_PATH", "Cannot store this path in an archive: " + normalized.reason, candidate);
        }
        archiveNames.push_back(normalized.value);
    }

    std::filesystem::create_directories(output.parent_path(), ec);
    ec.clear();
    std::filesystem::remove(output, ec);
    ec.clear();

    SFILE_CREATE_MPQ createInfo{};
    createInfo.cbSize = sizeof(createInfo);
    createInfo.dwMpqVersion = options.mpqVersion == 0 ? MPQ_FORMAT_VERSION_1 : options.mpqVersion - 1;
    createInfo.dwStreamFlags = STREAM_PROVIDER_FLAT | BASE_PROVIDER_FILE;
    // Regenerate (listfile) so the result can be enumerated again. Without it the archive
    // is readable by the game but opaque to every tool, including this one.
    createInfo.dwFileFlags1 = MPQ_FILE_DEFAULT_INTERNAL;
    createInfo.dwFileFlags2 = 0;  // No (attributes): it stores timestamps, which are not reproducible.
    createInfo.dwFileFlags3 = 0;  // No (signature).
    createInfo.dwAttrFlags = 0;
    createInfo.dwSectorSize = options.sectorSize;
    createInfo.dwRawChunkSize = 0;
    createInfo.dwMaxFileCount = options.maxFileCount != 0
        ? options.maxFileCount
        // Headroom for (listfile) and hash-table growth; StormLib rounds up to a power of two.
        : static_cast<DWORD>(files.size() + 16);

    ArchiveHandle mpq;
    if (!SFileCreateArchive2(output.c_str(), &createInfo, mpq.address())) {
        return emitError("SC2MPQ_CREATE_FAILED", "Cannot create archive: " + lastErrorText(), toUtf8(output));
    }

    struct Packed { std::string path; std::uint64_t size; };
    std::vector<Packed> packed;

    for (std::size_t index = 0; index < files.size(); ++index) {
        const std::filesystem::path& file = files[index];
        const std::string& archiveName = archiveNames[index];

        // MPQ stores paths with backslashes. The forward-slash form is our external
        // representation; converting here keeps the on-disk archive conventional.
        std::string storedName = archiveName;
        std::replace(storedName.begin(), storedName.end(), '/', '\\');

        const auto size = std::filesystem::file_size(file, ec);
        if (ec) {
            mpq.close();
            std::filesystem::remove(output, ec);
            return emitError("SC2MPQ_IO_FAILED", "Cannot stat source file.", archiveName);
        }

        if (!SFileAddFileEx(mpq.get(), file.c_str(), storedName.c_str(),
                            MPQ_FILE_COMPRESS | MPQ_FILE_REPLACEEXISTING,
                            MPQ_COMPRESSION_ZLIB, MPQ_COMPRESSION_NEXT_SAME)) {
            const std::string reason = lastErrorText();
            mpq.close();
            // A partial archive is worse than no archive: it looks openable but is not
            // the document the caller asked for.
            std::filesystem::remove(output, ec);
            return emitError("SC2MPQ_PACK_FAILED", "Cannot add file to archive: " + reason, archiveName);
        }

        packed.push_back({archiveName, static_cast<std::uint64_t>(size)});
    }

    if (!SFileFlushArchive(mpq.get())) {
        const std::string reason = lastErrorText();
        mpq.close();
        std::filesystem::remove(output, ec);
        return emitError("SC2MPQ_PACK_FAILED", "Cannot flush archive: " + reason, toUtf8(output));
    }
    mpq.close();

    const auto outputSize = std::filesystem::file_size(output, ec);

    JsonWriter json(std::cout);
    json.beginObject();
    json.field("ok", true);
    json.field("output", toUtf8(output));
    json.field("fileCount", static_cast<std::uint64_t>(packed.size()));
    json.field("sectorSize", options.sectorSize);
    json.field("sizeBytes", ec ? std::uint64_t{0} : static_cast<std::uint64_t>(outputSize));
    json.key("files");
    json.beginArray();
    for (const Packed& item : packed) {
        json.beginObject();
        json.field("path", item.path);
        json.field("size", item.size);
        json.endObject();
    }
    json.endArray();
    json.endObject();
    std::cout << '\n';
    return 0;
}

int commandVerify(const std::filesystem::path& archive) {
    ArchiveHandle mpq;
    if (!mpq.openRead(archive)) {
        return emitError("SC2MPQ_OPEN_FAILED", "Cannot open archive: " + lastErrorText(), toUtf8(archive));
    }

    std::vector<ArchiveEntry> entries;
    bool listfilePresent = false;
    std::string error;
    if (!enumerate(mpq.get(), entries, listfilePresent, error)) {
        return emitError("SC2MPQ_LIST_FAILED", "Cannot enumerate archive: " + error, toUtf8(archive));
    }

    struct Failure { std::string path; std::string reason; };
    std::vector<Failure> failures;
    std::uint64_t readable = 0;
    std::uint64_t totalBytes = 0;

    // Every member is read in full, not sampled. PLAN.md §10 asks for "representative"
    // files, but a document that fails to decompress one file is broken, and these
    // archives are small enough that full verification costs little.
    for (const ArchiveEntry& entry : entries) {
        std::vector<char> buffer;
        std::string readError;
        if (!readMember(mpq.get(), entry.rawPath, buffer, readError)) {
            failures.push_back({entry.path, readError});
            continue;
        }
        if (buffer.size() != entry.size) {
            failures.push_back({entry.path, "read " + std::to_string(buffer.size()) +
                                            " bytes but the table says " + std::to_string(entry.size)});
            continue;
        }
        readable += 1;
        totalBytes += buffer.size();
    }

    JsonWriter json(std::cout);
    json.beginObject();
    json.field("ok", failures.empty());
    json.field("listfilePresent", listfilePresent);
    json.field("enumeratedCount", static_cast<std::uint64_t>(entries.size()));
    json.field("readableCount", readable);
    json.field("totalBytes", totalBytes);
    json.key("failures");
    json.beginArray();
    for (const Failure& failure : failures) {
        json.beginObject();
        json.field("path", failure.path);
        json.field("reason", failure.reason);
        json.endObject();
    }
    json.endArray();
    json.endObject();
    std::cout << '\n';
    return failures.empty() ? 0 : 1;
}

}  // namespace sc2mpq
