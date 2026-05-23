import readline from "node:readline";
import { WebSocket } from "ws";

/**
 * SkillOS native terminal client.
 *
 * A thin CLI over the same WebSocket protocol the browser terminal uses, so you
 * can drive SkillOS directly from your shell. It renders EVERY server message
 * type (info / chunk / error / done / stage / qr / permission-request) and sends
 * every client message (input / auth / permission-response).
 *
 * Usage:
 *   npm run cli                       # connect to ws://localhost:8787
 *   npm run cli -- --url ws://host    # custom server
 *   npm run cli -- --token <token>    # authenticate a remote session
 *   SKILLOS_URL / SKILLOS_TOKEN env vars also work.
 */

// ---- Protocol (mirrors apps/server/src/types.ts) --------------------------
type ServerMessage =
  | { type: "info"; text: string }
  | { type: "chunk"; text: string }
  | { type: "error"; text: string }
  | { type: "done"; meta: { skill: string | null; model: string; provider: string } }
  | { type: "stage"; agent: string; step: number; total: number; model: string; provider: string }
  | { type: "qr"; art: string; url: string }
  | { type: "permission-request"; id: string; target: string; scopes: string[]; text: string };

// ---- Args / config --------------------------------------------------------
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const URL = arg("--url") ?? process.env.SKILLOS_URL ?? "ws://localhost:8787";
const TOKEN = arg("--token") ?? process.env.SKILLOS_TOKEN;

// ---- ANSI -----------------------------------------------------------------
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[1;32m",
  cyan: "\x1b[1;36m",
  yellow: "\x1b[33m",
};
const PROMPT = `${C.green}skillos>${C.reset} `;

// ---- Terminal I/O ---------------------------------------------------------
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: PROMPT,
});
// Don't read input until the socket is open and the server has greeted us;
// the first `info` calls showPrompt(), which resumes the stream. This also
// prevents piped input from racing ahead of the connection.
rl.pause();

let busy = false; // a turn is in flight; suppress input + the prompt
let pendingNewline = false; // an info/stage banner printed; break before chunks
let pendingPermission: string | null = null; // id of an awaiting permission prompt
let stdinClosed = false; // EOF on input (piped run finished)

function out(text: string): void {
  process.stdout.write(text);
}
/** Print a block on its own line(s), optionally colored. */
function block(text: string, color = ""): void {
  out(`\n${color}${text}${C.reset}`);
}
function showPrompt(): void {
  out("\n");
  rl.prompt();
}
/** End a turn: re-enable input and re-show the prompt (or exit if piped EOF). */
function endTurn(): void {
  busy = false;
  pendingNewline = false;
  pendingPermission = null;
  if (stdinClosed) {
    ws.close();
    process.exit(0);
  }
  rl.resume();
  showPrompt();
}

// ---- Connection -----------------------------------------------------------
out(`${C.green}SkillOS${C.reset} ${C.dim}— connecting to ${URL}…${C.reset}\n`);
const ws = new WebSocket(URL);

ws.on("open", () => {
  if (TOKEN) ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
  // Wait for the server's greeting (an `info`) to drive the first prompt.
});

ws.on("message", (raw: Buffer) => {
  let msg: ServerMessage;
  try {
    msg = JSON.parse(raw.toString()) as ServerMessage;
  } catch {
    return;
  }
  switch (msg.type) {
    case "info":
      block(msg.text, C.dim);
      pendingNewline = true;
      if (!busy) showPrompt(); // greeting / onboarding-start arrive while idle
      break;
    case "chunk":
      if (pendingNewline) {
        out("\n");
        pendingNewline = false;
      }
      out(msg.text);
      break;
    case "stage":
      block(`■ ${msg.agent} [${msg.step}/${msg.total}] (${msg.model})`, C.cyan);
      pendingNewline = true;
      break;
    case "qr":
      block(msg.art, C.cyan);
      block(`Access URL: ${msg.url}`, C.green);
      pendingNewline = true;
      break;
    case "error":
      block(msg.text, C.red);
      endTurn();
      break;
    case "done":
      // Empty model = a non-streaming turn-end signal: just rearm the prompt.
      if (msg.meta.model) block(`[${msg.meta.model} via ${msg.meta.provider}]`, C.dim);
      endTurn();
      break;
    case "permission-request":
      block(msg.text, C.cyan);
      block(`Approve ${msg.target} (${msg.scopes.join(", ")})? [y/N] `, C.yellow);
      pendingPermission = msg.id;
      busy = false; // let the user type the answer
      rl.resume();
      rl.prompt();
      break;
  }
});

ws.on("close", () => {
  block("Disconnected from server.", C.red);
  process.exit(0);
});
ws.on("error", (err: Error) => {
  block(`Connection error: ${err.message}`, C.red);
  block(`Is the server running?  ${C.dim}npm run dev:server${C.reset}`, "");
  process.exit(1);
});

// ---- Input ----------------------------------------------------------------
rl.on("line", (line) => {
  // Defensive: never write to a socket that isn't open yet.
  if (ws.readyState !== WebSocket.OPEN) return;
  const text = line.trim();

  // Answering a pending permission prompt takes precedence.
  if (pendingPermission) {
    const approved = /^y(es)?$/i.test(text);
    ws.send(JSON.stringify({ type: "permission-response", id: pendingPermission, approved }));
    pendingPermission = null;
    busy = true; // wait for the gated action's result
    rl.pause();
    return;
  }

  if (busy) return; // ignore input mid-turn
  if (!text) {
    showPrompt();
    return;
  }
  if (text === "/exit" || text === "/quit") {
    ws.close();
    process.exit(0);
  }

  busy = true;
  pendingNewline = false;
  rl.pause(); // suppress input until the turn completes
  ws.send(JSON.stringify({ type: "input", text }));
});

rl.on("close", () => {
  // EOF (Ctrl-D or end of piped input): exit once any in-flight turn finishes.
  stdinClosed = true;
  if (!busy) {
    ws.close();
    process.exit(0);
  }
});

process.on("SIGINT", () => {
  out("\n");
  ws.close();
  process.exit(0);
});
