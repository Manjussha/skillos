// Layer 5 verification: drive the terminal-bridges layer over a LOCAL connection.
//
// Confirms, all offline (aider is expected to be absent here):
//   1. /connect shell registers the shell bridge + generates a wrapper,
//   2. /run shell <cmd> executes a harmless command and STREAMS its output,
//   3. /connect aider degrades gracefully when aider is missing (install hint,
//      bridge marked unavailable, wrappers still generated) — no crash,
//   4. /bridges lists BOTH connected bridges with their capabilities/status.
//
// Run the server first (npm run dev:server), then: node scripts/verify-layer5.mjs
import WebSocket from "ws";

const URL = process.env.SKILLOS_URL ?? "ws://localhost:8787";
const ws = new WebSocket(URL);

// A harmless command whose output we can recognize in the stream.
const MARKER = "skillos-bridge-ok";
const SHELL_CMD = `echo ${MARKER}`;

let onboarding = false;
let phase = "init";

const seen = {
  shellConnected: false, // /connect shell reported a generated wrapper
  shellStreamed: false, // /run shell streamed the marker back
  shellDone: false, // a `done` closed the shell run
  aiderDegraded: false, // /connect aider degraded gracefully (install hint)
  aiderWrappers: false, // wrappers generated despite aider missing
  bridgesShell: false, // /bridges lists shell
  bridgesAider: false, // /bridges lists aider
};

const send = (text) => {
  console.log(`\n>>> ${text}`);
  ws.send(JSON.stringify({ type: "input", text }));
};

ws.on("open", () => {
  setTimeout(() => {
    if (onboarding) return;
    runBridges();
  }, 600);
});

function runBridges() {
  phase = "connect-shell";
  send("/connect shell");
  setTimeout(() => {
    phase = "run-shell";
    send(`/run shell ${SHELL_CMD}`);
  }, 1200);
  setTimeout(() => {
    phase = "connect-aider";
    send("/connect aider");
  }, 2600);
  setTimeout(() => {
    phase = "bridges";
    send("/bridges");
  }, 4000);
  setTimeout(finish, 5600);
}

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === "chunk") {
    process.stdout.write(msg.text);
    if (phase === "run-shell" && msg.text.includes(MARKER)) seen.shellStreamed = true;
    return;
  }
  if (msg.type === "done") {
    console.log(`\n[done: ${msg.meta.skill} · ${msg.meta.model} via ${msg.meta.provider}]`);
    if (phase === "run-shell" && /^bridge:/.test(msg.meta.provider)) seen.shellDone = true;
    return;
  }
  if (msg.type === "info") {
    console.log(`(info) ${msg.text}`);
    handleOnboarding(msg.text);
    const t = msg.text;
    if (phase === "connect-shell" && /wrapper command/i.test(t) && /\/run shell/i.test(t))
      seen.shellConnected = true;
    if (phase === "connect-aider") {
      if (/aider is not installed|pipx install aider-chat|pip install aider-chat/i.test(t))
        seen.aiderDegraded = true;
      if (/wrapper command/i.test(t) && /\/run aider-/i.test(t)) seen.aiderWrappers = true;
    }
    if (phase === "bridges") {
      if (/^\s*shell \(/m.test(t)) seen.bridgesShell = true;
      if (/^\s*aider \(/m.test(t)) seen.bridgesAider = true;
    }
    return;
  }
  if (msg.type === "error") {
    console.log(`(error) ${msg.text}`);
    return;
  }
});

// Tolerate a fresh-db onboarding prompt (same approach as the other verifiers).
function handleOnboarding(text) {
  if (/personalize SkillOS|use SkillOS for/i.test(text)) {
    onboarding = true;
    setTimeout(() => send("1"), 300);
  } else if (onboarding && /Preferred stack/i.test(text)) {
    setTimeout(() => send("react, node"), 300);
  } else if (onboarding && /Preferred mode/i.test(text)) {
    setTimeout(() => send("1"), 300);
  } else if (onboarding && /Profile saved/i.test(text)) {
    onboarding = false;
    setTimeout(runBridges, 400);
  }
}

function finish() {
  const checks = [
    ["/connect shell generated a wrapper", seen.shellConnected],
    ["/run shell streamed command output", seen.shellStreamed],
    ["shell run closed with a bridge `done`", seen.shellDone],
    ["/connect aider degraded gracefully (install hint)", seen.aiderDegraded],
    ["aider wrappers generated despite missing tool", seen.aiderWrappers],
    ["/bridges lists shell", seen.bridgesShell],
    ["/bridges lists aider", seen.bridgesAider],
  ];
  console.log("\n--- layer 5 verification ---");
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) ok = false;
  }
  console.log(`\nresult → ${ok ? "PASS" : "FAIL"}`);
  ws.close();
  process.exit(ok ? 0 : 1);
}

setTimeout(() => {
  console.log("\n(timeout — closing)");
  finish();
}, 30000);

ws.on("error", (e) => {
  console.error("WS error:", e.message);
  process.exit(1);
});
