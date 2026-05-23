/**
 * Bridge registry (Layer 5) + catalog-driven CLI detection (Feature B).
 *
 * Holds the set of known bridges, tracks which are "connected" (have run
 * `connect()` this process), and generates the internal wrapper map so a bridge
 * command is runnable via `/run <wrapped>`. This keeps index.ts thin and keeps
 * all bridge bookkeeping in one auditable place.
 *
 * TWO sources of CLI bridges now:
 *   1. TUNED modules (shell, aider, claude-code, gemini, opencode, kilo-code) —
 *      hand-written for richer behavior. Registered directly below.
 *   2. The CLI CATALOG (catalog.ts) — every entry WITHOUT a tuned module gets a
 *      GenericCliBridge built from its metadata. So the system surfaces ANY
 *      installed AI CLI it knows about, not just a fixed four.
 *
 * Detection: the unified picker uses a FAST PATH SCAN (detect.ts) over the whole
 * catalog — instant, no `<bin> --version` cold-starts. The tuned bridges keep
 * their own richer `--version` probe when actually connected.
 */

import { ShellBridge } from "./shell.js";
import { AiderBridge } from "./aider.js";
import { ClaudeCodeBridge } from "./claude-code.js";
import { GeminiCliBridge } from "./gemini-cli.js";
import { OpenCodeBridge } from "./opencode.js";
import { KiloCodeBridge } from "./kilo-code.js";
import { GenericCliBridge } from "./generic-cli.js";
import { CLI_CATALOG, catalogEntry, type CliCatalogEntry } from "./catalog.js";
import { isBinaryOnPath } from "./detect.js";
import {
  type Bridge,
  type BridgeStatus,
  commandFor,
  toolsForCommand,
} from "./types.js";

/**
 * Every bridge SkillOS knows how to connect, keyed by `/connect <target>`. The
 * tuned modules are registered explicitly; the catalog adds a GenericCliBridge
 * for each entry that lacks a tuned module (so `/connect codex`, `/run qwen-ask`,
 * etc. all work generically).
 */
const BRIDGES: Record<string, Bridge> = {
  shell: new ShellBridge(),
  aider: new AiderBridge(),
  // External AI-CLI bridges (tuned). Each proxies to the user's locally-installed
  // CLI (its own auth/subscription — no SkillOS API key) and degrades gracefully
  // when the binary is missing. These double as selectable ACTIVE providers (see
  // providers/provider.ts) so the core loop can stream through them.
  "claude-code": new ClaudeCodeBridge(),
  gemini: new GeminiCliBridge(),
  opencode: new OpenCodeBridge(),
  "kilo-code": new KiloCodeBridge(),
};

// Add a GenericCliBridge for every catalog entry WITHOUT a tuned module. (Tuned
// entries are already registered above; we don't overwrite them.)
for (const entry of CLI_CATALOG) {
  if (!entry.tuned && !BRIDGES[entry.id]) {
    BRIDGES[entry.id] = new GenericCliBridge(entry);
  }
}

/**
 * The CLI ids that are ALSO selectable as the active LLM provider (their `ask`
 * capability is proxied by `streamCompletion`). This is now the WHOLE catalog,
 * in catalog order — every known AI CLI can be the active provider when installed.
 */
export const CLI_PROVIDER_BRIDGES = CLI_CATALOG.map((e) => e.id) as string[];

/** A CLI provider id is any catalog id (a plain string at the type level). */
export type CliProviderId = string;

/** True if a string names a CLI-backed provider (i.e. a catalog id). */
export function isCliProviderId(id: string): id is CliProviderId {
  return catalogEntry(id) !== undefined;
}

/** The catalog entry for a CLI provider id (or undefined). */
export function cliCatalogEntry(id: string): CliCatalogEntry | undefined {
  return catalogEntry(id);
}

/** Get a bridge by its target id (without connecting it). */
export function getBridge(target: string): Bridge | undefined {
  return BRIDGES[target.toLowerCase()];
}

/** Bridges the user has run `/connect` on this process (name → bridge). */
const connected = new Map<string, Bridge>();

/** A generated wrapper: a `/run`-able name that proxies to a bridge command. */
export interface BridgeWrapper {
  /** User-facing name, e.g. "shell" or "aider-edit". */
  name: string;
  bridge: Bridge;
  description: string;
  /** Privileged tools (scopes) this wrapper needs — drives permission prompts. */
  tools: string[];
}

/** Result of a /connect attempt. */
export interface ConnectResult {
  ok: boolean;
  bridge?: Bridge;
  status?: BridgeStatus;
  /** Wrappers generated for the bridge's commands. */
  wrappers?: BridgeWrapper[];
  error?: string;
}

/** List the targets `/connect` accepts. */
export function availableTargets(): string[] {
  return Object.keys(BRIDGES);
}

/**
 * Connect (or reconnect) a bridge by target name. Runs detection, registers it
 * as connected, and (re)generates its wrappers. Never throws on a missing
 * external tool — that surfaces as the bridge's status, not an error here.
 */
export async function connectBridge(target: string): Promise<ConnectResult> {
  const bridge = BRIDGES[target.toLowerCase()];
  if (!bridge) {
    return {
      ok: false,
      error: `Unknown bridge "${target}". Available: ${availableTargets().join(", ")}.`,
    };
  }
  const status = await bridge.connect();
  connected.set(bridge.name, bridge);
  return { ok: true, bridge, status, wrappers: wrappersFor(bridge) };
}

/** Generate the wrapper list for a single bridge's commands. */
export function wrappersFor(bridge: Bridge): BridgeWrapper[] {
  return bridge.commands.map((cmd) => ({
    name: cmd.name,
    bridge,
    description: cmd.description,
    tools: toolsForCommand(bridge, cmd.name),
  }));
}

/** All connected bridges (insertion order). */
export function listConnected(): Bridge[] {
  return [...connected.values()];
}

/** Whether any bridge is connected. */
export function hasConnected(): boolean {
  return connected.size > 0;
}

/**
 * Resolve a `/run <name>` to a connected bridge wrapper, if any. Returns null
 * when no connected bridge exposes that command (so the caller can fall back to
 * normal skills — bridge wrappers and skills coexist).
 */
export function resolveWrapper(name: string): BridgeWrapper | null {
  for (const bridge of connected.values()) {
    const cmd = commandFor(bridge, name);
    if (cmd) {
      return {
        name: cmd.name,
        bridge,
        description: cmd.description,
        tools: toolsForCommand(bridge, name),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI-as-provider support: startup detection cache + an `ask` proxy used by the
// provider layer so the core loop can stream THROUGH an installed CLI.
// ---------------------------------------------------------------------------

/**
 * Process-wide cache of which CLI provider bridges are installed. Populated once
 * at startup (`detectCliProviders`) by a FAST PATH SCAN (no `<bin> --version`
 * cold-starts — gemini alone is ~6s). New installs require a server restart to
 * appear — acceptable and noted in the picker.
 */
const cliInstalled = new Map<string, boolean>();

/**
 * Detect every catalog CLI by PATH scan and cache the result for the process.
 * Returns the installed map. Never throws — a detection failure records `false`.
 * Call once at server startup. This is INSTANT (no child processes), so the old
 * per-bridge `--version` spawning at startup is gone.
 *
 * Note: the parameter is kept for source compatibility with the prior signature
 * but is unused — the PATH scan needs no timeout.
 */
export async function detectCliProviders(
  _timeoutMs = 8000,
): Promise<Map<string, boolean>> {
  for (const entry of CLI_CATALOG) {
    cliInstalled.set(entry.id, isBinaryOnPath(entry.binCandidates));
  }
  return cliInstalled;
}

/** Whether a CLI provider bridge was detected as installed at startup. */
export function isCliInstalled(id: string): boolean {
  return cliInstalled.get(id) ?? false;
}

/** A snapshot of the cached install map (for diagnostics / the picker). */
export function cliInstallSnapshot(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const entry of CLI_CATALOG) out[entry.id] = isCliInstalled(entry.id);
  return out;
}

/** Bound a promise with a fallback value if it doesn't settle in time. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Result of running a CLI provider's `ask` capability for the core loop. */
export interface CliAskResult {
  ok: boolean;
  error?: string;
}

/**
 * Run a CLI provider bridge's read-only `ask` capability with a combined prompt,
 * streaming its stdout chunks to `onText`. This is the bridge the provider layer
 * (`streamCompletion`'s `cli` case) calls so the normal loop is answered by the
 * installed CLI using ITS auth. Honors a timeout and never hangs: if the run
 * exceeds `timeoutMs` it resolves ok:false with a clear error.
 *
 * It connects the bridge on demand (so this works even if the user didn't run
 * `/connect` first — selecting the CLI as the active provider is enough).
 */
export async function runCliAsk(
  id: string,
  prompt: string,
  onText: (text: string) => void,
  timeoutMs = 120000,
): Promise<CliAskResult> {
  const bridge = BRIDGES[id];
  if (!bridge) return { ok: false, error: `Unknown CLI provider "${id}".` };

  // Ensure it's connected/detected this process (idempotent, never throws).
  if (bridge.status !== "ready") {
    await bridge.connect();
    connected.set(bridge.name, bridge);
  }
  if (bridge.status !== "ready") {
    return {
      ok: false,
      error:
        `${id} CLI is not installed/ready. ` +
        (bridge.note?.split("\n")[0] ?? "Install it and restart SkillOS."),
    };
  }

  // Find the bridge's `ask` command (every CLI provider bridge exposes one).
  const askCmd =
    bridge.commands.find((c) => c.capabilityId === "ask") ?? bridge.commands[0];
  if (!askCmd) {
    return { ok: false, error: `${id} CLI exposes no runnable command.` };
  }

  // Stream through the bridge. We forward only stdout to the model output; the
  // bridge's onInfo / stderr is captured for error reporting but not streamed as
  // model text, so the user sees clean output.
  let stderr = "";
  const sink = {
    onChunk(chunk: { stream: "stdout" | "stderr"; text: string }) {
      if (chunk.stream === "stdout") onText(chunk.text);
      else stderr += chunk.text;
    },
    onInfo(_text: string) {
      /* status lines are not model output — swallow */
    },
  };

  const run = bridge.run(askCmd.name, prompt, sink);
  type Timed =
    | { kind: "done"; r: Awaited<ReturnType<Bridge["run"]>> }
    | { kind: "timeout" };
  const timed = await withTimeout<Timed>(
    run.then((r) => ({ kind: "done", r })),
    timeoutMs,
    { kind: "timeout" },
  );

  if (timed.kind === "timeout") {
    return {
      ok: false,
      error: `${id} CLI timed out after ${Math.round(timeoutMs / 1000)}s.`,
    };
  }
  if (!timed.r.ok) {
    return {
      ok: false,
      error: timed.r.error || stderr.trim() || `${id} CLI produced no output.`,
    };
  }
  return { ok: true };
}
