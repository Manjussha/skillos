// Per-task model routing verification (Feature A): drive `/route` over a LOCAL
// WS and confirm the RoutingPreference table is wired end-to-end:
//   1. /route coding deepseek-coder  sets + persists a category route; /route
//      lists it back.
//   2. /route writing anthropic:claude-3-5-sonnet-latest  sets a CROSS-PROVIDER
//      PIN; /route lists it and reports it as a provider pin.
//   3. /route coding gemini  (a model that DIFFERS from code-review's bestModel,
//      deepseek-coder) then /code-review <code>: the routing line must reflect
//      the per-task model `gemini` with a `route: category` note — proving the
//      route overrides the skill's own bestModel.
//   4. Reconnect with a FRESH WS and /route: the routes must still be there
//      (persisted across the connection — and across restarts, via the DB).
//
// Offline-safe: works with the mock provider (no keys). The pin's provider key
// need not be present — we only assert the route persists and the routing line
// reflects it; the live stream still falls back through resolveProvider.
//
// Run the server first (npm run dev:server), then: node scripts/verify-routing.mjs
import WebSocket from "ws";

const URL = process.env.SKILLOS_URL ?? "ws://localhost:8787";

const seen = {
  setCodingDeepseek: false, // /route coding deepseek-coder confirmed set
  listShowsCodingDeepseek: false, // /route list shows coding → deepseek-coder
  setWritingPin: false, // cross-provider pin set + reported as a pin
  listShowsWritingPin: false, // /route list shows writing → anthropic:...
  setCodingGemini: false, // /route coding gemini confirmed set
  routingLineGemini: false, // code-review routing line shows model: gemini + route
  reconnectCodingPersisted: false, // after reconnect, coding route still present
  reconnectWritingPersisted: false, // after reconnect, writing pin still present
};

// Captured transcripts for the report.
let routeListText = "";
let routingLine = "";
let reconnectListText = "";

let onboarding = false;
let phase = "init";
let ws;

const send = (text) => {
  console.log(`\n>>> ${text}`);
  ws.send(JSON.stringify({ type: "input", text }));
};

function connect(onOpen) {
  ws = new WebSocket(URL);
  ws.on("open", () => setTimeout(onOpen, 600));
  ws.on("message", onMessage);
  ws.on("error", (e) => {
    console.error("WS error:", e.message);
    process.exit(1);
  });
}

// --- main flow (first connection) -----------------------------------------
function runFlow() {
  if (onboarding) return;
  const steps = [
    () => {
      phase = "set-coding-deepseek";
      send("/route coding deepseek-coder");
    },
    () => {
      phase = "set-writing-pin";
      send("/route writing anthropic:claude-3-5-sonnet-latest");
    },
    () => {
      phase = "list";
      send("/route");
    },
    () => {
      phase = "set-coding-gemini";
      send("/route coding gemini");
    },
    () => {
      phase = "run-coding";
      send("/code-review function add(a,b){return a-b}");
    },
    () => {
      // Tear down this connection, then reconnect to prove persistence.
      phase = "reconnect";
      try {
        ws.close();
      } catch {}
      setTimeout(reconnectAndCheck, 800);
    },
  ];
  let i = 0;
  const tick = () => {
    if (i >= steps.length) return;
    steps[i++]();
    setTimeout(tick, 1600);
  };
  tick();
}

function reconnectAndCheck() {
  console.log("\n--- reconnecting (fresh WS) to verify persistence ---");
  connect(() => {
    phase = "reconnect-list";
    send("/route");
    setTimeout(finish, 1800);
  });
}

function onMessage(raw) {
  const msg = JSON.parse(raw.toString());

  if (msg.type === "chunk") {
    process.stdout.write(msg.text);
    return;
  }
  if (msg.type === "done") {
    console.log(
      `\n[done: ${msg.meta.skill} · ${msg.meta.model} via ${msg.meta.provider}]`,
    );
    return;
  }
  if (msg.type === "error") {
    console.log(`(error) ${msg.text}`);
    return;
  }
  if (msg.type !== "info") return;

  const t = msg.text;
  console.log(`(info) ${t}`);
  handleOnboarding(t);

  if (phase === "set-coding-deepseek") {
    if (/Route set:\s*coding\s*→\s*deepseek-coder/i.test(t))
      seen.setCodingDeepseek = true;
  }
  if (phase === "set-writing-pin") {
    if (
      /Route set:\s*writing\s*→\s*anthropic:claude-3-5-sonnet-latest/i.test(t) &&
      /pin|pinned/i.test(t)
    )
      seen.setWritingPin = true;
  }
  if (phase === "list") {
    routeListText += t + "\n";
    if (/coding\s*→\s*deepseek-coder/i.test(t)) seen.listShowsCodingDeepseek = true;
    if (/writing\s*→\s*anthropic:claude-3-5-sonnet-latest/i.test(t))
      seen.listShowsWritingPin = true;
  }
  if (phase === "set-coding-gemini") {
    if (/Route set:\s*coding\s*→\s*gemini/i.test(t)) seen.setCodingGemini = true;
  }
  if (phase === "run-coding") {
    // The routing info line: "→ skill: code-review · model: gemini · provider: … · route: category"
    if (/→ skill:\s*code-review/i.test(t) && /model:\s*gemini/i.test(t)) {
      routingLine = t;
      if (/route:\s*category/i.test(t)) seen.routingLineGemini = true;
    }
  }
  if (phase === "reconnect-list") {
    reconnectListText += t + "\n";
    if (/coding\s*→\s*gemini/i.test(t)) seen.reconnectCodingPersisted = true;
    if (/writing\s*→\s*anthropic:claude-3-5-sonnet-latest/i.test(t))
      seen.reconnectWritingPersisted = true;
  }
}

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
    setTimeout(() => send("13"), 300); // Skip → mock
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
    ["/route coding deepseek-coder set + confirmed", seen.setCodingDeepseek],
    ["/route list shows coding → deepseek-coder", seen.listShowsCodingDeepseek],
    ["cross-provider pin set + reported as a pin", seen.setWritingPin],
    ["/route list shows writing → anthropic:claude-3-5-sonnet-latest", seen.listShowsWritingPin],
    ["/route coding gemini set + confirmed", seen.setCodingGemini],
    ["code-review routing line reflects per-task model (gemini, route: category)", seen.routingLineGemini],
    ["after reconnect: coding route persisted (coding → gemini)", seen.reconnectCodingPersisted],
    ["after reconnect: writing pin persisted", seen.reconnectWritingPersisted],
  ];

  console.log("\n--- per-task routing verification ---");
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) ok = false;
  }

  console.log("\n--- captured routing line (per-task model in effect) ---");
  console.log("  " + (routingLine || "(none captured)"));

  console.log(`\nresult → ${ok ? "PASS" : "FAIL"}`);
  try {
    ws.close();
  } catch {}
  process.exit(ok ? 0 : 1);
}

setTimeout(() => {
  console.log("\n(overall timeout — closing)");
  finish();
}, 60000);

connect(runFlow);
