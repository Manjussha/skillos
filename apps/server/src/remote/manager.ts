/**
 * Remote-access manager (Layer 4).
 *
 * Holds the singleton remote state (tunnel process + minted tokens) and renders
 * the human-readable output for `/remote start|stop|status`. Transport-agnostic:
 * returns a list of lines + an optional QR block; the gateway writes them to the
 * client. Keeping orchestration here keeps index.ts thin.
 */

import type { ChildProcess } from "node:child_process";
import {
  detectCloudflared,
  startTunnel,
  stopTunnel,
  type CloudflaredInfo,
} from "./tunnel.js";
import { mintRemoteToken, revoke, type MintedToken } from "./tokens.js";
import { accessUrl, qrToTerminal } from "./qr.js";
import {
  DEFAULT_REMOTE_SCOPES,
  type Scope,
} from "./permissions.js";

interface RemoteState {
  /** Whether a tunnel (or local-stand-in) session is active. */
  active: boolean;
  /** cloudflared child process, null when degraded to local-only. */
  proc: ChildProcess | null;
  /** Public tunnel URL, or the local URL when degraded. */
  url: string | null;
  /** Whether we're degraded (cloudflared missing / tunnel failed). */
  degraded: boolean;
  /** The most recently minted token (the one in the active QR). */
  token: MintedToken | null;
  /** All tokens minted this process lifetime (for status display + cleanup). */
  mintedTokens: MintedToken[];
}

const state: RemoteState = {
  active: false,
  proc: null,
  url: null,
  degraded: false,
  token: null,
  mintedTokens: [],
};

export interface RemoteOutput {
  lines: string[];
  /** Pre-rendered QR block (terminal art), or null. */
  qr?: string | null;
}

const INSTALL_NOTE = [
  "cloudflared is not installed — running in LOCAL stand-in mode.",
  "Install it to expose a public URL:",
  "  macOS:   brew install cloudflared",
  "  Windows: winget install --id Cloudflare.cloudflared",
  "  Linux:   see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
  "Then re-run /remote start.",
];

function localUrl(port: number): string {
  // Browser client served by Vite in dev; for the stand-in we encode the ws
  // gateway origin so a token + QR are still demonstrable offline.
  return `http://localhost:${port}`;
}

/**
 * Start remote access. Always mints a scoped token + QR. If cloudflared is
 * present we open a public tunnel; if not (or it fails) we degrade gracefully to
 * the local URL and clearly say so — never crashing.
 */
export async function startRemote(
  userId: string,
  port: number,
  scopes: readonly Scope[] = DEFAULT_REMOTE_SCOPES,
): Promise<RemoteOutput> {
  if (state.active) {
    return {
      lines: [
        "Remote access is already running. Run /remote status to see details,",
        "or /remote stop first to restart with a fresh token.",
      ],
    };
  }

  const lines: string[] = [];
  const cf: CloudflaredInfo = await detectCloudflared();

  let url: string | null = null;
  let degraded = false;
  let proc: ChildProcess | null = null;

  if (cf.installed) {
    lines.push(`cloudflared ${cf.version ?? ""} detected — opening tunnel…`.trim());
    const res = await startTunnel(port);
    if (res.ok && res.url) {
      url = res.url;
      proc = res.proc;
    } else {
      degraded = true;
      lines.push(`Tunnel failed to start: ${res.error ?? "unknown error"}.`);
      lines.push("Falling back to LOCAL stand-in mode.");
    }
  } else {
    degraded = true;
    lines.push(...INSTALL_NOTE);
  }

  if (!url) url = localUrl(port);

  // Mint a scoped, expiring token regardless of tunnel state.
  const token = await mintRemoteToken(userId, scopes);
  const link = accessUrl(url, token.token);

  state.active = true;
  state.proc = proc;
  state.url = url;
  state.degraded = degraded;
  state.token = token;
  state.mintedTokens.push(token);

  let qr: string | null = null;
  try {
    qr = await qrToTerminal(link);
  } catch {
    qr = null;
  }

  lines.push("");
  lines.push(degraded ? "Remote access (LOCAL stand-in):" : "Remote access (PUBLIC tunnel):");
  lines.push(`  URL:     ${url}`);
  lines.push(`  Access:  ${link}`);
  lines.push(`  Scopes:  ${token.scopes.join(", ")}`);
  lines.push(`  Expires: ${token.expiresAt.toISOString()}`);
  lines.push(
    degraded
      ? "  Note:    URL is local-only; install cloudflared for off-network access."
      : "  Scan the QR with your phone to drive the terminal remotely.",
  );
  lines.push("");
  lines.push("Remote sessions are token-scoped; shell/filesystem tools prompt for");
  lines.push("confirmation before running. Run /remote stop to revoke + tear down.");

  return { lines, qr };
}

/** Report current remote state. */
export function statusRemote(): RemoteOutput {
  if (!state.active) {
    return { lines: ["Remote access: stopped. Run /remote start to enable."] };
  }
  const lines: string[] = [
    `Remote access: running (${state.degraded ? "LOCAL stand-in" : "public tunnel"})`,
    `  URL:    ${state.url ?? "(unknown)"}`,
    `  Active tokens minted this session: ${state.mintedTokens.length}`,
  ];
  if (state.token) {
    const expired = state.token.expiresAt.getTime() <= Date.now();
    lines.push(
      `  Current token scopes: ${state.token.scopes.join(", ")}`,
      `  Current token expires: ${state.token.expiresAt.toISOString()}${expired ? " (EXPIRED)" : ""}`,
    );
  }
  if (state.degraded) {
    lines.push("  (cloudflared not active — URL is local-only)");
  }
  return { lines };
}

/** Stop remote access: tear down the tunnel and revoke all minted tokens. */
export async function stopRemote(): Promise<RemoteOutput> {
  if (!state.active) {
    return { lines: ["Remote access is not running."] };
  }
  stopTunnel(state.proc);
  // Revoke every token minted in this session so a leaked URL dies immediately.
  await Promise.all(state.mintedTokens.map((t) => revoke(t.token).catch(() => {})));
  const count = state.mintedTokens.length;

  state.active = false;
  state.proc = null;
  state.url = null;
  state.degraded = false;
  state.token = null;
  state.mintedTokens = [];

  return {
    lines: [
      "Remote access stopped.",
      `  Tunnel torn down · ${count} token(s) revoked.`,
    ],
  };
}

/** Whether remote access is currently active (for status/tests). */
export function isRemoteActive(): boolean {
  return state.active;
}
