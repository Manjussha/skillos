# remote/ — Layer 4 (Remote Access)

Portable, **security-critical** access to your SkillOS terminal from a phone or
another machine: a Cloudflare Tunnel exposes a public URL, a QR code carries a
scoped, expiring session token, and privileged tools prompt for confirmation
before they run.

This directory is the conceptual home for the layer; the implementation lives in
[`apps/server/src/remote/`](../apps/server/src/remote/) and is wired into the
gateway in [`apps/server/src/index.ts`](../apps/server/src/index.ts).

## Commands

| Command | What it does |
| --- | --- |
| `/remote start` | Open remote access: detect `cloudflared`, open a public tunnel (or degrade to a local stand-in), mint a scoped token, and print the access URL + a QR code. Default scopes: `chat`, `filesystem`. |
| `/remote start --shell` | Same, but also grants the `shell` scope to the minted token (still prompted per-use). |
| `/remote status` | Show whether remote is running, the URL, the active-token count, and the current token's scopes/expiry. |
| `/remote stop` | Tear down the tunnel **and revoke every token** minted this session. |

`/remote` is a **host-only** command: it is rejected over remote sessions, so a
connected phone can never mint itself new tokens or open further tunnels.

## Cloudflare Tunnel dependency

The public URL is produced by [`cloudflared`](https://github.com/cloudflare/cloudflared)
(`cloudflared tunnel --url http://localhost:8787`), whose `*.trycloudflare.com`
hostname we scrape from its output.

**`cloudflared` is an optional, external binary — it is not bundled.** Install it
only if you want off-network access:

- macOS: `brew install cloudflared`
- Windows: `winget install --id Cloudflare.cloudflared`
- Linux: see the [Cloudflare downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

### Graceful degradation (works offline)

If `cloudflared` is missing (or the tunnel fails to start), `/remote start` does
**not** crash. It:

1. prints clear install instructions,
2. falls back to a **LOCAL stand-in**: the access URL becomes
   `http://localhost:8787/#token=…`,
3. still mints a token and renders the QR for that local URL.

So the entire layer is verifiable with no network and no extra software —
`node scripts/verify-layer4.mjs` exercises exactly this path.

## Transport

The WebSocket gateway is attached to a small `http.Server` on the same port
(`8787`) so `cloudflared`, which tunnels HTTP and upgrades to WebSocket, can
reach it. A trivial `/health` endpoint answers the tunnel's origin check.
`ws://localhost:8787` keeps working identically for the local client and the
smoke tests — no behavior change for existing flows.

## Token & permission model

The security model has two axes, centralized in
[`remote/permissions.ts`](../apps/server/src/remote/permissions.ts) (the single
auditable source of truth):

### 1. Trust origin

- **Local connections (loopback)** are implicitly trusted: they get a
  full-permission local session and present **no token**. This preserves the
  existing local client and smoke tests unchanged.
- **Remote connections (via the tunnel)** are detected by their forwarded /
  public IP (`cf-connecting-ip` / `x-forwarded-for`, non-loopback
  `remoteAddress`). They are unauthenticated until they present a valid token via
  an `auth` protocol message; until then the session is read-only chat.

### 2. Scoped, expiring tokens

`/remote start` mints a token persisted in the existing `Session` model
(`token`, `permissions`, `expiresAt`):

- **Scoped**: a token carries an explicit set of scopes (`chat`, `filesystem`,
  `shell`). Defaults are least-privilege (`chat`, `filesystem`); `shell` requires
  `--shell`.
- **Expiring**: tokens default to a **2-hour TTL**. Validation
  ([`validateToken`](../apps/server/src/storage/repo.ts)) rejects unknown and
  expired tokens — the single authentication chokepoint.
- **Revocable**: `/remote stop` deletes every token minted that session, so a
  leaked URL stops working immediately.

### 3. Permission enforcement & prompts

A skill/agent declares the tools it needs (`tools: [filesystem, shell]`). Before
running, the gateway calls `ensurePermission`:

- **Local session** → always allowed, never prompted (permissive trust).
- **Remote session**:
  - a required scope the token lacks → **hard deny** (no execution),
  - a *privileged* scope the token holds (`filesystem`/`shell`) → a
    **server→client `permission-request`** the user must approve before the tool
    runs. Holding the scope grants the ability to *ask*, not silent use.
  - prompts auto-deny after 60s, and a disconnect unwinds any pending prompts.

This makes every remote use of a privileged tool an explicit, per-invocation,
human-approved action.

## Protocol additions (Layer 4)

Backward-compatible — older/local clients can ignore them.

- **Client → server**: `{type:"auth", token}`, `{type:"permission-response", id, approved}`
- **Server → client**: `{type:"qr", art, url}`, `{type:"permission-request", id, target, scopes, text}`

## Threat model

| Threat | Mitigation |
| --- | --- |
| **Remote = remote code execution surface** (the project's largest attack surface) | No unauthenticated remote command path: remote sessions are read-only chat until a valid token is presented; privileged tools (shell/filesystem) require explicit per-use approval. |
| **Leaked access URL / token** | Tokens are random (24 bytes), scoped to least privilege, and expire (2h default). `/remote stop` revokes all of them. The token rides in the URL **fragment** (`#token=`), which is not sent to servers or typically logged by proxies. |
| **Privilege escalation from a remote client** | `/remote` (minting tokens, opening tunnels) is host-only; a remote client cannot widen its own scopes or spawn new tunnels. Scopes are enforced server-side, never trusted from the client. |
| **Confused-deputy / silent tool use** | Even with a scope granted, each privileged tool invocation triggers a confirmation prompt the user must approve. |
| **Tunnel/process failure leaking a half-open state** | Tunnel start is bounded by a timeout; failure degrades to local-only and is reported. `/remote stop` always tears down the child process and revokes tokens. |

### Known limits / follow-ups (honest)

- **Shell sandboxing** (ROADMAP's "sandboxing for shell execution") is *not* yet
  implemented — there is currently no shell-executing tool runtime in the
  codebase, so the permission gate is the active control. When a real shell tool
  lands, it must run inside a sandbox; the scope + prompt plumbing is already in
  place to gate it.
- Tokens are bearer tokens with no rotation/refresh beyond re-running
  `/remote start`; fine for v0.1's short-lived, single-user model.
- One active tunnel at a time (re-`start` while running is a no-op with a hint to
  `stop` first).

See [`../ROADMAP.md`](../ROADMAP.md) (Layer 4 + risk register) for context.
