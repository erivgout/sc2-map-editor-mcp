# ADR 0001 — Foundation: language, toolchain, and pinned dependencies

- **Status:** Accepted
- **Date:** 2026-08-17
- **Supersedes:** none
- **Related plan sections:** PLAN.md §6 (Technology Choices), §7 (Toolkit dependency strategy), §42 Phase 0

## Context

PLAN.md §42 Phase 0 requires that verified toolchain choices be recorded before any
production MCP tool is written. This ADR records what was actually measured on the
development machine on 2026-08-17, not what the plan assumed.

## Measured environment

| Component | Plan assumption | Measured | Decision |
|---|---|---|---|
| Node.js | `>=22` | `v26.4.0` | Target **Node 22 LTS API surface** (`@types/node@22`), run on whatever `>=22` is installed. Typing against the floor prevents accidental use of Node 24/26-only APIs. |
| pnpm | required | `10.32.1` | Pinned via `packageManager` in the root `package.json`. |
| CMake | needed for the native MPQ helper | `4.1.0` | Sufficient for StormLib. |
| TypeScript | "TypeScript" | latest is `7.0.2` | **Pinned to `~5.9.3`.** See "TypeScript version" below. |
| ESLint | required | `10.8.1` | Adopted (flat config only). |
| typescript-eslint | required | `8.67.0` | Peer range is `typescript >=4.8.4 <6.1.0`. |
| Vitest | required | `4.1.10` | Adopted. |

### StarCraft II installation (used as the validation target)

| Item | Value |
|---|---|
| Install root | `C:\Program Files (x86)\StarCraft II` |
| Editor (64-bit) | `StarCraft II Editor_x64.exe`, file version `5.0.16.97563` |
| Editor (32-bit) | `StarCraft II Editor.exe` |
| Game launcher | `StarCraft II.exe`, file version `1.18.5.3107` (this is the *launcher* shim, not the game build) |
| Actual game builds | `Versions\Base{75689, 93333, 94137, 95299, 95841, 97425, 97563}\SC2_x64.exe` |
| Build metadata | `.build.info` at the install root |
| Current retail build | **5.0.16 / Base97563** |
| User documents root | `%USERPROFILE%\OneDrive\Documents\StarCraft II` (the Documents folder is OneDrive-redirected on this machine) |

Two consequences for installation discovery (PLAN.md §29):

1. The launcher `.exe` version is **not** the game build. Build detection must read
   `.build.info` and/or enumerate `Versions\Base*`, and must pick the highest
   `Base*` rather than assuming a fixed one.
2. The user Maps directory cannot be derived from `%USERPROFILE%\Documents`.
   OneDrive Known Folder Move relocates it. Discovery must resolve the real
   Documents folder (shell known folder / registry) and must treat the result as a
   candidate, not a certainty.

## Decisions

### D1 — TypeScript pinned to 5.9.x, not 7.x

TypeScript 7.0.2 (the native/Go compiler) is the current `latest` tag, but
`typescript-eslint@8.67.0` declares a peer range of `>=4.8.4 <6.1.0`. Adopting TS 7
today would mean giving up type-aware linting, which is a core defence for a project
whose whole job is mutating other people's files.

We pin `~5.9.3` (exact-minor, patch-floating) and revisit when typescript-eslint
publishes TS 7 support. This is a deliberate, reversible lag, recorded here so it is
not mistaken for neglect.

### D2 — MCP SDK v2, split packages, stdio first

`@modelcontextprotocol/server@2.0.0` and `@modelcontextprotocol/client@2.0.0` are
published and target MCP `2026-07-28`. Both are pinned to `^2.0.0`.

Verified API surface (read from the shipped `.d.mts`, not from blog posts — PLAN.md
§55 rule 11):

- `new McpServer({ name, version }, { capabilities })`
- `server.registerTool(name, { title, description, inputSchema, outputSchema, annotations }, cb)`
  where `inputSchema`/`outputSchema` are **whole Standard Schema objects**
  (`z.object({...})`). The raw-shape form (`{ field: z.string() }`) is **deprecated**
  in v2 — we always pass `z.object(...)`.
- Tool callbacks receive `(args, ctx)` and return `CallToolResult`.
- `serveStdio(factory, options)` from `@modelcontextprotocol/server/stdio` owns the
  protocol-era negotiation and pins one server instance per connection. We use this
  rather than hand-wiring `StdioServerTransport`, so that both the 2025-era and
  2026-07-28 openings are served from one factory.
- `InMemoryTransport.createLinkedPair()` is exported from the server package and is
  the supported way to drive a server from a `Client` in tests.

Streamable HTTP is explicitly deferred (PLAN.md §14).

### D3 — Zod v4 as the schema library

`zod@^4.4.3`. It is the Standard Schema implementation the SDK itself depends on, so
there is no second validation runtime in the process.

### D4 — `sc2-galaxy-toolkit` is vendored and pinned, never a direct dependency

Upstream `main` resolves to **`95d1ff82b8e89fb0078c4b8e5e6622271b927b94`**
(recorded in `vendor/PINS.json`). The repository also carries `legacy` and three
in-flight `refactor/*` branches, which confirms the plan's read that it is unstable.

The toolkit is fetched into `vendor/` by `scripts/bootstrap.ps1` and is **not**
committed. Nothing outside `packages/sc2-toolkit-adapter` may import it (PLAN.md §7).

### D5 — StormLib via a sidecar CLI, not Node FFI

Unchanged from PLAN.md §6. Recorded here so the trade-off is captured in one place:
a crashing native addon takes the whole MCP server down, whereas a crashing sidecar
is a non-zero exit code and a structured error.

### D6: Runtime tests use SC2Switcher and the editor's staging protocol

On 2026-08-20, Test Document was traced on editor 5.0.16 / build 97563. The editor
copied the current map to `Maps\Test\EditorTest.SC2Map`, wrote
`EditorTest.SC2TestConfig`, and invoked `Support64\SC2Switcher_x64.exe`. The switcher
started the current build's `SC2_x64.exe` with this argument shape:

```text
-run Test\EditorTest.SC2Map -displaymode 2 -preload 1 -NoUserCheats -reloadcheck
-meleeMod Void -difficulty 2 -speed 2 -testconfig <absolute-config-path>
```

Launching `SC2_x64.exe` directly with an absolute map path exited before opening a game
window. Launching the same relative staged map through SC2Switcher produced the game
process and loaded the document. The MCP therefore mirrors that protocol with its own
fixed `SC2MCPTest` map and config names. It does not automate the editor UI.

The resulting implementation was verified with a packed map and with an unpacked map
copied from an extensionless workspace staging directory. Both were launched through the
built MCP boundary and accepted by the installed game client.

## Consequences

- The lint/typecheck toolchain is one major version behind TypeScript `latest`. This
  is tracked and intentional (D1).
- Installation discovery handles the Windows-specific OneDrive Documents redirection.
  CI covers the path logic; only the installed-client cycle remains machine-specific.
- `vendor/` and `native/**/third_party/` are gitignored, so a fresh clone is not
  buildable end-to-end until `scripts/bootstrap.ps1` has run.

## Resolved questions from later phases

- StormLib-repacked maps load in editor 5.0.16. Phase 3 validated byte-identical
  round trips on six ladder maps and an MCP-authored packed-map editor cycle.
- The reliable local test-map launch mechanism is SC2Switcher plus the observed Test
  Document staging/config protocol (D6, Phase 13).
