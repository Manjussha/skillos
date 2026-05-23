/**
 * Remote session tokens (Layer 4).
 *
 * A token is a row in the existing `Session` model (token + scoped permissions
 * + expiresAt). Minting persists it; validation goes through `validateToken` in
 * the repo so there is exactly one authentication chokepoint. Remote
 * connections present a token; local connections never do.
 */

import {
  createSession,
  validateToken,
  revokeSession,
} from "../storage/repo.js";
import {
  DEFAULT_REMOTE_SCOPES,
  type Scope,
} from "./permissions.js";

/** Default token lifetime: 2 hours. Short by design — re-mint with /remote start. */
export const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

export interface MintedToken {
  token: string;
  scopes: Scope[];
  expiresAt: Date;
}

/**
 * Mint a scoped, expiring remote-access token for a user. Returns the raw token
 * (encoded into the access URL/QR) and its metadata for display.
 */
export async function mintRemoteToken(
  userId: string,
  scopes: readonly Scope[] = DEFAULT_REMOTE_SCOPES,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<MintedToken> {
  const expiresAt = new Date(Date.now() + ttlMs);
  const uniqueScopes = [...new Set<Scope>(["chat", ...scopes])];
  const session = await createSession(userId, uniqueScopes, expiresAt);
  return { token: session.token, scopes: uniqueScopes, expiresAt };
}

export interface RemoteAuth {
  ok: true;
  userId: string;
  scopes: Scope[];
  expiresAt: Date | null;
}

export interface RemoteAuthFail {
  ok: false;
  reason: "unknown" | "expired";
}

/** Authenticate a presented remote token. */
export async function authenticate(
  token: string,
): Promise<RemoteAuth | RemoteAuthFail> {
  const res = await validateToken(token);
  if (!res.ok) return { ok: false, reason: res.reason };
  return {
    ok: true,
    userId: res.session.userId,
    scopes: res.session.permissions.filter(isScope),
    expiresAt: res.session.expiresAt,
  };
}

function isScope(s: string): s is Scope {
  return s === "chat" || s === "filesystem" || s === "shell";
}

/** Revoke a token immediately. */
export async function revoke(token: string): Promise<void> {
  await revokeSession(token);
}
