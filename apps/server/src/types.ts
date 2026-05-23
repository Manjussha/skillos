/** A skill loaded from the top-level `skills/` directory (Markdown or JSON). */
export interface Skill {
  name: string;
  description: string;
  category: string;
  /** Preferred logical model, e.g. "claude", "deepseek-coder". May be empty. */
  bestModel: string;
  tools: string[];
  /** The system prompt that defines the skill's behavior. */
  prompt: string;
  /** Where it came from, for `/skills` output and debugging. */
  source: string;
  format: "md" | "json";
}

/** Messages the client sends to the server. */
export type ClientMessage =
  | { type: "input"; text: string }
  /**
   * Layer 4: a remote client presents its session token to authenticate. Local
   * clients never send this and get an implicit full-permission local session.
   * Backward-compatible — older/local clients simply omit it.
   */
  | { type: "auth"; token: string }
  /**
   * Layer 4: the user's answer to a permission prompt for a privileged tool
   * (shell/filesystem) over a remote session. `id` echoes the request.
   */
  | { type: "permission-response"; id: string; approved: boolean };

/** Messages the server streams back to the client. */
export type ServerMessage =
  | { type: "chunk"; text: string }
  | { type: "info"; text: string }
  | { type: "error"; text: string }
  | {
      type: "done";
      meta: { skill: string | null; model: string; provider: string };
    }
  /**
   * Layer 3: announces an agent/workflow stage starting. Backward-compatible —
   * older clients can ignore it; the runtime also emits an `info` header so the
   * pipeline is visible without special handling.
   */
  | {
      type: "stage";
      agent: string;
      /** 1-based step index within the workflow. */
      step: number;
      /** Total steps in the workflow (1 for a single-agent run). */
      total: number;
      model: string;
      provider: string;
    }
  /**
   * Layer 4: a QR code rendered as terminal art (Unicode/ASCII), plus the URL it
   * encodes. Backward-compatible — older clients can ignore it (the server also
   * prints the URL as an `info` line so it's never lost).
   */
  | { type: "qr"; art: string; url: string }
  /**
   * Layer 4: a server→client request to confirm a privileged tool over a remote
   * session. The client must reply with a `permission-response` carrying the
   * same `id`. The turn blocks until then (or times out server-side).
   */
  | {
      type: "permission-request";
      id: string;
      /** What is being run (skill/agent/workflow name). */
      target: string;
      /** Privileged scopes requested, e.g. ["shell","filesystem"]. */
      scopes: string[];
      /** Human-readable prompt text. */
      text: string;
    };
