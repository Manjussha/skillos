/**
 * Bridge interface (Layer 5 — terminal interoperability).
 *
 * A "bridge" wraps an external terminal/CLI (a local shell, Aider, …) so its
 * capabilities become runnable from SkillOS exactly like skills. Bridges are the
 * riskiest part of v0.1: external AI terminals expose NO stable machine-readable
 * capability API, so a bridge means spawning a CLI and parsing its output, which
 * is inherently brittle. That brittleness is deliberately contained behind THIS
 * interface — all external-process and CLI-parsing logic lives inside a bridge
 * module, and the rest of SkillOS only ever sees `Bridge` + `BridgeStream`.
 *
 * Adding a new bridge is one small module that implements `Bridge` and registers
 * itself; nothing else changes.
 */

/** A capability a bridge advertises (a thing the external tool can do). */
export interface BridgeCapability {
  /** Stable id, e.g. "edit", "shell.exec". */
  id: string;
  /** One-line human description. */
  description: string;
  /**
   * Privileged tools this capability touches on the host, mapped to the Layer 4
   * permission scopes (e.g. ["shell"], ["filesystem"]). Drives remote prompts.
   * Empty/absent means chat-only — no permission prompt.
   */
  tools: string[];
}

/** A concrete invokable command a bridge exposes (maps onto a capability). */
export interface BridgeCommand {
  /**
   * Name as the user runs it, e.g. "aider-edit" or "shell". Becomes a wrapper
   * that `/run <name>` proxies to. Kept globally unique by prefixing with the
   * bridge name where helpful.
   */
  name: string;
  /** The capability id this command exercises. */
  capabilityId: string;
  /** One-line description, shown by /bridges. */
  description: string;
}

/** Connection / availability status of a bridge. */
export type BridgeStatus =
  | "ready" // detected and usable
  | "unavailable" // registered, but the underlying tool is missing
  | "error"; // detected but failed to initialize

/** A single piece of streamed bridge output. */
export interface BridgeChunk {
  /** Which stream it came from (so the UI/caller can distinguish). */
  stream: "stdout" | "stderr";
  text: string;
}

/** A sink the gateway provides so a bridge can stream output back live. */
export interface BridgeSink {
  onChunk(chunk: BridgeChunk): void;
  /** A human-readable info line (status, hints) not part of tool output. */
  onInfo(text: string): void;
}

/** Result of running a bridge command. */
export interface BridgeRunResult {
  ok: boolean;
  /** Process exit code when applicable, else null. */
  code: number | null;
  /** Human-readable message on failure (e.g. tool missing), else undefined. */
  error?: string;
}

/**
 * A bridge to an external terminal/CLI. Implementations isolate ALL spawning and
 * output parsing; the gateway treats every bridge identically.
 */
export interface Bridge {
  /** Stable id, e.g. "shell", "aider". */
  readonly name: string;
  /** One-line description shown by /bridges. */
  readonly description: string;
  /** Current status. May change after `connect()` runs detection. */
  status: BridgeStatus;
  /** A status note (e.g. install hint when unavailable), or null. */
  note: string | null;
  /** Capabilities this bridge advertises. */
  readonly capabilities: BridgeCapability[];
  /** Concrete commands generated from the capabilities (wrappers). */
  readonly commands: BridgeCommand[];

  /**
   * Detect the external tool and (re)derive capabilities/commands. Must NEVER
   * throw on a missing tool — it should set status to "unavailable" with an
   * install note and still expose its (static) capability map so the bridge
   * mechanism is demonstrable offline. Returns the resolved status.
   */
  connect(): Promise<BridgeStatus>;

  /**
   * Run one of this bridge's commands, streaming output through `sink`. `input`
   * is the free-text argument from `/run <command> <input>`. If the underlying
   * tool is unavailable, this returns ok:false with a clear error (no throw).
   */
  run(
    commandName: string,
    input: string,
    sink: BridgeSink,
  ): Promise<BridgeRunResult>;
}

/** Look up a capability by the id a command references. */
export function capabilityFor(
  bridge: Bridge,
  capabilityId: string,
): BridgeCapability | null {
  return bridge.capabilities.find((c) => c.id === capabilityId) ?? null;
}

/** Find a command on a bridge by its user-facing name. */
export function commandFor(
  bridge: Bridge,
  name: string,
): BridgeCommand | null {
  const lower = name.toLowerCase();
  return bridge.commands.find((c) => c.name.toLowerCase() === lower) ?? null;
}

/** Privileged tools a bridge command needs (via its capability). */
export function toolsForCommand(bridge: Bridge, name: string): string[] {
  const cmd = commandFor(bridge, name);
  if (!cmd) return [];
  const cap = capabilityFor(bridge, cmd.capabilityId);
  return cap?.tools ?? [];
}
