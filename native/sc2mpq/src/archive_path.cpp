#include "archive_path.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <vector>

namespace sc2mpq {
namespace {

const std::array<const char*, 22> kReservedNames = {
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
};

std::string toLower(std::string text) {
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    return text;
}

bool isReservedName(const std::string& segment) {
    const std::string stem = toLower(segment.substr(0, segment.find('.')));
    return std::find_if(kReservedNames.begin(), kReservedNames.end(), [&](const char* reserved) {
               return stem == reserved;
           }) != kReservedNames.end();
}

PathResult rejected(std::string reason) {
    PathResult result;
    result.ok = false;
    result.reason = std::move(reason);
    return result;
}

}  // namespace

PathResult normalizeArchivePath(const std::string& archivePath) {
    if (archivePath.empty()) return rejected("archive path is empty");
    if (archivePath.find('\0') != std::string::npos) return rejected("archive path contains a NUL byte");

    std::string unified = archivePath;
    std::replace(unified.begin(), unified.end(), '\\', '/');

    if (unified.front() == '/') return rejected("archive path is absolute");
    if (unified.size() >= 2 && unified[1] == ':' && std::isalpha(static_cast<unsigned char>(unified[0]))) {
        return rejected("archive path contains a drive letter");
    }

    std::vector<std::string> segments;
    std::string current;
    for (const char character : unified) {
        if (character != '/') {
            current.push_back(character);
            continue;
        }
        if (!current.empty() && current != ".") {
            if (current == "..") return rejected("archive path contains a traversal segment");
            segments.push_back(current);
        }
        current.clear();
    }
    if (!current.empty() && current != ".") {
        if (current == "..") return rejected("archive path contains a traversal segment");
        segments.push_back(current);
    }

    if (segments.empty()) return rejected("archive path is empty after normalisation");

    for (const std::string& segment : segments) {
        // These are checked on every platform, not just Windows: an archive extracted on
        // Linux may later be repacked and opened on Windows, and a name that is legal in
        // one place and silently mangled in the other breaks round-tripping.
        if (segment.find_first_of("<>:\"|?*") != std::string::npos) {
            return rejected("archive path segment contains a character Windows forbids: " + segment);
        }
        for (const char character : segment) {
            if (static_cast<unsigned char>(character) < 0x20) {
                return rejected("archive path segment contains a control character: " + segment);
            }
        }
        if (segment.back() == '.' || segment.back() == ' ') {
            return rejected("archive path segment ends with a dot or space, which Windows strips: " + segment);
        }
        if (isReservedName(segment)) {
            return rejected("archive path segment is a reserved device name: " + segment);
        }
    }

    PathResult result;
    result.ok = true;
    for (std::size_t index = 0; index < segments.size(); ++index) {
        if (index > 0) result.value.push_back('/');
        result.value += segments[index];
    }
    return result;
}

PathResult resolveWithin(const std::filesystem::path& destination, const std::string& archivePath,
                         std::filesystem::path& resolved) {
    const PathResult normalized = normalizeArchivePath(archivePath);
    if (!normalized.ok) return normalized;

    const std::filesystem::path root = destination.lexically_normal();
    std::filesystem::path candidate = root;

    std::string segment;
    for (const char character : normalized.value) {
        if (character == '/') {
            candidate /= fromUtf8(segment);
            segment.clear();
        } else {
            segment.push_back(character);
        }
    }
    candidate /= fromUtf8(segment);
    candidate = candidate.lexically_normal();

    // Belt and braces: normalizeArchivePath already rejected traversal, but the
    // containment check is what actually guarantees the invariant, so it is not skipped.
    const auto relative = candidate.lexically_relative(root);
    if (relative.empty() || *relative.begin() == "..") {
        return rejected("archive member would extract outside the destination");
    }

    resolved = candidate;
    return normalized;
}

std::string toArchivePath(const std::filesystem::path& root, const std::filesystem::path& file) {
    const std::filesystem::path relative = file.lexically_relative(root);
    std::string result;
    for (const auto& segment : relative) {
        const std::string text = toUtf8(segment);
        if (text.empty() || text == ".") continue;
        if (!result.empty()) result.push_back('/');
        result += text;
    }
    return result;
}

std::filesystem::path fromUtf8(const std::string& utf8) {
    return std::filesystem::path(std::u8string(utf8.begin(), utf8.end()));
}

std::string toUtf8(const std::filesystem::path& path) {
    const std::u8string encoded = path.u8string();
    return std::string(encoded.begin(), encoded.end());
}

}  // namespace sc2mpq
