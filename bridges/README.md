# bridges/ — Layer 5 (Terminal Bridges)

Terminal interoperability: wrap external terminals/CLIs as first-class,
runnable SkillOS commands. This is the final layer of v0.1.

> ⚠️ External AI terminals expose **no stable machine-readable capability API**,
> so a bridge means spawning a CLI and parsing its output — inherently brittle.
> That brittleness is **contained behind the bridge interface**: every external
> process and all output parsing lives inside a single bridge module, and the
> rest of SkillOS only ever sees the `Bridge` type. Built last, on top of a
> stable foundation, exactly so this risk is isolated.

The implementation lives in **`apps/server/src/bridges/`** (this top-level
directory is the conceptual home + docs). Modules:

| File | Role |
| --- | --- |
| `types.ts` | The `Bridge` interface + helpers (the stable boundary). |
| `shell.ts` | Local shell bridge — the simplest reference implementation. |
| `aider.ts` | Aider bridge — first AI-terminal target, with graceful degradation. |
| `registry.ts` | Tracks connected bridges + generates `/run`-able wrappers. |

## The bridge interface (`types.ts`)

A `Bridge` declares:

- `name`, `description`, `status` (`ready` | `unavailable` | `error`), `note`
- `capabilities: BridgeCapability[]` — what the external tool can do; each
  capability lists the privileged `tools` it touches (`shell`, `filesystem`),
  which feed the Layer 4 permission model.
- `commands: BridgeCommand[]` — concrete invokable wrappers, each mapped to a
  capability.
- `connect(): Promise<BridgeStatus>` — detect the tool and (re)derive
  capabilities/commands. **Must never throw on a missing tool.**
- `run(commandName, input, sink): Promise<BridgeRunResult>` — run a command,
  streaming output through the `BridgeSink` (`onChunk` for stdout/stderr,
  `onInfo` for status lines). Returns `ok:false` (never throws) when the tool is
  unavailable.

The gateway treats every bridge identically — it only depends on this
interface, so spawning/parsing differences stay inside each module.

## Commands

| Command | What it does |
| --- | --- |
| `/connect <target>` | Connect a bridge (`shell` \| `aider`): run detection, register it, generate wrappers, report status. |
| `/bridges` | List connected bridges with status + capabilities + commands. |
| `/run <wrapped> …` | Proxy to a connected bridge command (falls back to normal skills if the name isn't a bridge wrapper). |

Bridge wrappers and skills **coexist**: `/run` resolves a connected bridge
wrapper first, then falls back to skills/workflows, so Layer 1/2 behavior is
unchanged. Wrappers are also runnable as a bare command (e.g. `/shell …`,
`/aider-edit …`).

## Local shell bridge (`shell.ts`)

The reference implementation. One capability (`shell.exec`, tools `["shell"]`)
exposed as the `shell` command. `run()` spawns the platform shell via Node's
built-in `child_process.spawn` (`cmd.exe /d /s /c …` on Windows, `/bin/sh -c …`
elsewhere) and streams stdout **and** stderr back incrementally as the process
produces them.

### Security gating (this is the active control)

Shell execution is privileged, so it goes through the **existing Layer 4
permission gate** (`apps/server/src/remote/permissions.ts` →
`ensurePermission` in `index.ts`) — the *same* path skills and agents use:

- The `shell` capability declares the `shell` tool. `runBridge` passes the
  wrapper's tools to `ensurePermission`.
- **Local sessions** are permissive (implicit full trust) — no prompt, exactly
  like before.
- **Remote sessions** must hold the `shell` scope (minted only via
  `/remote start --shell`); even then, every invocation requires an **explicit
  per-invocation confirmation prompt** before the command runs. A remote token
  without `shell` is hard-denied.

> ⚠️ **No OS sandbox yet.** Layer 4 flagged sandboxing as future work; it is not
> implemented. The **permission gate is the active control**. Granting `shell`
> over a remote session is effectively granting remote code execution — treat it
> accordingly.

## Aider bridge (`aider.ts`)

The first AI-terminal target. `/connect aider`:

1. **Detects** aider via `aider --version` (`detectAider`, mirrors Layer 4's
   `detectCloudflared` — never throws on a missing binary).
2. Uses a **curated static capability map** (`edit`, `ask`, `commit`). Aider has
   no machine-readable capability API, so we do *not* scrape behavior from
   `--help`; the static map is the deliberately-isolated brittle bit, kept tiny.
3. **Generates wrappers** from the capabilities: each becomes a `/run aider-<id>`
   command (`aider-edit`, `aider-ask`, `aider-commit`) with the right tool
   scopes for permission gating.
4. When ready, `/run aider-edit <instruction>` **proxies** to aider's
   non-interactive one-shot mode (`aider --yes --message …`, or `--message
   /ask …` for the read-only `ask` capability) and streams its stdout back.

### Graceful degradation (aider almost certainly not installed here)

`/connect aider` **never crashes** when aider is missing:

- Detection resolves to "not installed" with **no throw**.
- The bridge registers with status **`unavailable`** and an **install hint**
  (`pipx install aider-chat` / `pip install aider-chat`).
- The static capability map is **still exposed and the wrappers are still
  generated**, so the bridge mechanism is fully demonstrable offline.
- Running a wrapper while unavailable returns a clear `ok:false` and explains
  what *would* run + how to enable it — again, no crash.

This makes the whole layer verifiable offline (see `scripts/verify-layer5.mjs`).

## Capability scanning + wrapper generation

"Scanning" here = `connect()` runs detection (presence/version) and resolves the
capability map. For aider that map is static (no stable external API); a future
bridge with a real introspection surface would populate `capabilities` from it
inside its own module. The registry then turns each `BridgeCommand` into a
`BridgeWrapper` — a `/run`-able name carrying the bridge, description, and the
privileged tools (from its capability) that drive permission prompts.

## Adding a new bridge

1. Create `apps/server/src/bridges/<name>.ts` implementing `Bridge`. Put **all**
   spawning/parsing inside it. Make `connect()` degrade gracefully if the tool
   is missing.
2. Add one entry to `BRIDGES` in `registry.ts`:
   `{ <name>: new MyBridge() }`.

That's it — `/connect`, `/bridges`, `/run` proxying, and permission gating all
work generically off the interface. No protocol or client changes are needed:
bridges reuse the existing `chunk` / `info` / `error` / `done` messages.
