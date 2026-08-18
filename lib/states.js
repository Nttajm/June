import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const State = Object.freeze({
  IDLE: "IDLE",
  LISTENING: "LISTENING",
  THINKING: "THINKING",
  SPEAKING: "SPEAKING",
  PAUSED: "PAUSED",
});

export const FluxEvent = Object.freeze({
  START_OF_TURN: "StartOfTurn",
  EAGER_END_OF_TURN: "EagerEndOfTurn",
  TURN_RESUMED: "TurnResumed",
  END_OF_TURN: "EndOfTurn",
  UPDATE: "Update",
});

function envFlag(name, defaultOn = true) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultOn;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

const llmProvider = String(process.env.LLM_PROVIDER || "fireworks").trim().toLowerCase() === "openai"
  ? "openai"
  : "fireworks";
const isFireworks = llmProvider === "fireworks";

/** Fireworks serverless IDs — Nemotron for main, gpt-oss-120/20 for the rest. */
const FW = {
  // gpt-4.1 analog: agentic + function calling, ~70% cheaper output than gpt-4.1.
  // Budget swap: accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b ($0.05/$0.20)
  main: "accounts/fireworks/models/nemotron-3-ultra-nvfp4",
  mid: "accounts/fireworks/models/gpt-oss-120b",
  cheap: "accounts/fireworks/models/gpt-oss-20b",
};

export const config = {
  port: Number(process.env.PORT) || 3010,
  deepgramKey: process.env.DEEPGRAM_API_KEY || "",
  llmProvider,
  openaiKey: process.env.OPENAI_API_KEY || "",
  fireworksKey: process.env.FIREWORKS_API_KEY || "",
  llmApiKey: isFireworks
    ? (process.env.FIREWORKS_API_KEY || "")
    : (process.env.OPENAI_API_KEY || ""),
  llmBaseURL: isFireworks
    ? (process.env.FIREWORKS_BASE_URL || "https://api.fireworks.ai/inference/v1")
    : (process.env.OPENAI_BASE_URL || ""),
  // Voice-critical path — keep fast (not a reasoning model).
  // OpenAI default: gpt-4.1-mini (much lower TTFT than gpt-4.1, still strong on tools).
  openaiModel: process.env.OPENAI_MODEL || (isFireworks ? FW.main : "gpt-4.1-mini"),
  mainTemperature: Number(process.env.MAIN_TEMPERATURE) || 0.56,
  // Background only (never blocks TTS). Prefer cheap chat models — reasoning is optional.
  memoryAiEnabled: envFlag("MEMORY_AI_ENABLED", true),
  memoryAiModel: process.env.MEMORY_AI_MODEL || (isFireworks ? FW.cheap : "gpt-4o-mini"),
  // Thinker: next-turn coaching whispers (tools + tone).
  thoughtAgentEnabled: envFlag("THOUGHT_AGENT_ENABLED", true),
  thoughtAiModel: process.env.THOUGHT_AI_MODEL || (isFireworks ? FW.cheap : "gpt-4o-mini"),
  thoughtReasoningEffort: process.env.THOUGHT_REASONING_EFFORT || "low",
  thoughtDebounceMs: Number(process.env.THOUGHT_DEBOUNCE_MS) || 1500,
  thoughtRateLimitMs: Number(process.env.THOUGHT_RATE_LIMIT_MS) || 12000,
  // Snapshot agent (background topic hooks) — structured list gen, no reasoning needed.
  snapshotAgentEnabled: envFlag("SNAPSHOT_AGENT_ENABLED", true),
  snapshotAiModel: process.env.SNAPSHOT_AI_MODEL || (isFireworks ? FW.cheap : "gpt-4o-mini"),
  snapshotDebounceMs: Number(process.env.SNAPSHOT_DEBOUNCE_MS) || 2000,
  snapshotRateLimitMs: Number(process.env.SNAPSHOT_RATE_LIMIT_MS) || 10000,
  snapshotMaxAgeMs: Number(process.env.SNAPSHOT_MAX_AGE_MS) || 180000,
  // Partial STT Updates + tool-start force kicks are expensive; off by default.
  backgroundAiOnPartials: envFlag("BACKGROUND_AI_ON_PARTIALS", false),
  backgroundAiForceOnTools: envFlag("BACKGROUND_AI_FORCE_ON_TOOLS", false),
  // Idle Bridge continuation — after June finishes speaking, a fast agent may
  // weave in one Thinker whisper if the user stays quiet (~1.5–2s).
  followupEnabled: envFlag("FOLLOWUP_ENABLED", true),
  followupModel: process.env.FOLLOWUP_MODEL || (isFireworks ? FW.mid : "gpt-4o-mini"),
  followupDelayMs: Number(process.env.FOLLOWUP_DELAY_MS) || 1700,
  followupGraceMs: Number(process.env.FOLLOWUP_GRACE_MS) || 600,
  followupRateLimitMs: Number(process.env.FOLLOWUP_RATE_LIMIT_MS) || 25000,
  // In-turn step mode: speak first beat, enrich with tools, continue same TTS stream.
  stepModeEnabled: process.env.STEP_MODE_ENABLED !== "false",
  stepEnrichWaitMs: Number(process.env.STEP_ENRICH_WAIT_MS) || 700,
  // Per tool-loop round watchdog — if a round (esp. the post-tool "step_continue"
  // round) goes this long with no token/tool-call chunk, abort it and speak a
  // short fallback instead of leaving the turn silent forever.
  mainRoundIdleTimeoutMs: Number(process.env.MAIN_ROUND_IDLE_TIMEOUT_MS) || 12000,
  // Live web search (Tavily) — optional tool on the main LLM.
  webSearchEnabled: envFlag("WEB_SEARCH_ENABLED", true),
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  webSearchMaxResults: Number(process.env.WEB_SEARCH_MAX_RESULTS) || 4,
  webSearchDepth: process.env.WEB_SEARCH_DEPTH || "basic",
  // Gmail (virtual app + Google OAuth). Redirect URI must match Cloud Console.
  gmailEnabled: envFlag("GMAIL_ENABLED", true),
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  gmailRedirectUri: process.env.GMAIL_REDIRECT_URI || "http://localhost:3010/api/gmail/callback",
  gmailAgentModel: process.env.GMAIL_AGENT_MODEL || process.env.MEMORY_AI_MODEL || (isFireworks ? FW.cheap : "gpt-4o-mini"),
  // Dictation / brainstorm mode — capture speech with no auto-turns.
  brainstormEnabled: envFlag("BRAINSTORM_ENABLED", true),
  // Memory system
  memoryTokenBudget: Number(process.env.MEMORY_TOKEN_BUDGET) || 400,
  // Skip session-end consolidation LLM for tiny chats (chat save still happens).
  consolidateMinTurns: Number(process.env.CONSOLIDATE_MIN_TURNS) || 3,
  // TTS providers
  ttsProvider: process.env.TTS_PROVIDER || "cartesia",
  cartesiaKey: process.env.CARTESIA_API_KEY || "",
  cartesiaVoiceId: process.env.CARTESIA_VOICE_ID || "f786b574-daa5-4673-aa0c-cbe3e8534c02",
  cartesiaModel: process.env.CARTESIA_MODEL || "sonic-3",
  elevenLabsKey: process.env.ELEVENLABS_API_KEY || "",
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID,
  // Flash for realtime WS; eleven_v3 needs HTTP streaming (no WS support).
  elevenLabsModel: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
  // flux-general-multi (10 langs, auto-detect + lock) or flux-general-en
  sttModel: process.env.STT_MODEL || "flux-general-multi",
  // Optional seed hints for multi model, e.g. "en,es". Empty = pure auto-detect.
  sttLanguageHints: (process.env.STT_LANGUAGE_HINTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Consecutive EndOfTurn detections in the same language before locking the hint.
  sttLanguageLockAfter: Number(process.env.STT_LANGUAGE_LOCK_AFTER) || 2,
  sttSampleRate: Number(process.env.STT_SAMPLE_RATE) || 16000,
  ttsSampleRate: Number(process.env.TTS_SAMPLE_RATE) || 24000,
  eagerEotThreshold: Number(process.env.EAGER_EOT_THRESHOLD) || 0.5,
  eotThreshold: Number(process.env.EOT_THRESHOLD) || 0.7,
  eotTimeoutMs: Number(process.env.EOT_TIMEOUT_MS) || 3000,
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SYSTEM_PROMPT = fs.readFileSync(path.join(root, "aichr_3.md"), "utf8").trim();
