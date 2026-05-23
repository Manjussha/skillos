// External AI-CLI bridges verification (Layer 5 extension): drive the three new
// terminal bridges — Claude Code, Gemini CLI, OpenCode — over a LOCAL WS.
//
// Confirms:
//   1. /connect claude-code registers + generates wrappers (ready if `claude`
//      is installed, else graceful "unavailable" with an install hint),
//   2. /connect opencode  — same (ready or graceful),
//   3. /connect gemini    — same (ready or graceful),
//   4. /bridges lists all three (plus shell/aider) with status,
//   5. if gemini is READY, /run gemini-ask <prompt> proxies and streams; this is
//      bounded by a timeout and reported honestly (it may be slow / need auth).
//
// Graceful by design: a MISSING binary still passes (unavailable + hint + wrappers).
// Run the server first (npm run dev:server), then: node scripts/verify-bridges.mjs
import WebSocket from "ws";

const URL = process.env.SKILLOS_URL ?? "ws://localhost:8787";
// Gemini cold-start + generation can take ~30s here (heavy Node CLI + loaded
// extensions), so the live-run bound is generous. It's a report, not a gate.
const RUN_TIMEOUT_MS = Number(process.env.GEMINI_RUN_TIMEOUT_MS ?? 45000);
const ws = new WebSocket(URL);

let onboarding = false;
let phase = "init";
let geminiReady = false;

const seen = {
  claudeConnected: false, // /connect claude-code: ready OR graceful unavailable
  claudeWrappers: false, // wrappers generated (/run claude-…)
  opencodeConnected: false,
  opencodeWrappers: false,
  geminiConnected: false,
  geminiWrappers: false,
  bridgesClaude: false, // /bridges lists claude-code
  bridgesGemini: false, // /bridges lists gemini
  bridgesOpencode: false, // /bridges lists opencode
};

// Captured transcripts for the report.
let geminiConnectText = "";
let geminiRunChunks = "";
let geminiRunInfo = "";
let geminiRunErrored = false;
let geminiRunDone = false;

const send = (text) => {
  console.log(`\n>>> ${text}`);
  ws.send(JSON.stringify({ type: "input", text }));
};

ws.on("open", () => {
  setTimeout(() => {
    if (onboarding) return;
    runFlow();
  }, 600);
});

function runFlow() {
  // Spacing is generous: `gemini --version` is a heavy Node cold-start (~6s
  // here), so each /connect needs time to finish detection before the next step.
  phase = "connect-claude";
  send("/connect claude-code");
  setTimeout(() => {
    phase = "connect-opencode";
    send("/connect opencode");
  }, 3000);
  setTimeout(() => {
    phase = "connect-gemini";
    send("/connect gemini");
  }, 6000);
  setTimeout(() => {
    phase = "bridges";
    send("/bridges");
  }, 15000); // after gemini's ~6s detection has resolved
  setTimeout(() => {
    if (geminiReady) {
      phase = "run-gemini";
      send("/run gemini-ask Reply with exactly: SKILLOS_GEMINI_OK");
      // Bound the run so a slow/auth-needing CLI never hangs the verifier.
      setTimeout(() => {
        if (phase === "run-gemini" && !geminiRunDone) {
          console.log(
            `\n(gemini run not finished within ${RUN_TIMEOUT_MS}ms — moving on)`,
          );
          finish();
        }
      }, RUN_TIMEOUT_MS);
    } else {
      console.log("\n(gemini not ready — skipping live /run gemini-ask)");
      finish();
    }
  }, 17000);
}

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === "chunk") {
    process.stdout.write(msg.text);
    if (phase === "run-gemini") geminiRunChunks += msg.text;
    return;
  }
  if (msg.type === "done") {
    console.log(
      `\n[done: ${msg.meta.skill} · ${msg.meta.model} via ${msg.meta.provider}]`,
    );
    if (phase === "run-gemini") {
      geminiRunDone = true;
      setTimeout(finish, 200);
    }
    return;
  }
  if (msg.type === "info") {
    console.log(`(info) ${msg.text}`);
    handleOnboarding(msg.text);
    const t = msg.text;

    if (phase === "connect-claude") {
      if (/claude-code/i.test(t) && /status:/i.test(t)) seen.claudeConnected = true;
      if (/\/run claude-/i.test(t)) seen.claudeWrappers = true;
    }
    if (phase === "connect-opencode") {
      if (/opencode/i.test(t) && /status:/i.test(t)) seen.opencodeConnected = true;
      if (/\/run opencode-/i.test(t)) seen.opencodeWrappers = true;
    }
    if (phase === "connect-gemini") {
      geminiConnectText += t + "\n";
      if (/gemini/i.test(t) && /status:/i.test(t)) seen.geminiConnected = true;
      if (/\/run gemini-/i.test(t)) seen.geminiWrappers = true;
      if (/status:\s*ready/i.test(t)) geminiReady = true;
    }
    if (phase === "bridges") {
      if (/^\s*claude-code \(/m.test(t)) seen.bridgesClaude = true;
      if (/^\s*gemini \(/m.test(t)) seen.bridgesGemini = true;
      if (/^\s*opencode \(/m.test(t)) seen.bridgesOpencode = true;
    }
    if (phase === "run-gemini") geminiRunInfo += t + "\n";
    return;
  }
  if (msg.type === "error") {
    console.log(`(error) ${msg.text}`);
    if (phase === "run-gemini") {
      geminiRunErrored = true;
      setTimeout(finish, 200);
    }
    return;
  }
});

// Tolerate a fresh-db onboarding prompt (same as the other verifiers).
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
    setTimeout(runFlow, 400);
  }
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;

  const checks = [
    ["/connect claude-code registered (ready or graceful)", seen.claudeConnected],
    ["claude-code wrappers generated", seen.claudeWrappers],
    ["/connect opencode registered (ready or graceful)", seen.opencodeConnected],
    ["opencode wrappers generated", seen.opencodeWrappers],
    ["/connect gemini registered (ready or graceful)", seen.geminiConnected],
    ["gemini wrappers generated", seen.geminiWrappers],
    ["/bridges lists claude-code", seen.bridgesClaude],
    ["/bridges lists gemini", seen.bridgesGemini],
    ["/bridges lists opencode", seen.bridgesOpencode],
  ];

  console.log("\n--- external AI-CLI bridges verification ---");
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) ok = false;
  }

  console.log("\n--- gemini live /run report (honest) ---");
  console.log(`  gemini reported READY at connect: ${geminiReady}`);
  if (geminiReady) {
    const streamed = geminiRunChunks.trim().length > 0;
    console.log(`  /run gemini-ask streamed output: ${streamed}`);
    console.log(`  /run gemini-ask reached done: ${geminiRunDone}`);
    console.log(`  /run gemini-ask errored: ${geminiRunErrored}`);
    if (streamed) {
      const excerpt = geminiRunChunks.trim().slice(0, 400);
      console.log("  --- streamed excerpt ---");
      console.log(excerpt.replace(/^/gm, "    "));
    }
    // Live model output is NOT a pass/fail gate (may be slow / need auth) — the
    // bridge mechanism is what we verify. We report it honestly above.
  }

  console.log(`\nresult → ${ok ? "PASS" : "FAIL"}`);
  try {
    ws.close();
  } catch {}
  process.exit(ok ? 0 : 1);
}

setTimeout(() => {
  console.log("\n(overall timeout — closing)");
  finish();
}, 90000);

ws.on("error", (e) => {
  console.error("WS error:", e.message);
  process.exit(1);
});
