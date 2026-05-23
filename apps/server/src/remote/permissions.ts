/**
 * Centralized permission model (Layer 4 — security pillar).
 *
 * This module is the single source of truth for "what is this connection
 * allowed to do, and when must we ask the user first". It is deliberately small
 * and explicit — no policy engine, no framework — so the security boundary is
 * easy to audit.
 *
 * The model has two axes:
 *   1. Trust origin: a connection is either LOCAL (implicit full trust) or
 *      REMOTE (authenticated via a session token, scoped permissions only).
 *   2. Scopes: capabilities a skill/agent may need. Today the load-bearing ones
 *      mirror the `tools` skills declare: "shell" and "filesystem". "chat" is
 *      always granted (plain model turns with no tools).
 *
 * Key rules:
 *   - LOCAL connections are permissive: every scope is granted and no prompt is
 *     required. This preserves the existing local flow (smoke tests, local
 *     client) with NO token.
 *   - REMOTE connections only hold the scopes their token was minted with, and
 *     any privileged tool (shell/filesystem) requires an explicit, per-invocation
 *     confirmation from the user before execution.
 */

/** Capabilities a skill/agent can require. */
export type Scope = "chat" | "filesystem" | "shell";

/** Scopes that, when used over a REMOTE session, demand a confirmation prompt. */
export const PRIVILEGED_SCOPES: readonly Scope[] = ["filesystem", "shell"];

/** The full set of grantable scopes (what a LOCAL session implicitly holds). */
export const ALL_SCOPES: readonly Scope[] = ["chat", "filesystem", "shell"];

/**
 * The default scopes a freshly minted REMOTE token receives. Conservative by
 * design: a phone driving the terminal can chat and read the filesystem, but
 * shell access is NOT granted by default and must be explicitly requested when
 * minting (`/remote start --shell`). Least privilege.
 */
export const DEFAULT_REMOTE_SCOPES: readonly Scope[] = ["chat", "filesystem"];

/** Per-connection trust + granted scopes. */
export interface PermissionContext {
  /** "local" = implicit full trust; "remote" = token-scoped. */
  origin: "local" | "remote";
  /** Scopes this connection holds. For local this is ALL_SCOPES. */
  scopes: Set<Scope>;
}

/** Build the permission context for a trusted local connection. */
export function localContext(): PermissionContext {
  return { origin: "local", scopes: new Set(ALL_SCOPES) };
}

/** Build the permission context for an authenticated remote connection. */
export function remoteContext(grantedScopes: string[]): PermissionContext {
  const scopes = new Set<Scope>(["chat"]);
  for (const s of grantedScopes) {
    if (isScope(s)) scopes.add(s);
  }
  return { origin: "remote", scopes };
}

function isScope(s: string): s is Scope {
  return s === "chat" || s === "filesystem" || s === "shell";
}

/**
 * Map a skill/agent's declared `tools` to the scopes it needs. Unknown tool
 * names are ignored (they don't grant anything). A skill with no privileged
 * tools needs only "chat".
 */
export function scopesForTools(tools: readonly string[]): Scope[] {
  const out: Scope[] = [];
  for (const t of tools) {
    const name = t.trim().toLowerCase();
    if (name === "shell" && !out.includes("shell")) out.push("shell");
    else if (name === "filesystem" && !out.includes("filesystem"))
      out.push("filesystem");
  }
  return out;
}

/** The privileged scopes among a tool list (the ones a prompt would cover). */
export function privilegedScopesForTools(tools: readonly string[]): Scope[] {
  return scopesForTools(tools).filter((s) =>
    (PRIVILEGED_SCOPES as readonly Scope[]).includes(s),
  );
}

export interface Decision {
  /** True if execution may proceed (possibly after a prompt). */
  allowed: boolean;
  /** True if the user must explicitly confirm before execution. */
  needsPrompt: boolean;
  /** Scopes the connection lacks entirely (hard deny). */
  missing: Scope[];
  /** Privileged scopes that trigger the confirmation prompt. */
  prompted: Scope[];
}

/**
 * Decide whether a connection may run something needing `requiredScopes`.
 *
 * - LOCAL: always allowed, never prompted (permissive trust).
 * - REMOTE: any required scope the token lacks is a hard deny. Any privileged
 *   scope the token *does* hold still requires a confirmation prompt before the
 *   tool runs — holding the scope grants the *ability* to ask, not silent use.
 */
export function decide(
  ctx: PermissionContext,
  requiredScopes: readonly Scope[],
): Decision {
  if (ctx.origin === "local") {
    return { allowed: true, needsPrompt: false, missing: [], prompted: [] };
  }
  const missing: Scope[] = [];
  const prompted: Scope[] = [];
  for (const scope of requiredScopes) {
    if (scope === "chat") continue;
    if (!ctx.scopes.has(scope)) {
      missing.push(scope);
      continue;
    }
    if ((PRIVILEGED_SCOPES as readonly Scope[]).includes(scope)) {
      prompted.push(scope);
    }
  }
  return {
    allowed: missing.length === 0,
    needsPrompt: prompted.length > 0,
    missing,
    prompted,
  };
}
