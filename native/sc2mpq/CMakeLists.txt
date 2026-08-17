cmake_minimum_required(VERSION 3.20)

project(sc2mpq VERSION 0.1.0 LANGUAGES C CXX)

# C++20 for std::u8string, which is what makes UTF-8 <-> native path conversion explicit
# rather than an encoding assumption.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

# The sidecar protocol version. The TypeScript adapter refuses a helper that reports a
# different value: a silently mismatched sidecar is how a repack corrupts a map.
set(SC2MPQ_PROTOCOL_VERSION 1)

set(STORMLIB_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/StormLib")
if(NOT EXISTS "${STORMLIB_DIR}/CMakeLists.txt")
    message(FATAL_ERROR
        "StormLib is missing from ${STORMLIB_DIR}.\n"
        "Run scripts/bootstrap.ps1 to fetch the pinned source (see vendor/PINS.json).")
endif()

# Static, no install rules, no upstream tests: this is a vendored build we consume
# directly, not a system dependency.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(STORM_SKIP_INSTALL ON CACHE BOOL "" FORCE)
set(STORM_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(STORM_USE_BUNDLED_LIBRARIES ON CACHE BOOL "" FORCE)

if(WIN32)
    # Map paths routinely contain non-ASCII characters (user names, map titles), so the
    # ANSI build is not an option on Windows.
    #
    # StormLib applies UNICODE/_UNICODE as PRIVATE definitions, meaning they do NOT
    # propagate to consumers. If we compiled without them, StormLib's exported functions
    # would take wchar_t* while our translation unit read the header as char* — an ABI
    # mismatch the compiler cannot see. So we set the same definitions on our target
    # below, and the two must be changed together.
    set(STORM_UNICODE ON CACHE BOOL "" FORCE)
endif()

add_subdirectory("${STORMLIB_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/stormlib" EXCLUDE_FROM_ALL)

add_executable(sc2mpq
    src/main.cpp
    src/commands.cpp
    src/archive_path.cpp
)

target_include_directories(sc2mpq PRIVATE src)
target_link_libraries(sc2mpq PRIVATE storm)

target_compile_definitions(sc2mpq PRIVATE
    SC2MPQ_VERSION="${PROJECT_VERSION}"
    SC2MPQ_PROTOCOL_VERSION=${SC2MPQ_PROTOCOL_VERSION}
)

if(WIN32)
    # Must match the STORM_UNICODE setting above; see the comment there.
    target_compile_definitions(sc2mpq PRIVATE UNICODE _UNICODE)
endif()

if(MSVC)
    target_compile_options(sc2mpq PRIVATE /W4 /permissive- /utf-8)
    # This program's whole job is handling untrusted archive contents, so the usual
    # Windows hardening flags are not optional.
    target_compile_options(sc2mpq PRIVATE /GS /guard:cf)
    target_link_options(sc2mpq PRIVATE /DYNAMICBASE /NXCOMPAT /guard:cf)
else()
    target_compile_options(sc2mpq PRIVATE -Wall -Wextra -Wpedantic)
endif()

# Land the binary somewhere the TypeScript adapter can find without a config entry.
set_target_properties(sc2mpq PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_SOURCE_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_CURRENT_SOURCE_DIR}/bin"
)
