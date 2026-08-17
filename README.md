# SC2 Map Editor MCP

An MCP server that lets a coding agent inspect and edit StarCraft II maps and mods by
manipulating their file contents directly, instead of driving the Galaxy Editor UI.

**Status: early. See [Current capabilities](#current-capabilities) before relying on
anything.** The build plan is [PLAN.md](PLAN.md); this README describes what exists
today, which is a small fraction of it.

## Current capabilities

The server reports this itself via `sc2_get_server_info` — that is the authoritative
answer for a running build. As of now:

| Subsystem | Read | Write | Notes |
|---|---|---|---|
| Workspace staging | ✅ | ✅ | Unpacked document directories only |
| Component inventory | ✅ | ❌ | `ComponentList`, `DocumentInfo`, dependencies — verified against real editor output |
| MPQ archives (`.SC2Map`, `.SC2Mod`) | ⚠️ | ❌ | Code complete but **never compiled** — see [docs/native-helper.md](docs/native-helper.md) |
| GameData catalogs | ❌ | ❌ | Phase 5–6 |
| Galaxy scripts | ❌ | ❌ | Phase 5, 9 |
| Triggers | ❌ | ❌ | Phase 11 |
| Localization | ❌ | ❌ | Phase 10 |
| SC2Layout | ❌ | ❌ | Phase 10 |
| Placed objects / regions | ❌ | ❌ | Phase 15 |
| Terrain | ❌ | ❌ | Phase 16 |
| Editor launch / test | ❌ | ❌ | Phase 13 (installation *detection* works) |

Raw text search and file reading work on any staged document, so the server is already
useful for inspecting an unpacked map — just not for understanding it semantically.

⚠️ The `sc2mpq` helper that reads packed archives is written and wired in, but building it
needs a C++ toolchain plus the Windows SDK, which was unavailable on the machine this was
developed on. Until it is compiled and round-trip tested, `sc2_open_document` refuses
packed archives with a clear error, and `capabilities.mpq` reports `false`.

### Tools

| Tool | Read-only | Purpose |
|---|---|---|
| `sc2_get_server_info` | yes | Versions, configuration, capability matrix, limitations |
| `sc2_detect_installations` | yes | Find StarCraft II without scanning the disk |
| `sc2_open_document` | no | Stage a document, get a `workspace_id` |
| `sc2_get_document_summary` | yes | Kind, counts, components, dependencies, diagnostics, known gaps |
| `sc2_list_workspaces` | yes | Recover a `workspace_id` after a reconnect |
| `sc2_list_components` | yes | Parse `ComponentList.SC2Components`; resolve each entry to real files |
| `sc2_get_document_info` | yes | Name, author, mod type, icon, screenshots, dependencies |
| `sc2_get_dependencies` | yes | Dependency chain in resolution order |
| `sc2_list_component_types` | yes | Reference table of component type codes |
| `sc2_list_files` | yes | Paginated listing of the staged tree |
| `sc2_read_file` | yes | Read one staged file (text, or base64 for binary) |
| `sc2_search_files` | yes | Literal substring search across staged text files |
| `sc2_discard_workspace` | no | Delete the staging copy; source untouched |

## The safety model

This is a program that edits your maps on a language model's instructions, so the
defaults are conservative:

- **Your source is never modified.** `sc2_open_document` copies the document into a
  server-owned staging directory. Every edit lands there. Writing back is a separate,
  explicit commit step (not yet implemented).
- **Paths are allowlisted.** Nothing outside `allowedRoots` can be read or written.
  Paths are canonicalised first, so symlinks cannot be used to escape.
- **Nothing runs a shell.** External programs are spawned with argument arrays, a
  timeout, and a trimmed environment. There is no "run this command" tool.
- **Unimplemented means unimplemented.** A capability flag is only `true` when the code
  exists *and* its backend is present on this machine. The server would rather tell you
  it cannot do something than guess.

## Requirements

- Node.js 22 or newer (developed against 26)
- pnpm 10
- Windows, for anything involving StarCraft II itself. The core is cross-platform;
  editor integration is not.

## Getting started

```bash
pnpm install
```

```bash
pnpm run verify
```

`verify` runs lint, typecheck, build, and the full test suite — including an
integration test that spawns the built server as a real child process and speaks MCP to
it over stdio.

Create a config file (see [docs/configuration.md](docs/configuration.md)):

```bash
node apps/sc2-mcp-server/dist/main.js doctor
```

`doctor` prints the resolved configuration, the detected StarCraft II installation, and
the capability matrix. It exits non-zero when the server would be unable to do anything
useful — for example when no allowed roots are configured.

### Connecting an MCP client

The server speaks MCP over stdio. Point your client at the built entry point:

```json
{
  "mcpServers": {
    "sc2": {
      "command": "node",
      "args": ["C:\\path\\to\\SC2EditorMCP\\apps\\sc2-mcp-server\\dist\\main.js"],
      "env": {
        "SC2MCP_ALLOWED_ROOTS": "C:\\Users\\me\\OneDrive\\Documents\\StarCraft II\\Maps"
      }
    }
  }
}
```

## Repository layout

```text
apps/sc2-mcp-server/     MCP protocol layer: tools, schemas, error translation, stdio entry
packages/sc2-core/       Domain layer: config, path guard, workspace staging, MPQ adapter
packages/sc2-test-utils/ Test fixtures and temp-directory helpers
native/sc2mpq/           C++ MPQ sidecar (StormLib), built separately
docs/adr/                Architecture decision records
vendor/PINS.json         Pinned upstream sources (checkouts are gitignored)
scripts/                 bootstrap.ps1 (fetch pins), build-native.ps1 (build the sidecar)
tests/                   Cross-package integration tests
```

The layering rule (PLAN.md §4): tool handlers validate input, call a domain service, and
translate the result. SC2 parsing never lives in a tool handler.

## Licensing and content

No Blizzard assets, extracted game data, or copyrighted map content is included in this
repository, and none will be. Test fixtures are project-authored placeholders — useful
for exercising staging and transaction machinery, useless for validating format
parsers, which must be checked against real editor output.
