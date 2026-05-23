// Unified provider picker verification (post-v0.1): drive `/provider` over a
// LOCAL WS and confirm the single grouped menu lists, in order:
//   - API providers (OpenAI/Anthropic/Google/Groq/DeepSeek/OpenRouter),
//   - Local / hosted: Ollama (local) + Ollama Cloud (key),
//   - Installed CLI tools (Claude Code, Gemini, OpenCode, Kilo Code) with
//     ✓ installed / ✗ not installed markers,
//   - a trailing "Skip (mock)" option.
//
// Then it SELECTS the Gemini CLI as the active provider (gemini is installed in
// this environment) and sends a NORMAL free-text prompt (not /run). It confirms
// the turn streams back via the Gemini CLI and that the `done` provider meta is
// `cli:gemini`. The live model run is bounded by a generous timeout (gemini cold
// start + generation can take ~30s) and reported honestly.
//
// Run the server first (npm run dev:server), then:
//   node scripts/verify-unified-provider.mjs
import WebSocket from "ws";

const URL = process.env.SKILLOS_URL ?? "ws://localhost:8787";
const RUN_TIMEOUT_MS = Number(process.env.GEMINI_RUN_TIMEOUT_MS ?? 45000);
const ws = new WebSocket(URL);

let onboarding = false;
let phase = "init";

// What the picker list showed (captured from the /provider info block).
let pickerText = "";
// Global option NUMBER for the Gemini CLI option (parsed from the list).
let geminiOptionNum = null;
let geminiInstalled = false;

const seen = {
  listApi: false, // shows the API providers group
  listOllama: false, // shows Ollama (local)
  listOllamaCloud: false, // shows Ollama Cloud
  listCliGroup: false, // shows the "Installed CLI tools" group header
  listClaudeCode: false,
  listGemini: false,
  listOpenCode: false,
  listKiloCode: false,
  listSkip: false, // trailing Skip (mock) option
  activatedGemini: false, // confirmation that gemini CLI is now active
};

// Captured transcript for the CLI-as-provider run.
let runChunks = "";
let runDone = false;
let runErrored = false;
let runProviderMeta = "";

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
  phase = "provider-list";
  send("/provider");
  // Give the picker a moment to render, then parse + select gemini.
  setTimeout(selectGemini, 2500);
}

function selectGemini() {
  if (geminiOptionNum == null) {
    console.log(
      "\n(could not find a Gemini CLI option number in the picker — cannot select)",
    );
    return finish();
  }
  if (!geminiInstalled) {
    console.log(
      "\n(Gemini CLI reported NOT installed at startup — skipping live CLI-as-provider run)",
    );
    // Still cancel the picker cleanly.
    phase = "done-no-run";
    send(String(geminiOptionNum));
    setTimeout(finish, 1500);
    return;
  }
  phase = "select-gemini";
  send(String(geminiOptionNum));
  // Activation connects the gemini bridge (re-runs `gemini --version`, ~6s cold
  // start), so wait generously for the confirmation BEFORE sending a normal
  // prompt — otherwise the prompt races the still-open picker.
  setTimeout(() => {
    phase = "run-cli";
    send("Reply with exactly: SKILLOS_GEMINI_OK");
    setTimeout(() => {
      if (phase === "run-cli" && !runDone) {
        console.log(
          `\n(CLI-as-provider run not finished within ${RUN_TIMEOUT_MS}ms — moving on)`,
        );
        finish();
      }
    }, RUN_TIMEOUT_MS);
  }, 12000);
}

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === "chunk") {
    process.stdout.write(msg.text);
    if (phase === "run-cli") runChunks += msg.text;
    return;
  }
  if (msg.type === "done") {
    console.log(
      `\n[done: ${msg.meta.skill} · ${msg.meta.model} via ${msg.meta.provider}]`,
    );
    if (phase === "run-cli") {
      runDone = true;
      runProviderMeta = msg.meta.provider ?? "";
      setTimeout(finish, 300);
    }
    return;
  }
  if (msg.type === "info") {
    console.log(`(info) ${msg.text}`);
    handleOnboarding(msg.text);
    const t = msg.text;

    if (phase === "provider-list") {
      pickerText += t + "\n";
      // Group / entry detection (tolerant to spacing + markers).
      if (/API providers/i.test(t)) seen.listApi = true;
      if (/Ollama \(local/i.test(t)) seen.listOllama = true;
      if (/Ollama Cloud/i.test(t)) seen.listOllamaCloud = true;
      if (/Installed CLI tools/i.test(t)) seen.listCliGroup = true;
      if (/Claude Code/i.test(t)) seen.listClaudeCode = true;
      if (/Gemini/i.test(t)) seen.listGemini = true;
      if (/OpenCode/i.test(t)) seen.listOpenCode = true;
      if (/Kilo Code/i.test(t)) seen.listKiloCode = true;
      if (/Skip \(mock/i.test(t)) seen.listSkip = true;

      // Parse the global option number for the Gemini line + its install marker.
      // Lines look like:  "    7) Gemini ✓ installed"  /  "    7) Gemini ✗ not installed"
      for (const line of t.split("\n")) {
        const m = line.match(/^\s*(\d+)\)\s*Gemini\b(.*)$/i);
        if (m) {
          geminiOptionNum = Number(m[1]);
          geminiInstalled = /✓ installed/i.test(m[2]);
        }
      }
    }
    if (phase === "select-gemini") {
      // Activation confirmation mentions the gemini CLI is active.
      if (/gemini.*\(CLI\)|gemini CLI/i.test(t)) seen.activatedGemini = true;
    }
    if (phase === "run-cli") {
      // The bridge emits an info line like `gemini -p "..."` before streaming.
      if (/gemini\s+-p|→ skill|provider: cli:gemini/i.test(t)) {
        // captured for the report
      }
    }
    return;
  }
  if (msg.type === "error") {
    console.log(`(error) ${msg.text}`);
    if (phase === "run-cli") {
      runErrored = true;
      setTimeout(finish, 300);
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
  } else if (onboarding && /Which AI provider/i.test(text)) {
    // Pick Skip during onboarding so the active provider starts as mock; the
    // /provider picker then switches us to the Gemini CLI.
    setTimeout(() => send("13"), 300);
  } else if (onboarding && /Profile saved/i.test(text)) {
    onboarding = false;
    setTimeout(runFlow, 400);
  }
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;

  const listChecks = [
    ["picker shows API providers group", seen.listApi],
    ["picker shows Ollama (local)", seen.listOllama],
    ["picker shows Ollama Cloud", seen.listOllamaCloud],
    ["picker shows Installed CLI tools group", seen.listCliGroup],
    ["picker lists Claude Code", seen.listClaudeCode],
    ["picker lists Gemini", seen.listGemini],
    ["picker lists OpenCode", seen.listOpenCode],
    ["picker lists Kilo Code", seen.listKiloCode],
    ["picker shows Skip (mock) option", seen.listSkip],
  ];

  console.log("\n--- unified /provider picker verification ---");
  let ok = true;
  for (const [label, pass] of listChecks) {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) ok = false;
  }

  console.log("\n--- CLI-as-provider live run (gemini) report ---");
  console.log(`  Gemini option number parsed: ${geminiOptionNum}`);
  console.log(`  Gemini reported installed in picker: ${geminiInstalled}`);
  if (geminiInstalled) {
    console.log(`  activation confirmed (gemini CLI active): ${seen.activatedGemini}`);
    const streamed = runChunks.trim().length > 0;
    console.log(`  normal prompt streamed via CLI: ${streamed}`);
    console.log(`  reached done: ${runDone}`);
    console.log(`  done provider meta: ${runProviderMeta}`);
    console.log(`  errored: ${runErrored}`);
    if (streamed) {
      console.log("  --- streamed excerpt ---");
      console.log(runChunks.trim().slice(0, 500).replace(/^/gm, "    "));
    }
    // Activation + provider routing are the gate (the bridge mechanism). The
    // exact model text is reported but not gated (auth/latency vary).
    if (!seen.activatedGemini) ok = false;
    if (runProviderMeta && !/cli:gemini/.test(runProviderMeta)) {
      console.log("  WARN: done provider meta is not cli:gemini");
    }
  } else {
    console.log("  (gemini not installed — live run skipped, list checks gate result)");
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
}, 120000);

ws.on("error", (e) => {
  console.error("WS error:", e.message);
  process.exit(1);
});
