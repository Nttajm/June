/** Compact agent/tool traces for the Ctrl+Shift+G inspector. */

const MAX_STR = 400;

export function truncateTraceValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > MAX_STR ? `${value.slice(0, MAX_STR)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 3) return "[…]";
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((v) => truncateTraceValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (n++ >= 20) {
        out["…"] = "truncated";
        break;
      }
      out[k] = truncateTraceValue(v, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, MAX_STR);
}

/**
 * @param {{
 *   agent: "main"|"thinker"|"snapshot"|"memory"|"followup",
 *   phase: "scheduled"|"started"|"tool"|"result"|"skipped"|"aborted"|"injected",
 *   name?: string,
 *   detail?: object,
 *   durationMs?: number,
 *   turnId?: number|null,
 * }} partial
 */
export function buildAgentTrace(partial) {
  const event = {
    type: "agent_trace",
    ts: Date.now(),
    turnId: partial.turnId ?? null,
    agent: partial.agent,
    phase: partial.phase,
  };
  if (partial.name) event.name = String(partial.name).slice(0, 120);
  if (partial.detail != null) event.detail = truncateTraceValue(partial.detail);
  if (typeof partial.durationMs === "number") event.durationMs = partial.durationMs;
  return event;
}
