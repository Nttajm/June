#!/usr/bin/env node
/**
 * Replay a fixed 10-turn conversation through streamReply and print
 * p50/p90 TTFT plus prompt-cache hit rate.
 *
 * Usage (from repo root, with .env loaded):
 *   node scripts/ttft-cache-check.mjs
 */
import "dotenv/config";
import { streamReply, llmAvailable } from "../lib/llm.js";
import { config } from "../lib/states.js";

const TURNS = [
  "hey",
  "how's it going",
  "yeah same here",
  "just sitting around honestly",
  "true",
  "anyway what have you been up to",
  "wait really",
  "okay yeah that tracks",
  "hmm",
  "alright cool",
];

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function fmtMs(n) {
  return n == null ? "—" : `${Math.round(n)}ms`;
}

function fmtTok(n) {
  return Number(n || 0).toLocaleString();
}

function fmtPct(n) {
  return n == null ? "—" : `${Math.round(n * 1000) / 10}%`;
}

async function runTurn(userText, history, promptCacheKey) {
  const usages = [];
  const t0 = Date.now();
  let firstTokenAt = null;
  let text = "";

  for await (const delta of streamReply({
    history,
    userText,
    memory: { schema_version: 3, categories: {}, meta: {} },
    context: { timezone: "America/Los_Angeles" },
    thoughtCache: null,
    snapshotCache: null,
    pastChats: [],
    clientHints: { installedApps: ["youtube", "artifacts"] },
    promptCacheKey,
    onUsage: (entry) => {
      if (entry?.usage) usages.push(entry.usage);
    },
  })) {
    if (firstTokenAt == null) firstTokenAt = Date.now();
    text += delta;
  }

  const ttftMs = (firstTokenAt ?? Date.now()) - t0;
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  for (const u of usages) {
    inputTokens += Number(u.inputTokens) || 0;
    cachedTokens += Number(u.cachedTokens) || 0;
    outputTokens += Number(u.outputTokens) || 0;
  }
  cachedTokens = Math.min(cachedTokens, inputTokens);
  return {
    userText,
    ttftMs,
    inputTokens,
    cachedTokens,
    uncachedTokens: Math.max(0, inputTokens - cachedTokens),
    outputTokens,
    reply: String(text || "").trim().slice(0, 80),
  };
}

async function main() {
  if (!llmAvailable()) {
    console.error("No LLM key configured. Set OPENAI_API_KEY or FIREWORKS_API_KEY.");
    process.exit(1);
  }

  const promptCacheKey = `june-bench-${Date.now()}`;
  console.log(`[ttft-cache-check] provider=${config.llmProvider} model=${config.openaiModel}`);
  console.log(`[ttft-cache-check] prompt_cache_key=${promptCacheKey}`);
  console.log(`[ttft-cache-check] ${TURNS.length} turns\n`);

  const history = [];
  const rows = [];
  for (let i = 0; i < TURNS.length; i++) {
    const userText = TURNS[i];
    const row = await runTurn(userText, history, promptCacheKey);
    rows.push(row);
    history.push({ role: "user", content: userText });
    history.push({ role: "assistant", content: row.reply || "(empty)" });
    const hit = row.inputTokens > 0 ? row.cachedTokens / row.inputTokens : 0;
    console.log(
      `  t${String(i + 1).padStart(2, "0")}  ttft=${String(row.ttftMs).padStart(5)}ms` +
        `  in=${fmtTok(row.inputTokens).padStart(7)}` +
        `  cached=${fmtTok(row.cachedTokens).padStart(7)}` +
        `  uncached=${fmtTok(row.uncachedTokens).padStart(7)}` +
        `  hit=${fmtPct(hit).padStart(6)}` +
        `  ${JSON.stringify(userText)}`
    );
  }

  const ttfts = rows.map((r) => r.ttftMs).sort((a, b) => a - b);
  const uncached = rows.map((r) => r.uncachedTokens);
  const inputSum = rows.reduce((a, r) => a + r.inputTokens, 0);
  const cachedSum = rows.reduce((a, r) => a + r.cachedTokens, 0);
  const later = rows.slice(1);
  const laterInput = later.reduce((a, r) => a + r.inputTokens, 0);
  const laterCached = later.reduce((a, r) => a + r.cachedTokens, 0);

  console.log("\n--- summary ---");
  console.log(`TTFT p50 ${fmtMs(percentile(ttfts, 50))}  p90 ${fmtMs(percentile(ttfts, 90))}  min ${fmtMs(ttfts[0])}  max ${fmtMs(ttfts[ttfts.length - 1])}`);
  console.log(`uncached tokens per turn: first ${uncached[0]}  later avg ${Math.round(later.reduce((a, r) => a + r.uncachedTokens, 0) / Math.max(1, later.length))}`);
  console.log(`cache hit rate (all turns) ${fmtPct(inputSum ? cachedSum / inputSum : 0)}  (turns 2–n) ${fmtPct(laterInput ? laterCached / laterInput : 0)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
