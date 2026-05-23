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
| `claude-code.ts` | Claude Code CLI bridge (`claude -p`). Uses your Claude Code auth. |
| `gemini-cli.ts` | Gemini CLI bridge (`gemini -p`, stdin fallback). Uses your Gemini auth. |
| `opencode.ts` | OpenCode CLI bridge (`opencode run`). Uses your OpenCode provider config. |
| `kilo-code.ts` | Kilo Code CLI bridge (`kilocode`/`kilo run`). Uses your Kilo Code config. |
| `registry.ts` | Tracks connected bridges + generates `/run`-able wrappers; also caches startup CLI detection + the `runCliAsk` proxy used by the provider layer. |

> 💡 **The AI-CLI bridges do double duty.** Besides `/connect` + `/run`, each is
> selectable as the **active LLM provider** via `/provider` — selecting one routes
> the *whole* core loop (free prompts and skills) through that CLI on its own
> login (no SkillOS key). See `apps/server/src/providers/provider.ts` (the `cli`
> resolution kind + `streamCompletion`'s `cli` case → `runCliAsk`). The CLI ids
> that opt into this are listed in `CLI_PROVIDER_BRIDGES` in `registry.ts`, and
> they're detected once at startup (`detectCliProviders`, cached per process).

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
| `/connect <target>` | Connect a bridge (`shell` \| `aider` \| `claude-code` \| `gemini` \| `opencode` \| `kilo-code`): run detection, register it, generate wrappers, report status. |
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

## External AI-CLI bridges (`claude-code.ts`, `gemini-cli.ts`, `opencode.ts`, `kilo-code.ts`)

Four bridges wrap popular external AI coding CLIs so you can drive them from
SkillOS using **their** auth instead of a SkillOS API key:

| Target (`/connect …`) | Binary | Detection | Non-interactive proxy | Capabilities |
| --- | --- | --- | --- | --- |
| `claude-code` | `claude` | `claude --version` | `claude -p "<prompt>"` (print/headless) | `ask`, `edit` |
| `gemini` | `gemini` | `gemini --version` | `gemini -p "<prompt>"`, **stdin fallback** | `ask` |
| `opencode` | `opencode` | `opencode --version` | `opencode run "<prompt>"` | `ask`, `edit` |
| `kilo-code` | `kilocode` then `kilo` | `<bin> --version` | `<bin> run "<prompt>"` | `ask`, `edit` |

> ⚠️ **Kilo Code binary uncertainty (honest gap).** Kilo Code is primarily an
> IDE extension; its standalone CLI surface is less standardized than the others.
> The bridge best-guesses the binary (`kilocode`, then `kilo`) and the
> `<bin> run "<prompt>"` invocation. If your install differs, the bridge degrades
> gracefully (unavailable + install hint) — adjust `BIN_CANDIDATES` / the run
> args in `kilo-code.ts` if your CLI uses a different name or subcommand.

**Also usable as the active provider.** Every CLI in `CLI_PROVIDER_BRIDGES`
(claude-code, gemini, opencode, kilo-code) can be selected via `/provider` to
back the *entire* core loop, not just `/run`. The provider layer combines the
skill/system prompt + the user prompt into one string and runs it through the
bridge's `ask` capability (`runCliAsk`), streaming stdout back. Same auth model
(the CLI's own login), bounded by a timeout so a stuck CLI never hangs the turn.

**Uses your existing CLI subscription/auth — no SkillOS key needed.** Each bridge
spawns the user's locally-installed CLI, which carries its own credentials
(Claude Code login/subscription, Gemini `GEMINI_API_KEY` or Google login,
OpenCode provider config). SkillOS never reads or needs its own API key on these
paths — it only spawns the binary and streams stdout/stderr back through the
`BridgeSink`. The prompt is passed as a single argv entry (no shell
interpolation of user text).

**Graceful degradation** is identical to Aider: detection (`<bin> --version`)
never throws; a missing binary marks the bridge `unavailable` with an install
hint, but the static capability map is **still exposed and wrappers are still
generated**, so the mechanism is demonstrable offline. Running a wrapper while
unavailable returns a clear `ok:false` (with the hint) instead of crashing.
Install hints:

- Claude Code: `npm i -g @anthropic-ai/claude-code` then sign in — https://docs.claude.com/claude-code
- Gemini CLI: `npm i -g @google/gemini-cli` then authenticate — https://github.com/google-gemini/gemini-cli
- OpenCode: `npm i -g opencode-ai` then configure a provider — https://opencode.ai
- Kilo Code: primarily an IDE extension — https://kilocode.ai (expose a `kilocode`/`kilo` CLI on PATH if available)

**Permission gating** is unchanged: `ask` capabilities declare no privileged
tools (chat-only), while `edit` capabilities declare `["filesystem","shell"]`,
so over a remote session they go through the same `ensurePermission` prompt as
the shell bridge. All spawning/parsing lives inside each module — the gateway
only ever sees the `Bridge` interface.

The Gemini bridge's **stdin fallback** is the one extra wrinkle: if `gemini -p`
exits non-zero with no stdout (some versions only read the prompt from stdin in
non-TTY contexts), it retries once by piping the prompt on stdin. Both paths are
contained in `gemini-cli.ts`.

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
