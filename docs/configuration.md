# Configuration

## Where configuration comes from

Layers, lowest priority first:

1. Built-in defaults
2. A JSON config file
3. `SC2MCP_*` environment variables

The config file is located by, in order:

1. `--config <path>` on the command line
2. `$SC2MCP_CONFIG`
3. `%LOCALAPPDATA%\sc2-map-editor-mcp\config.json` (Windows) or
   `$XDG_STATE_HOME/sc2-map-editor-mcp/config.json` (elsewhere)

A missing file at the default location is fine — defaults are used. A missing file at a
path you asked for explicitly is an error, because silently ignoring it would hide a
typo in a security-relevant setting.

Unknown keys are rejected rather than ignored, for the same reason.

## Keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `allowedRoots` | `string[]` | `[]` | Absolute directories the server may read and write under. **Empty means every path is denied.** |
| `workspaceRoot` | `string` | `%LOCALAPPDATA%\sc2-map-editor-mcp` | Server-owned state: staged workspaces, snapshots, change history, logs. |
| `sc2InstallPath` | `string \| null` | `null` | StarCraft II installation root. `null` autodetects. |
| `mpqHelperPath` | `string \| null` | `null` | Path to the `sc2mpq` sidecar. `null` searches the repository's native helper output. |
| `defaultLocale` | `string` | `"enUS"` | Locale assumed when a tool does not name one. |
| `allowOverwrite` | `boolean` | `false` | Whether commit may overwrite an existing output file. |
| `maxArchiveBytes` | `number` | `2147483648` | Refuse archives larger than this. |
| `maxExtractedFiles` | `number` | `50000` | Refuse documents with more files than this. |
| `maxSingleFileBytes` | `number` | `268435456` | Refuse individual files larger than this. |
| `processTimeoutMs` | `number` | `120000` | Wall-clock limit for any spawned external process. |
| `logLevel` | `"trace" \| "debug" \| "info" \| "warn" \| "error"` | `"info"` | Verbosity of the stderr log. |

## Environment variables

Each overrides the corresponding file key:

| Variable | Key |
|---|---|
| `SC2MCP_ALLOWED_ROOTS` | `allowedRoots` — separated by `;` on Windows, `:` elsewhere |
| `SC2MCP_WORKSPACE_ROOT` | `workspaceRoot` |
| `SC2MCP_SC2_INSTALL_PATH` | `sc2InstallPath` |
| `SC2MCP_MPQ_HELPER_PATH` | `mpqHelperPath` |
| `SC2MCP_DEFAULT_LOCALE` | `defaultLocale` |
| `SC2MCP_ALLOW_OVERWRITE` | `allowOverwrite` |
| `SC2MCP_MAX_ARCHIVE_BYTES` | `maxArchiveBytes` |
| `SC2MCP_MAX_EXTRACTED_FILES` | `maxExtractedFiles` |
| `SC2MCP_MAX_SINGLE_FILE_BYTES` | `maxSingleFileBytes` |
| `SC2MCP_PROCESS_TIMEOUT_MS` | `processTimeoutMs` |
| `SC2MCP_LOG_LEVEL` | `logLevel` |
| `SC2MCP_CONFIG` | Path of the config file itself |

A malformed value (`SC2MCP_LOG_LEVEL=shouty`) is an error, not a silent fallback.

`SC2PATH` is also honoured for installation *detection* only, since other StarCraft II
tooling already sets it.

## Example

```json
{
  "allowedRoots": [
    "C:\\Users\\me\\OneDrive\\Documents\\StarCraft II\\Maps",
    "D:\\SC2Projects"
  ],
  "sc2InstallPath": "C:\\Program Files (x86)\\StarCraft II",
  "allowOverwrite": false,
  "logLevel": "info"
}
```

Do not commit this file — it contains machine-specific paths. `sc2-mcp.config.json` is
gitignored for that reason.

## Choosing allowed roots

Pick the narrowest set that covers the projects you want the agent to work on. The
server refuses every path outside them, including through symlinks, so a too-narrow root
produces a clear `SC2_PATH_DENIED` error rather than a subtle failure.

Do **not** add your StarCraft II installation directory. The server never needs to write
there, and PLAN.md §25 forbids modifying installed Blizzard dependency archives.

## Where state lives

```text
<workspaceRoot>/
├─ config.json          (if you put it here)
├─ workspaces/
│  └─ ws_<32 hex>/
│     ├─ state.json     Durable workspace record
│     ├─ working/       The staging copy — all edits land here
│     ├─ snapshots/     Pre-transaction copies
│     ├─ changes/       Applied change records
│     └─ logs/
└─ cache/
```

Workspaces are durable and survive client reconnects. They are never cleaned up
automatically yet; use `sc2_discard_workspace`, or delete a `ws_*` directory by hand.

`state.json` carries a `stateVersion`. A workspace written by a newer server is refused
with a migration message rather than reinterpreted.
