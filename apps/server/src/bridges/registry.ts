/**
 * Bridge registry (Layer 5).
 *
 * Holds the set of known bridges, tracks which are "connected" (have run
 * `connect()` this process), and generates the internal wrapper map so a bridge
 * command is runnable via `/run <wrapped>`. This keeps index.ts thin and keeps
 * all bridge bookkeeping in one auditable place.
 *
 * Adding a bridge: implement `Bridge` in its own module and add one entry to
 * `BRIDGES` below. Nothing else changes — `/connect`, `/bridges`, and `/run`
 * proxying all work generically off the interface.
 */

import { ShellBridge } from "./shell.js";
import { AiderBridge } from "./aider.js";
import { ClaudeCodeBridge } from "./claude-code.js";
import { GeminiCliBridge } from "./gemini-cli.js";
import { OpenCodeBridge } from "./opencode.js";
import {
  type Bridge,
  type BridgeStatus,
  commandFor,
  toolsForCommand,
} from "./types.js";

/** Every bridge SkillOS knows how to connect, keyed by `/connect <target>`. */
const BRIDGES: Record<string, Bridge> = {
  shell: new ShellBridge(),
  aider: new AiderBridge(),
  // External AI-CLI bridges. Each proxies to the user's locally-installed CLI
  // (its own auth/subscription — no SkillOS API key needed) and degrades
  // gracefully when the binary is missing.
  "claude-code": new ClaudeCodeBridge(),
  gemini: new GeminiCliBridge(),
  opencode: new OpenCodeBridge(),
};

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
