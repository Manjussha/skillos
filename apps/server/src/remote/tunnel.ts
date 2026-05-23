/**
 * Cloudflare Tunnel integration (Layer 4).
 *
 * `/remote start` launches `cloudflared tunnel --url http://localhost:<port>` as
 * a child process and scrapes the public `https://*.trycloudflare.com` URL from
 * its stderr/stdout. `/remote stop` tears it down.
 *
 * Graceful degradation is a hard requirement: cloudflared is almost certainly
 * NOT installed in CI / this environment. `detectCloudflared()` checks for the
 * binary; callers fall back to the local URL (still minting a token + QR) when
 * it's missing, so the whole layer is verifiable offline with no crash.
 */

import { spawn, type ChildProcess } from "node:child_process";

/** Regex for the public quick-tunnel hostname cloudflared prints. */
const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export interface CloudflaredInfo {
  installed: boolean;
  /** Resolved version string when installed, else null. */
  version: string | null;
}

/**
 * Detect whether `cloudflared` is on PATH by running `cloudflared --version`.
 * Never throws — a missing binary resolves to { installed: false }.
 */
export function detectCloudflared(timeoutMs = 4000): Promise<CloudflaredInfo> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (info: CloudflaredInfo) => {
      if (settled) return;
      settled = true;
      resolve(info);
    };

    let child: ChildProcess;
    try {
      child = spawn("cloudflared", ["--version"], { windowsHide: true });
    } catch {
      done({ installed: false, version: null });
      return;
    }

    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    // ENOENT (binary not found) lands here.
    child.on("error", () => done({ installed: false, version: null }));
    child.on("close", (code) => {
      if (code === 0) {
        const m = out.match(/cloudflared version\s+(\S+)/i);
        done({ installed: true, version: m?.[1] ?? (out.trim() || "unknown") });
      } else {
        done({ installed: false, version: null });
      }
    });

    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done({ installed: false, version: null });
    }, timeoutMs);
  });
}

export interface TunnelHandle {
  /** The child process running cloudflared. */
  proc: ChildProcess;
  /** Public URL once captured, else null while still starting. */
  url: string | null;
}

export interface StartTunnelResult {
  ok: boolean;
  url: string | null;
  proc: ChildProcess | null;
  /** Human-readable error when ok is false. */
  error?: string;
}

/**
 * Start a cloudflared quick tunnel pointing at the local HTTP server and wait
 * (up to `timeoutMs`) for the public URL to appear in its output.
 *
 * Assumes the caller has already confirmed cloudflared is installed via
 * detectCloudflared(). Resolves with ok=false (not a throw) on any failure so
 * the dispatcher can report it cleanly.
 */
export function startTunnel(
  port: number,
  timeoutMs = 20000,
): Promise<StartTunnelResult> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(
        "cloudflared",
        ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`],
        { windowsHide: true },
      );
    } catch (err) {
      resolve({
        ok: false,
        url: null,
        proc: null,
        error: (err as Error).message,
      });
      return;
    }

    let settled = false;
    const finish = (res: StartTunnelResult) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };

    const scan = (chunk: Buffer) => {
      const m = chunk.toString().match(TRYCLOUDFLARE_RE);
      if (m) finish({ ok: true, url: m[0], proc });
    };
    proc.stdout?.on("data", scan);
    proc.stderr?.on("data", scan);

    proc.on("error", (err) => {
      finish({ ok: false, url: null, proc: null, error: err.message });
    });
    proc.on("close", (code) => {
      // If it exited before we saw a URL, it failed to establish.
      finish({
        ok: false,
        url: null,
        proc: null,
        error: `cloudflared exited (code ${code ?? "?"}) before a URL appeared`,
      });
    });

    setTimeout(() => {
      if (!settled) {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        finish({
          ok: false,
          url: null,
          proc: null,
          error: `timed out after ${timeoutMs}ms waiting for the tunnel URL`,
        });
      }
    }, timeoutMs);
  });
}

/** Stop a running tunnel process. Safe to call when already stopped. */
export function stopTunnel(proc: ChildProcess | null): void {
  if (!proc) return;
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
}
