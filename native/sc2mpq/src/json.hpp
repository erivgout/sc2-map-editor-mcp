// Minimal JSON writer.
//
// stdout is a machine-readable channel consumed by the TypeScript adapter, so escaping
// has to be right; a stray quote or control byte in an archive-supplied filename would
// otherwise produce output the caller cannot parse. Pulling in a full JSON library for
// a program that only ever *writes* JSON is not worth the dependency.
//
// Input strings are assumed to be UTF-8. Bytes >= 0x80 are passed through unchanged,
// which is correct for valid UTF-8 and preserves invalid sequences rather than
// corrupting them further.

#pragma once

#include <cstdint>
#include <ostream>
#include <string>
#include <vector>

namespace sc2mpq {

inline void writeJsonString(std::ostream& out, const std::string& value) {
    out << '"';
    for (const char rawChar : value) {
        const auto byte = static_cast<unsigned char>(rawChar);
        switch (byte) {
            case '"':  out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\b': out << "\\b";  break;
            case '\f': out << "\\f";  break;
            case '\n': out << "\\n";  break;
            case '\r': out << "\\r";  break;
            case '\t': out << "\\t";  break;
            default:
                if (byte < 0x20) {
                    // JSON forbids raw control characters; emit the \u escape.
                    static const char* kHex = "0123456789abcdef";
                    out << "\\u00" << kHex[(byte >> 4) & 0x0F] << kHex[byte & 0x0F];
                } else {
                    out << rawChar;
                }
                break;
        }
    }
    out << '"';
}

// Builds a JSON object or array incrementally.
//
// Deliberately dumb: it tracks only whether a separator is needed. Correct nesting is
// the caller's responsibility, which is acceptable for a handful of fixed output shapes
// and keeps the whole thing auditable at a glance.
class JsonWriter {
public:
    explicit JsonWriter(std::ostream& out) : out_(out) {}

    void beginObject() { separate(); out_ << '{'; needsComma_.push_back(false); }
    void endObject()   { out_ << '}'; needsComma_.pop_back(); markWritten(); }
    void beginArray()  { separate(); out_ << '['; needsComma_.push_back(false); }
    void endArray()    { out_ << ']'; needsComma_.pop_back(); markWritten(); }

    void key(const std::string& name) {
        separate();
        writeJsonString(out_, name);
        out_ << ':';
        // A key is followed immediately by its value, with no comma between them.
        if (!needsComma_.empty()) needsComma_.back() = false;
    }

    void value(const std::string& text) { separate(); writeJsonString(out_, text); markWritten(); }
    void value(const char* text)        { value(std::string(text)); }
    void value(bool flag)               { separate(); out_ << (flag ? "true" : "false"); markWritten(); }
    void value(std::uint64_t number)    { separate(); out_ << number; markWritten(); }
    void value(std::int64_t number)     { separate(); out_ << number; markWritten(); }
    void value(std::uint32_t number)    { value(static_cast<std::uint64_t>(number)); }
    void nullValue()                    { separate(); out_ << "null"; markWritten(); }

    void field(const std::string& name, const std::string& text) { key(name); value(text); }
    void field(const std::string& name, const char* text)        { key(name); value(text); }
    void field(const std::string& name, bool flag)               { key(name); value(flag); }
    void field(const std::string& name, std::uint64_t number)    { key(name); value(number); }
    void field(const std::string& name, std::uint32_t number)    { key(name); value(number); }
    void nullField(const std::string& name)                      { key(name); nullValue(); }

private:
    void separate() {
        if (!needsComma_.empty() && needsComma_.back()) out_ << ',';
    }
    void markWritten() {
        if (!needsComma_.empty()) needsComma_.back() = true;
    }

    std::ostream& out_;
    std::vector<bool> needsComma_;
};

}  // namespace sc2mpq
