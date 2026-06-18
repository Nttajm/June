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

export const config = {
  port: Number(process.env.PORT) || 3000,
  deepgramKey: process.env.DEEPGRAM_API_KEY || "",
  openaiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  mainTemperature: Number(process.env.MAIN_TEMPERATURE) || 0.86,
  memoryAiModel: process.env.MEMORY_AI_MODEL || "gpt-4.1",
  thoughtAiModel: process.env.THOUGHT_AI_MODEL || "gpt-4.1-mini",
  thoughtDebounceMs: Number(process.env.THOUGHT_DEBOUNCE_MS) || 500,
  thoughtRateLimitMs: Number(process.env.THOUGHT_RATE_LIMIT_MS) || 2000,
  // Snapshot agent (background topic context)
  snapshotAiModel: process.env.SNAPSHOT_AI_MODEL || "gpt-4.1",
  snapshotDebounceMs: Number(process.env.SNAPSHOT_DEBOUNCE_MS) || 800,
  snapshotRateLimitMs: Number(process.env.SNAPSHOT_RATE_LIMIT_MS) || 5000,
  snapshotMaxAgeMs: Number(process.env.SNAPSHOT_MAX_AGE_MS) || 120000,
  // Memory system
  memoryTokenBudget: Number(process.env.MEMORY_TOKEN_BUDGET) || 600,
  // TTS providers
  ttsProvider: process.env.TTS_PROVIDER || "cartesia",
  cartesiaKey: process.env.CARTESIA_API_KEY || "",
  cartesiaVoiceId: process.env.CARTESIA_VOICE_ID || "f786b574-daa5-4673-aa0c-cbe3e8534c02",
  cartesiaModel: process.env.CARTESIA_MODEL || "sonic-3",
  elevenLabsKey: process.env.ELEVENLABS_API_KEY || "",
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID,
  elevenLabsModel: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
  sttSampleRate: Number(process.env.STT_SAMPLE_RATE) || 16000,
  ttsSampleRate: Number(process.env.TTS_SAMPLE_RATE) || 24000,
  eagerEotThreshold: Number(process.env.EAGER_EOT_THRESHOLD) || 0.5,
  eotThreshold: Number(process.env.EOT_THRESHOLD) || 0.7,
  eotTimeoutMs: Number(process.env.EOT_TIMEOUT_MS) || 3000,
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SYSTEM_PROMPT = fs.readFileSync(path.join(root, "aichr_2.md"), "utf8").trim();
