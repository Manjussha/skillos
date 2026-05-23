// Layer 3 verification: drive the agents layer over WebSocket.
// Lists agents, then runs the /build-dashboard workflow and prints the staged
// Planner → Coder → Reviewer output stream. Mock provider is fine (offline).
//
// Run the server first (npm run dev:server), then: node scripts/verify-layer3.mjs
import WebSocket from "ws";

const URL = process.env.SKILLOS_URL ?? "ws://localhost:8787";
const ws = new WebSocket(URL);

// State machine: send /agents, wait, then /build-dashboard, then close on its
// final done. We also tolerate a fresh-db onboarding prompt by answering it.
let phase = "init";
let onboarding = false;
let sawStages = new Set();

const send = (text) => {
  console.log(`\n>>> ${text}`);
  ws.send(JSON.stringify({ type: "input", text }));
};

ws.on("open", () => {
  // Give the server a moment to send its greeting (and maybe onboarding).
  setTimeout(() => {
    if (onboarding) return; // onboarding handler will drive instead
    runAgents();
  }, 600);
});

function runAgents() {
  phase = "agents";
  send("/agents");
  setTimeout(() => {
    phase = "workflow";
    send("/build-dashboard a small sales dashboard with 3 KPI cards");
  }, 1200);
}

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "chunk") process.stdout.write(msg.text);
  else if (msg.type === "stage") {
    sawStages.add(msg.agent);
    console.log(
      `\n[stage ${msg.step}/${msg.total}] ${msg.agent} (${msg.model} via ${msg.provider})`,
    );
  } else if (msg.type === "done")
    console.log(`\n[done: ${msg.meta.skill} · ${msg.meta.model} via ${msg.meta.provider}]`);
  else if (msg.type === "info") {
    console.log(`(info) ${msg.text}`);
    handleOnboarding(msg.text);
  } else if (msg.type === "error") console.log(`(error) ${msg.text}`);

  // The workflow ends with a `done` whose provider is "agents".
  if (phase === "workflow" && msg.type === "done" && msg.meta.provider === "agents") {
    finish();
  }
});

// If a fresh db drops us into onboarding, answer the three prompts so we can
// reach the agents commands. Detect by the onboarding step text.
function handleOnboarding(text) {
  if (/personalize SkillOS|use SkillOS for/i.test(text)) {
    onboarding = true;
    setTimeout(() => send("1"), 300); // use-case: Coding
  } else if (onboarding && /Preferred stack/i.test(text)) {
    setTimeout(() => send("react, node"), 300);
  } else if (onboarding && /Preferred mode/i.test(text)) {
    setTimeout(() => send("1"), 300); // Fast
  } else if (onboarding && /Profile saved/i.test(text)) {
    onboarding = false;
    setTimeout(runAgents, 400);
  }
}

function finish() {
  const expected = ["planner", "coder", "reviewer"];
  const ok = expected.every((a) => sawStages.has(a));
  console.log("\n--- layer 3 verification complete ---");
  console.log(
    `stages seen: ${[...sawStages].join(", ") || "(none)"}  → ${ok ? "PASS" : "FAIL"}`,
  );
  ws.close();
  process.exit(ok ? 0 : 1);
}

// Safety timeout.
setTimeout(() => {
  console.log("\n(timeout — closing)");
  finish();
}, 30000);

ws.on("error", (e) => {
  console.error("WS error:", e.message);
  process.exit(1);
});
