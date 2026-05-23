import { config } from "dotenv";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { parse } from "./parser.js";
import { loadSkills, skillsDir } from "./skills/engine.js";
import { routeModel, KNOWN_MODELS } from "./router/router.js";
import {
  resolveProvider,
  streamCompletion,
  type RouteMode,
} from "./providers/provider.js";
import type { ClientMessage, ServerMessage, Skill } from "./types.js";
import { ensureDb } from "./storage/db.js";
import {
  getLocalUser,
  getProfile,
  saveProfile,
  saveMessage,
  createSession,
  parseStringList,
} from "./storage/repo.js";
import {
  newOnboarding,
  promptFor,
  applyAnswer,
  toProfileInput,
  selectActiveSkills,
  type OnboardingState,
} from "./onboarding/flow.js";
import { generateSkills } from "./onboarding/generate.js";
import { applyProviderChoice } from "./onboarding/env.js";
import {
  listAgents,
  listWorkflows,
  getAgent,
  getWorkflow,
} from "./agents/registry.js";
import {
  runSingleAgent,
  runWorkflow,
  type AgentSink,
  type WorkflowResult,
} from "./agents/runtime.js";
import { getAgentTools, getWorkflowTools } from "./agents/registry.js";
import { authenticate } from "./remote/tokens.js";
import {
  localContext,
  remoteContext,
  decide,
  privilegedScopesForTools,
  type PermissionContext,
  type Scope,
} from "./remote/permissions.js";
import {
  startRemote,
  stopRemote,
  statusRemote,
  type RemoteOutput,
} from "./remote/manager.js";
import {
  connectBridge,
  listConnected,
  resolveWrapper,
  availableTargets,
} from "./bridges/registry.js";
import type { Bridge, BridgeSink } from "./bridges/types.js";

config({ path: resolve(process.cwd(), "../../.env") });

const PORT = Number(process.env.PORT ?? 8787);
const DEFAULT_SYSTEM = "You are SkillOS, a concise and helpful AI assistant.";

interface PendingPermission {
  resolve: (approved: boolean) => void;
  /** Timer that auto-denies if the user never answers. */
  timer: ReturnType<typeof setTimeout>;
}

interface Session {
  override: string | null;
  /** DB user id (single local user in v0.1). */
  userId: string;
  /** DB session id for namespacing message history. */
  sessionId: string;
  /** Active onboarding flow, or null when not onboarding. */
  onboarding: OnboardingState | null;
  /** Skill names auto-activated for this user (from their profile). */
  activeSkills: Set<string>;
  /** Routing mode from the profile (fast/best/cheapest/local); biases provider+model. */
  mode: RouteMode;
  /**
   * Layer 4: trust origin + granted scopes. Local connections get a permissive
   * local context; remote connections start unauthenticated until they present
   * a valid token via an `auth` message.
   */
  perms: PermissionContext;
  /** Whether this connection came from localhost (implicit trust). */
  isLocal: boolean;
  /** True once a remote connection has authenticated (no-op for local). */
  authenticated: boolean;
  /** In-flight permission prompts awaiting a client response, by id. */
  pendingPermissions: Map<string, PendingPermission>;
}

const dir = skillsDir();
const skills = await loadSkills(dir);
console.log(`[skillos] loaded ${skills.size} skills from ${dir}`);

// Initialize persistence before accepting connections so failures surface early.
await ensureDb();
console.log("[skillos] database ready");

// Layer 4: attach the WebSocket server to an http.Server so cloudflared (which
// tunnels HTTP and upgrades to WS) can reach the gateway. ws://localhost:8787
// keeps working exactly as before — same port, same path. A tiny HTTP handler
// answers health checks so the tunnel sees a live origin.
const httpServer = createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("SkillOS gateway OK");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`[skillos] gateway listening on ws://localhost:${PORT}`);
});

wss.on("connection", (ws, req) => {
  void initConnection(ws, req);
});

/**
 * Decide whether a connection is local (loopback) and therefore implicitly
 * trusted. Remote connections (via the tunnel) carry a forwarded/public IP and
 * must authenticate with a token.
 */
function isLocalRequest(req: IncomingMessage): boolean {
  // cloudflared forwards the original client; presence of these headers means
  // the request did NOT originate on this machine.
  if (req.headers["cf-connecting-ip"]) return false;
  if (req.headers["x-forwarded-for"]) return false;
  const addr = req.socket.remoteAddress ?? "";
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr === "localhost"
  );
}

async function initConnection(
  ws: WebSocket,
  req: IncomingMessage,
): Promise<void> {
  const user = await getLocalUser();
  const dbSession = await createSession(user.id);
  const profile = await getProfile(user.id);

  const isLocal = isLocalRequest(req);

  const session: Session = {
    override: null,
    userId: user.id,
    sessionId: dbSession.id,
    onboarding: null,
    activeSkills: new Set(profile ? parseStringList(profile.activeSkills) : []),
    mode: (profile?.mode as RouteMode) ?? "best",
    // Local connections are implicitly trusted with full scopes. Remote
    // connections get an empty (chat-only) context until they authenticate.
    perms: isLocal ? localContext() : remoteContext([]),
    isLocal,
    authenticated: isLocal,
    pendingPermissions: new Map(),
  };

  if (!isLocal) {
    // A remote connection must authenticate before doing anything. We still
    // greet it, but gate all input until a valid `auth` arrives.
    send(ws, {
      type: "info",
      text:
        "Remote connection. Authenticate with your session token (the access " +
        "URL carries it). Without a valid token this session is read-only chat.",
    });
  } else if (profile) {
    send(ws, {
      type: "info",
      text:
        `Connected. ${skills.size} skills loaded · profile: ${profile.userType} (${profile.mode}). ` +
        `Type /help to start.`,
    });
  } else {
    send(ws, {
      type: "info",
      text: `Connected. ${skills.size} skills loaded. First run — let's set up.`,
    });
    startOnboarding(ws, session);
  }

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send(ws, { type: "error", text: "Malformed message." });
      return;
    }
    if (msg.type === "auth") {
      void handleAuth(ws, session, msg.token);
      return;
    }
    if (msg.type === "permission-response") {
      resolvePermission(session, msg.id, msg.approved);
      return;
    }
    if (msg.type === "input") void handleInput(ws, session, msg.text);
  });

  ws.on("close", () => {
    // Auto-deny any outstanding prompts so blocked turns unwind.
    for (const [, p] of session.pendingPermissions) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    session.pendingPermissions.clear();
  });
}

// ---------------------------------------------------------------------------
// Layer 4: remote auth + permission prompts
// ---------------------------------------------------------------------------

/** Authenticate a remote connection presenting a token. */
async function handleAuth(
  ws: WebSocket,
  session: Session,
  token: string,
): Promise<void> {
  if (session.isLocal) {
    // Local connections are already fully trusted; ignore stray tokens.
    return;
  }
  const auth = await authenticate(token);
  if (!auth.ok) {
    send(ws, {
      type: "error",
      text:
        auth.reason === "expired"
          ? "Session token expired. Ask the host to run /remote start for a fresh one."
          : "Invalid session token. Access denied.",
    });
    return;
  }
  session.perms = remoteContext(auth.scopes);
  session.authenticated = true;
  send(ws, {
    type: "info",
    text:
      `Authenticated (remote). Scopes: ${auth.scopes.join(", ")}. ` +
      `Privileged tools (shell/filesystem) will ask for confirmation. Type /help.`,
  });
}

/** Resolve a pending permission prompt from the client's response. */
function resolvePermission(
  session: Session,
  id: string,
  approved: boolean,
): void {
  const pending = session.pendingPermissions.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  session.pendingPermissions.delete(id);
  pending.resolve(approved);
}

/**
 * Enforce the permission model for an action needing `tools` over this session.
 * Returns true if execution may proceed. For remote sessions this:
 *   - hard-denies missing scopes,
 *   - prompts (server→client) for privileged scopes and awaits approval.
 * Local sessions always pass with no prompt.
 */
async function ensurePermission(
  ws: WebSocket,
  session: Session,
  target: string,
  tools: readonly string[],
): Promise<boolean> {
  const required: Scope[] = ["chat", ...privilegedScopesForTools(tools)];
  const d = decide(session.perms, required);

  if (!d.allowed) {
    send(ws, {
      type: "error",
      text:
        `Permission denied: "${target}" needs ${d.missing.join(", ")} which ` +
        `your remote session is not granted. The host can re-run /remote start ` +
        `with broader scopes.`,
    });
    return false;
  }
  if (!d.needsPrompt) return true;

  // Privileged tool over a remote session — require explicit confirmation.
  const id = randomBytes(8).toString("hex");
  const approved = await new Promise<boolean>((resolveApproved) => {
    const timer = setTimeout(() => {
      session.pendingPermissions.delete(id);
      resolveApproved(false);
    }, 60000);
    session.pendingPermissions.set(id, { resolve: resolveApproved, timer });
    send(ws, {
      type: "permission-request",
      id,
      target,
      scopes: d.prompted,
      text:
        `"${target}" wants to use ${d.prompted.join(", ")} on the host machine. ` +
        `Approve this remote action?`,
    });
  });

  if (!approved) {
    send(ws, {
      type: "error",
      text: `Denied: "${target}" was not approved (${d.prompted.join(", ")}).`,
    });
  }
  return approved;
}

async function handleInput(
  ws: WebSocket,
  session: Session,
  text: string,
): Promise<void> {
  // While onboarding, most input feeds the flow — but allow re-running setup.
  if (session.onboarding) {
    const trimmed = text.trim().toLowerCase();
    if (trimmed === "/onboarding") startOnboarding(ws, session);
    else await advanceOnboarding(ws, session, text);
    return endTurn(ws);
  }

  const cmd = parse(text);

  if (cmd.kind === "command") {
    const name = cmd.name ?? "";
    switch (name) {
      // --- Streaming branches: each emits its own `done`, so they ARE the
      //     turn-end signal — return without an extra endTurn. ---
      case "agent": {
        const parts = cmd.args.split(/\s+/);
        const agentName = parts[0] ?? "";
        return runSingle(ws, session, agentName, parts.slice(1).join(" "));
      }
      case "build-dashboard":
      case "build-api":
        return runWorkflowCommand(ws, session, name, cmd.args);
      case "run": {
        const parts = cmd.args.split(/\s+/);
        const targetName = parts[0] ?? "";
        const rest = parts.slice(1).join(" ");
        // Layer 5: a connected bridge wrapper takes precedence for /run, then
        // we fall back to normal skills so Layer 1/2 behavior is preserved.
        if (resolveWrapper(targetName))
          return runBridge(ws, session, targetName, rest);
        return runSkill(ws, session, targetName, rest);
      }

      // --- Info-only branches: produce output, then fall through to a single
      //     endTurn() below so the client knows the turn is complete. ---
      case "help":
        sendHelp(ws);
        break;
      case "skills":
        sendSkills(ws, session);
        break;
      case "models":
        sendModels(ws, session);
        break;
      case "use":
        setModel(ws, session, cmd.args);
        break;
      case "onboarding":
        startOnboarding(ws, session);
        break;
      case "profile":
        await sendProfile(ws, session);
        break;
      case "generate-skills":
        await doGenerateSkills(ws, cmd.args);
        break;
      case "remote":
        await doRemote(ws, session, cmd.args);
        break;
      case "connect":
        await doConnect(ws, cmd.args);
        break;
      case "bridges":
        sendBridges(ws);
        break;
      case "agents":
        sendAgents(ws);
        break;
      default:
        // Layer 5: a connected bridge wrapper is runnable as a bare command too.
        if (resolveWrapper(name)) return runBridge(ws, session, name, cmd.args);
        if (skills.has(name)) return runSkill(ws, session, name, cmd.args);
        // Any registered workflow is runnable as a bare command, like skills.
        if (getWorkflow(name))
          return runWorkflowCommand(ws, session, name, cmd.args);
        // An `error` is itself a turn-end on the client — no extra endTurn.
        send(ws, {
          type: "error",
          text: `Unknown command "/${name}". Try /help.`,
        });
        return;
    }
    return endTurn(ws);
  }

  if (!cmd.args) return endTurn(ws);
  await run(ws, session, null, cmd.args); // emits its own `done`
}

/**
 * Signal the end of a non-streaming input turn so clients can re-show the
 * prompt. Reuses the `done` message with empty model meta (clients render no
 * meta line for it, but treat it as a turn boundary just like a model `done`).
 */
function endTurn(ws: WebSocket): void {
  send(ws, { type: "done", meta: { skill: null, model: "", provider: "" } });
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

function startOnboarding(ws: WebSocket, session: Session): void {
  // Onboarding sets provider credentials (writes .env) — restrict it to the
  // local terminal so a remote client can never configure keys or read prompts.
  if (!session.isLocal) {
    send(ws, {
      type: "info",
      text: "Onboarding and provider/key setup are available on the local terminal only.",
    });
    return;
  }
  session.onboarding = newOnboarding();
  send(ws, { type: "info", text: promptFor(session.onboarding.step) });
}

async function advanceOnboarding(
  ws: WebSocket,
  session: Session,
  answer: string,
): Promise<void> {
  if (!session.onboarding) return;
  session.onboarding = applyAnswer(session.onboarding, answer);

  if (session.onboarding.step !== "done") {
    send(ws, { type: "info", text: promptFor(session.onboarding.step) });
    return;
  }

  // Flow finished — auto-load skills and persist the profile.
  const active = selectActiveSkills(
    { userType: session.onboarding.userType, stacks: session.onboarding.stacks },
    skills,
  );
  const input = toProfileInput(session.onboarding, active);
  await saveProfile(session.userId, input);
  session.activeSkills = new Set(active);
  session.mode = input.mode as RouteMode;

  // Apply the chosen provider/key: writes .env (gitignored) and updates
  // process.env so it's live immediately — no restart needed.
  const provider = session.onboarding.provider;
  const apiKey = session.onboarding.apiKey;
  session.onboarding = null;
  const env = await applyProviderChoice(provider, apiKey);

  const summary = [
    "Profile saved:",
    `  use-case: ${input.useCase || input.userType}`,
    `  type:     ${input.userType}`,
    `  stacks:   ${input.stacks.length ? input.stacks.join(", ") : "(none)"}`,
    `  mode:     ${input.mode}`,
    `  provider: ${provider}`,
    `  active skills: ${active.length ? active.map((s) => "/" + s).join(", ") : "(none)"}`,
    "",
    env.message,
    "",
    input.userType === "business"
      ? `Tip: run /generate-skills ${input.useCase} to create custom skills for your domain.`
      : "Type /help to start, or /generate-skills <domain> to create custom skills.",
  ].join("\n");
  send(ws, { type: "info", text: summary });
}

async function sendProfile(ws: WebSocket, session: Session): Promise<void> {
  const profile = await getProfile(session.userId);
  if (!profile) {
    send(ws, {
      type: "info",
      text: "No profile yet. Run /onboarding to set one up.",
    });
    return;
  }
  const stacks = parseStringList(profile.stacks);
  const active = parseStringList(profile.activeSkills);
  send(ws, {
    type: "info",
    text: [
      "Your profile:",
      `  use-case: ${profile.useCase || profile.userType}`,
      `  type:     ${profile.userType}`,
      `  stacks:   ${stacks.length ? stacks.join(", ") : "(none)"}`,
      `  mode:     ${profile.mode}`,
      `  active skills: ${active.length ? active.map((s) => "/" + s).join(", ") : "(none)"}`,
      "",
      "Run /onboarding to change it.",
    ].join("\n"),
  });
}

async function doGenerateSkills(ws: WebSocket, description: string): Promise<void> {
  const desc = description.trim();
  if (!desc) {
    send(ws, {
      type: "error",
      text: "Usage: /generate-skills <describe your domain>",
    });
    return;
  }
  send(ws, { type: "info", text: `Generating skills for: "${desc}"…` });
  try {
    const result = await generateSkills(desc);
    const lines: string[] = [];
    if (result.written.length) {
      lines.push(`Generated ${result.written.length} skill(s) (source: ${result.source}):`);
      for (const w of result.written) lines.push(`  /${w.name}`);
      lines.push("");
      lines.push("Restart the server (tsx watch reloads skills on boot) to activate them.");
    } else {
      lines.push("No skills passed the quality gate.");
    }
    if (result.rejected.length) {
      lines.push("");
      lines.push("Rejected:");
      for (const r of result.rejected) {
        lines.push(`  ${r.name ?? "(unnamed)"} — ${r.reason}`);
      }
    }
    send(ws, { type: "info", text: lines.join("\n") });
  } catch (err) {
    send(ws, {
      type: "error",
      text: `Skill generation failed: ${(err as Error).message}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Remote access (Layer 4) — tunnel, tokens, QR
// ---------------------------------------------------------------------------

/**
 * Dispatch `/remote start|stop|status`. Minting a token is a host action, so
 * it's restricted to local (fully trusted) sessions — a remote phone cannot
 * mint itself new tokens or open further tunnels.
 */
async function doRemote(
  ws: WebSocket,
  session: Session,
  args: string,
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? "status").toLowerCase();
  const flags = parts.slice(1);

  if (!session.isLocal) {
    send(ws, {
      type: "error",
      text: "/remote is a host-only command and is not available over remote sessions.",
    });
    return;
  }

  switch (sub) {
    case "start": {
      // Opt into shell scope explicitly (least privilege by default).
      const scopes: Scope[] = ["chat", "filesystem"];
      if (flags.includes("--shell")) scopes.push("shell");
      send(ws, { type: "info", text: "Starting remote access…" });
      const out = await startRemote(session.userId, PORT, scopes);
      emitRemote(ws, out);
      return;
    }
    case "stop": {
      const out = await stopRemote();
      emitRemote(ws, out);
      return;
    }
    case "status": {
      emitRemote(ws, statusRemote());
      return;
    }
    default:
      send(ws, {
        type: "error",
        text: "Usage: /remote start [--shell] | /remote stop | /remote status",
      });
  }
}

/** Write a RemoteOutput (info lines + optional QR) to the client. */
function emitRemote(ws: WebSocket, out: RemoteOutput): void {
  send(ws, { type: "info", text: out.lines.join("\n") });
  if (out.qr) {
    // The QR encodes the access URL; pull the URL line back out for the message.
    const urlLine = out.lines.find((l) => l.trim().startsWith("Access:"));
    const url = urlLine ? urlLine.split("Access:")[1]?.trim() ?? "" : "";
    send(ws, { type: "qr", art: out.qr, url });
  }
}

// ---------------------------------------------------------------------------
// Agents (Layer 3) — multi-step skill orchestration
// ---------------------------------------------------------------------------

function sendAgents(ws: WebSocket): void {
  const agents = listAgents()
    .map((a) => `  ${a.name.padEnd(10)} — ${a.description}`)
    .join("\n");
  const workflows = listWorkflows()
    .map((w) => `  /${w.name.padEnd(16)} ${w.description} (${w.steps.join(" → ")})`)
    .join("\n");
  send(ws, {
    type: "info",
    text: [
      "Agents:",
      agents,
      "",
      "Workflows:",
      workflows,
      "",
      "Run a single agent:  /agent <name> <task>",
      "Run a workflow:      /<workflow> <task>",
    ].join("\n"),
  });
}

/**
 * Build a sink that maps runtime events onto the WebSocket protocol and
 * persists each stage best-effort. Stage headers go out as both a structured
 * `stage` message and a human-readable `info` line so any client sees progress.
 */
function makeSink(ws: WebSocket, session: Session): AgentSink {
  return {
    onStageStart(info) {
      send(ws, {
        type: "stage",
        agent: info.agent.name,
        step: info.step,
        total: info.total,
        model: info.model,
        provider: info.provider,
      });
      const counter = info.total > 1 ? ` [${info.step}/${info.total}]` : "";
      send(ws, {
        type: "info",
        text: `▸ ${info.agent.name}${counter} · model: ${info.model} · provider: ${info.provider}`,
      });
    },
    onChunk(text) {
      send(ws, { type: "chunk", text });
    },
    onStageEnd(info, output) {
      // Per-stage footer is an `info` line, not `done`: a workflow is a single
      // user turn, so we emit exactly one `done` at the end (in reportWorkflow)
      // to keep the Layer 1 prompt-rearm contract intact.
      send(ws, {
        type: "info",
        text: `└ ${info.agent.name} done · ${info.model} via ${info.provider}`,
      });
      void saveMessage({
        userId: session.userId,
        sessionId: session.sessionId,
        role: "assistant",
        content: output,
        model: info.model,
        skill: info.agent.name,
      }).catch(() => {});
    },
    onError(message) {
      send(ws, { type: "error", text: message });
    },
  };
}

async function runSingle(
  ws: WebSocket,
  session: Session,
  name: string,
  task: string,
): Promise<void> {
  if (!name) {
    send(ws, {
      type: "error",
      text: "Usage: /agent <name> <task>. See /agents for names.",
    });
    return;
  }
  if (!getAgent(name)) {
    send(ws, {
      type: "error",
      text: `Unknown agent "${name}". See /agents.`,
    });
    return;
  }
  if (!task.trim()) {
    send(ws, {
      type: "error",
      text: `Agent "${name}" needs a task, e.g. /agent ${name} <your task>`,
    });
    return;
  }
  // Layer 4: agents may declare privileged tools — gate them for remote sessions.
  if (!(await ensurePermission(ws, session, `agent ${name}`, getAgentTools(name))))
    return;
  // Persist the user turn (best-effort).
  void saveMessage({
    userId: session.userId,
    sessionId: session.sessionId,
    role: "user",
    content: task,
    skill: name,
  }).catch(() => {});

  const result = await runSingleAgent(name, task, makeSink(ws, session), session.mode);
  reportWorkflow(ws, name, result);
}

async function runWorkflowCommand(
  ws: WebSocket,
  session: Session,
  name: string,
  task: string,
): Promise<void> {
  const wf = getWorkflow(name);
  if (!wf) {
    send(ws, { type: "error", text: `Unknown workflow "${name}". See /agents.` });
    return;
  }
  if (!task.trim()) {
    send(ws, {
      type: "error",
      text: `Usage: /${name} <what to build>, e.g. /${name} a sales dashboard`,
    });
    return;
  }
  // Layer 4: a workflow inherits the union of its agents' privileged tools.
  if (
    !(await ensurePermission(ws, session, `/${name}`, getWorkflowTools(name)))
  )
    return;
  send(ws, {
    type: "info",
    text: `Workflow /${wf.name}: ${wf.steps.join(" → ")}\nTask: ${task}`,
  });
  // Persist the user turn (best-effort).
  void saveMessage({
    userId: session.userId,
    sessionId: session.sessionId,
    role: "user",
    content: task,
    skill: wf.name,
  }).catch(() => {});

  const result = await runWorkflow(wf, task, makeSink(ws, session), session.mode);
  reportWorkflow(ws, name, result);
}

function reportWorkflow(
  ws: WebSocket,
  name: string,
  result: WorkflowResult | null,
): void {
  if (!result) {
    // onError already sent an `error` (which re-arms the client prompt).
    send(ws, { type: "error", text: `"${name}" produced no result.` });
    return;
  }
  if (result.ok) {
    send(ws, {
      type: "info",
      text: `✓ ${name} complete — ${result.stages.length} stage(s): ${result.stages
        .map((s) => s.agent)
        .join(" → ")}`,
    });
  }
  // Exactly one `done` per user turn re-arms the client prompt (Layer 1
  // contract). Report the last stage's model in the metadata.
  const last = result.stages[result.stages.length - 1];
  send(ws, {
    type: "done",
    meta: {
      skill: name,
      model: last ? lastModelFor(name, last.agent) : "none",
      provider: "agents",
    },
  });
}

/** Resolve the logical model an agent used, for `done` metadata. */
function lastModelFor(_workflow: string, agentName: string): string {
  const agent = getAgent(agentName);
  if (!agent) return "default";
  return agent.model ?? agent.category ?? "default";
}

// ---------------------------------------------------------------------------
// Terminal bridges (Layer 5) — connect external terminals, proxy + stream
// ---------------------------------------------------------------------------

/**
 * `/connect <target>` (shell | aider). Runs the bridge's detection, registers
 * it, and reports the generated wrappers. Graceful by design: a missing external
 * tool (e.g. aider) connects as "unavailable" with an install hint — never an
 * error — so the bridge mechanism is demonstrable offline.
 */
async function doConnect(ws: WebSocket, args: string): Promise<void> {
  const target = args.trim().split(/\s+/)[0] ?? "";
  if (!target) {
    send(ws, {
      type: "info",
      text: `Usage: /connect <target>. Available: ${availableTargets().join(", ")}.`,
    });
    return;
  }
  const result = await connectBridge(target);
  if (!result.ok || !result.bridge) {
    send(ws, { type: "error", text: result.error ?? `Could not connect "${target}".` });
    return;
  }
  const b = result.bridge;
  const wrappers = result.wrappers ?? [];
  const statusLabel =
    b.status === "ready" ? "ready" : b.status === "unavailable" ? "UNAVAILABLE" : "error";
  const lines = [
    `Connected bridge "${b.name}" — status: ${statusLabel}.`,
    b.note ? b.note : "",
    "",
    `Generated ${wrappers.length} wrapper command(s):`,
    ...wrappers.map(
      (w) =>
        `  /run ${w.name}${w.tools.length ? `  [tools: ${w.tools.join(", ")}]` : ""} — ${w.description}`,
    ),
    "",
    b.status === "ready"
      ? `Run one with: /run ${wrappers[0]?.name ?? b.name} <input>`
      : `The tool is missing, but the wrappers above are registered. ` +
        `Install it, then re-run /connect ${b.name}.`,
  ].filter((l) => l !== "");
  send(ws, { type: "info", text: lines.join("\n") });
}

/** `/bridges` — list connected bridges with their status + capabilities. */
function sendBridges(ws: WebSocket): void {
  const bridges = listConnected();
  if (bridges.length === 0) {
    send(ws, {
      type: "info",
      text: `No bridges connected. Connect one with /connect <${availableTargets().join("|")}>.`,
    });
    return;
  }
  const blocks = bridges.map((b: Bridge) => {
    const statusLabel =
      b.status === "ready" ? "ready" : b.status === "unavailable" ? "unavailable" : "error";
    const caps = b.capabilities
      .map((c) => `      - ${c.id}: ${c.description}${c.tools.length ? ` [${c.tools.join(", ")}]` : ""}`)
      .join("\n");
    const cmds = b.commands.map((c) => `      /run ${c.name}`).join("\n");
    return [
      `  ${b.name} (${statusLabel}) — ${b.description}`,
      b.note ? `    note: ${b.note.split("\n")[0]}` : "",
      "    capabilities:",
      caps,
      "    commands:",
      cmds,
    ]
      .filter((l) => l !== "")
      .join("\n");
  });
  send(ws, {
    type: "info",
    text: ["Connected bridges:", ...blocks].join("\n"),
  });
}

/**
 * Proxy `/run <wrapped>` to a connected bridge's command, streaming its output.
 * Goes through the SAME Layer 4 permission gate as skills/agents: the wrapper's
 * tools (e.g. ["shell"]) drive ensurePermission, so over a remote session shell
 * execution requires explicit confirmation.
 */
async function runBridge(
  ws: WebSocket,
  session: Session,
  name: string,
  input: string,
): Promise<void> {
  const wrapper = resolveWrapper(name);
  if (!wrapper) {
    send(ws, {
      type: "error",
      text: `No connected bridge command "${name}". See /bridges, or /connect first.`,
    });
    return;
  }
  // Layer 4 permission gate — identical path to skills/agents. Shell/filesystem
  // tools prompt for confirmation over a remote session; local stays permissive.
  if (!(await ensurePermission(ws, session, `/run ${name}`, wrapper.tools))) return;

  send(ws, {
    type: "info",
    text: `→ bridge: ${wrapper.bridge.name} · command: ${name} · status: ${wrapper.bridge.status}`,
  });

  // Persist the user turn (best-effort), like the core loop.
  void saveMessage({
    userId: session.userId,
    sessionId: session.sessionId,
    role: "user",
    content: input,
    skill: `bridge:${name}`,
  }).catch(() => {});

  let collected = "";
  const sink: BridgeSink = {
    onChunk(chunk) {
      collected += chunk.text;
      // stderr is prefixed inline so the user can tell streams apart; both go
      // out as `chunk` so any existing client renders them with no changes.
      send(ws, { type: "chunk", text: chunk.text });
    },
    onInfo(text) {
      send(ws, { type: "info", text });
    },
  };

  const result = await wrapper.bridge.run(name, input, sink);

  if (!result.ok && result.error) {
    send(ws, { type: "error", text: result.error });
    return;
  }

  // One `done` per turn re-arms the client prompt (Layer 1 contract).
  send(ws, {
    type: "done",
    meta: {
      skill: `bridge:${name}`,
      model: wrapper.bridge.name,
      provider: `bridge:${wrapper.bridge.name}`,
    },
  });

  void saveMessage({
    userId: session.userId,
    sessionId: session.sessionId,
    role: "assistant",
    content: collected,
    model: wrapper.bridge.name,
    skill: `bridge:${name}`,
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Core loop (Layer 1) + message persistence
// ---------------------------------------------------------------------------

async function runSkill(
  ws: WebSocket,
  session: Session,
  name: string,
  args: string,
): Promise<void> {
  const skill = skills.get(name) ?? null;
  if (!skill) {
    send(ws, { type: "error", text: `No skill named "${name}". Try /skills.` });
    return;
  }
  if (!args.trim()) {
    send(ws, {
      type: "error",
      text: `Skill "${name}" needs input, e.g. /${name} <your text>`,
    });
    return;
  }
  // Layer 4: enforce scoped permissions / prompt for privileged tools.
  if (!(await ensurePermission(ws, session, `/${name}`, skill.tools))) return;
  await run(ws, session, skill, args);
}

async function run(
  ws: WebSocket,
  session: Session,
  skill: Skill | null,
  content: string,
): Promise<void> {
  const model = routeModel(skill, session.override);
  const res = resolveProvider(model, session.mode);
  const system = skill?.prompt || DEFAULT_SYSTEM;

  send(ws, {
    type: "info",
    text: `→ skill: ${skill?.name ?? "(none)"} · model: ${model} · provider: ${res.provider}`,
  });

  // Persist the user turn (best-effort; never block the model on a DB error).
  void saveMessage({
    userId: session.userId,
    sessionId: session.sessionId,
    role: "user",
    content,
    skill: skill?.name ?? null,
  }).catch(() => {});

  let assistant = "";
  try {
    for await (const chunk of streamCompletion(res, system, content)) {
      assistant += chunk;
      send(ws, { type: "chunk", text: chunk });
    }
    send(ws, {
      type: "done",
      meta: { skill: skill?.name ?? null, model, provider: res.provider },
    });
    void saveMessage({
      userId: session.userId,
      sessionId: session.sessionId,
      role: "assistant",
      content: assistant,
      model,
      skill: skill?.name ?? null,
    }).catch(() => {});
  } catch (err) {
    send(ws, {
      type: "error",
      text: `Provider error: ${(err as Error).message}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Command output
// ---------------------------------------------------------------------------

function sendHelp(ws: WebSocket): void {
  send(ws, {
    type: "info",
    text: [
      "Commands:",
      "  /help                  show this help",
      "  /skills                list available skills (active ones marked *)",
      "  /models                list known models + current override",
      "  /use <model>           force a model (e.g. /use claude); /use auto to clear",
      "  /onboarding            (re)run first-run personalization",
      "  /profile               show your saved profile",
      "  /generate-skills <d>   generate custom skills for a described domain",
      "  /agents                list built-in agents and workflows",
      "  /agent <name> <task>   run a single agent (planner|coder|reviewer|writer)",
      "  /build-dashboard <d>   workflow: plan → code → review a dashboard",
      "  /build-api <d>         workflow: plan → code → review an API",
      "  /remote start [--shell]  open remote access (tunnel + token + QR)",
      "  /remote status         show remote state, URL, active tokens",
      "  /remote stop           tear down the tunnel and revoke tokens",
      "  /connect <target>      connect a terminal bridge (shell | aider)",
      "  /bridges               list connected bridges + their capabilities",
      "  /run <skill|wrapped> … run a skill or a connected bridge command",
      "  /<skill> …             shortcut to run a skill",
      "  <text>                 free prompt (default routing)",
    ].join("\n"),
  });
}

function sendSkills(ws: WebSocket, session: Session): void {
  if (skills.size === 0) {
    send(ws, { type: "info", text: "No skills loaded." });
    return;
  }
  const lines = [...skills.values()]
    .sort(
      (a, b) =>
        a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
    )
    .map((s) => {
      const mark = session.activeSkills.has(s.name) ? "*" : " ";
      return `${mark} /${s.name}  [${s.category}] — ${s.description}`;
    });
  const note = session.activeSkills.size
    ? "\n(* = active for your profile)"
    : "";
  send(ws, { type: "info", text: "Skills:\n" + lines.join("\n") + note });
}

function sendModels(ws: WebSocket, session: Session): void {
  send(ws, {
    type: "info",
    text: `Known models: ${KNOWN_MODELS.join(", ")}\nCurrent override: ${session.override ?? "auto"}`,
  });
}

function setModel(ws: WebSocket, session: Session, arg: string): void {
  const m = arg.trim().toLowerCase();
  if (!m || m === "auto") {
    session.override = null;
    send(ws, { type: "info", text: "Model override cleared (auto routing)." });
    return;
  }
  session.override = m;
  send(ws, { type: "info", text: `Model override set to "${m}".` });
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
