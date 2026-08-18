/**
 * Token usage + session cost estimates.
 * OpenAI list prices (Aug 2026) and Fireworks serverless list prices.
 */

import { config } from "./states.js";

/** @typedef {{ input: number, cachedInput: number, output: number }} ModelRates */

/** @type {Record<string, ModelRates>} */
export const OPENAI_RATES_PER_1M = {
  "gpt-4.1": { input: 2.0, cachedInput: 0.5, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cachedInput: 0.025, output: 0.4 },
  "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
  "o4-mini": { input: 1.1, cachedInput: 0.275, output: 4.4 },
  "o3-mini": { input: 1.1, cachedInput: 0.55, output: 4.4 },
  "o3": { input: 2.0, cachedInput: 0.5, output: 8.0 },
  "o1-mini": { input: 1.1, cachedInput: 0.55, output: 4.4 },
};

/** Fireworks serverless USD / 1M tokens. Keys match the model slug after accounts/fireworks/models/. */
export const FIREWORKS_RATES_PER_1M = {
  "nemotron-3-ultra-nvfp4": { input: 0.60, cachedInput: 0.119, output: 2.40 },
  "nemotron-lightning-3p5-30b-a3b": { input: 0.05, cachedInput: 0.01, output: 0.20 },
  "gpt-oss-120b": { input: 0.15, cachedInput: 0.014, output: 0.60 },
  "gpt-oss-20b": { input: 0.07, cachedInput: 0.035, output: 0.30 },
};

export const PRICING_SOURCE =
  "OpenAI list prices (Aug 2026): gpt-4o-mini $0.15/$0.60 · gpt-4.1 $2/$8 · o4-mini $1.10/$4.40 per 1M tokens";

export const FIREWORKS_PRICING_SOURCE =
  "Fireworks serverless: Nemotron Ultra $0.60/$2.40 · gpt-oss-120b $0.15/$0.60 · gpt-oss-20b $0.07/$0.30 · Lightning 30B $0.05/$0.20 per 1M";

export function pricingSource() {
  return config.llmProvider === "fireworks" ? FIREWORKS_PRICING_SOURCE : PRICING_SOURCE;
}

function allRates() {
  return { ...OPENAI_RATES_PER_1M, ...FIREWORKS_RATES_PER_1M };
}

function normalizeModelKey(model = "") {
  let key = String(model || "")
    .trim()
    .toLowerCase()
    .replace(/:\w+$/, "");
  const fw = key.match(/accounts\/fireworks\/models\/(.+)$/);
  if (fw) key = fw[1];
  return key;
}

/** Resolve rates; date-stamped snapshots fall back to base model id. */
export function ratesForModel(model = "") {
  const table = allRates();
  const key = normalizeModelKey(model);
  if (table[key]) return { key, rates: table[key], known: true };

  const base = Object.keys(table)
    .sort((a, b) => b.length - a.length)
    .find((k) => key === k || key.startsWith(`${k}-`) || key.endsWith(k));
  if (base) return { key: base, rates: table[base], known: true };

  const fallback = config.llmProvider === "fireworks" ? "gpt-oss-20b" : "gpt-4o-mini";
  return { key: key || "unknown", rates: table[fallback], known: false };
}

/** Models currently configured for this process (for the inspector). */
export function configuredModelRates() {
  const roles = {
    main: config.openaiModel,
    memory: config.memoryAiModel,
    thinker: config.thoughtAiModel,
    snapshot: config.snapshotAiModel,
    followup: config.followupModel,
  };
  const out = {};
  for (const [role, model] of Object.entries(roles)) {
    const { key, rates, known } = ratesForModel(model);
    out[role] = {
      model: model || "",
      modelKey: key,
      ratesKnown: known,
      rates,
      usdPer1M: { input: rates.input, cachedInput: rates.cachedInput, output: rates.output },
    };
  }
  return out;
}

/**
 * Chat Completions usage object → normalized tokens.
 * @param {object|null|undefined} usage
 */
export function normalizeChatUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.prompt_tokens) || 0;
  const outputTokens = Number(usage.completion_tokens) || 0;
  const cachedTokens =
    Number(usage.prompt_tokens_details?.cached_tokens) ||
    Number(usage.input_tokens_details?.cached_tokens) ||
    0;
  const totalTokens = Number(usage.total_tokens) || inputTokens + outputTokens;
  if (!inputTokens && !outputTokens && !totalTokens) return null;
  return { inputTokens, outputTokens, cachedTokens, totalTokens };
}

/**
 * Responses API usage object → normalized tokens.
 * @param {object|null|undefined} usage
 */
export function normalizeResponsesUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.input_tokens) || 0;
  const outputTokens = Number(usage.output_tokens) || 0;
  const cachedTokens = Number(usage.input_tokens_details?.cached_tokens) || 0;
  const totalTokens = Number(usage.total_tokens) || inputTokens + outputTokens;
  if (!inputTokens && !outputTokens && !totalTokens) return null;
  return { inputTokens, outputTokens, cachedTokens, totalTokens };
}

/**
 * @param {string} model
 * @param {{ inputTokens: number, outputTokens: number, cachedTokens?: number }} tokens
 */
export function estimateCostUsd(model, tokens) {
  const { key, rates, known } = ratesForModel(model);
  const input = Number(tokens?.inputTokens) || 0;
  const output = Number(tokens?.outputTokens) || 0;
  const cached = Math.min(Number(tokens?.cachedTokens) || 0, input);
  const uncached = Math.max(0, input - cached);
  const usd =
    (uncached / 1e6) * rates.input +
    (cached / 1e6) * rates.cachedInput +
    (output / 1e6) * rates.output;
  return {
    usd,
    modelKey: key,
    ratesKnown: known,
    rates,
  };
}

function emptyBucket() {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    usd: 0,
  };
}

function withUncached(bucket) {
  const inputTokens = bucket.inputTokens || 0;
  const cachedTokens = Math.min(bucket.cachedTokens || 0, inputTokens);
  return {
    ...bucket,
    cachedTokens,
    uncachedTokens: Math.max(0, inputTokens - cachedTokens),
    cacheHitRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
  };
}

function addToBucket(bucket, tokens, usd) {
  bucket.calls += 1;
  bucket.inputTokens += tokens.inputTokens || 0;
  bucket.outputTokens += tokens.outputTokens || 0;
  bucket.cachedTokens += tokens.cachedTokens || 0;
  bucket.totalTokens += tokens.totalTokens || (tokens.inputTokens || 0) + (tokens.outputTokens || 0);
  bucket.usd += usd;
}

/**
 * Per-voice-session accumulator for the debug cost panel.
 */
export class SessionCostTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.startedAt = Date.now();
    this.calls = 0;
    this.unknownModels = [];
    this.byAgent = Object.create(null);
    this.byModel = Object.create(null);
    this.totals = emptyBucket();
    this.lastCall = null;
  }

  /**
   * @param {{
   *   agent: string,
   *   model: string,
   *   usage: { inputTokens: number, outputTokens: number, cachedTokens?: number, totalTokens?: number },
   * }} entry
   */
  record({ agent = "unknown", model = "", usage } = {}) {
    if (!usage) return null;
    const tokens = {
      inputTokens: Number(usage.inputTokens) || 0,
      outputTokens: Number(usage.outputTokens) || 0,
      cachedTokens: Number(usage.cachedTokens) || 0,
      totalTokens:
        Number(usage.totalTokens) ||
        (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0),
    };
    if (!tokens.inputTokens && !tokens.outputTokens && !tokens.totalTokens) return null;

    const cost = estimateCostUsd(model, tokens);
    if (!cost.ratesKnown && model && !this.unknownModels.includes(model)) {
      this.unknownModels.push(model);
    }

    if (!this.byAgent[agent]) this.byAgent[agent] = emptyBucket();
    if (!this.byModel[cost.modelKey]) {
      this.byModel[cost.modelKey] = {
        ...emptyBucket(),
        rates: cost.rates,
        ratesKnown: cost.ratesKnown,
      };
    }

    addToBucket(this.totals, tokens, cost.usd);
    addToBucket(this.byAgent[agent], tokens, cost.usd);
    addToBucket(this.byModel[cost.modelKey], tokens, cost.usd);
    this.calls += 1;
    this.lastCall = {
      agent,
      model: cost.modelKey,
      rawModel: model,
      ...tokens,
      usd: cost.usd,
      ratesKnown: cost.ratesKnown,
      at: Date.now(),
    };
    return this.lastCall;
  }

  /** Client-facing snapshot for the inspector (session cumulative only). */
  toJSON() {
    const fmt = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
    const mapBuckets = (obj) =>
      Object.fromEntries(
        Object.entries(obj).map(([k, v]) => {
          const u = withUncached(v);
          return [
            k,
            {
              calls: u.calls,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cachedTokens: u.cachedTokens,
              uncachedTokens: u.uncachedTokens,
              cacheHitRate: Math.round(u.cacheHitRate * 1000) / 1000,
              totalTokens: u.totalTokens,
              usd: fmt(u.usd),
              ...(v.rates ? { rates: v.rates, ratesKnown: v.ratesKnown } : {}),
            },
          ];
        })
      );

    const configured = configuredModelRates();
    const totals = withUncached(this.totals);
    const last = this.lastCall
      ? withUncached({
          ...this.lastCall,
          calls: 1,
          usd: this.lastCall.usd,
        })
      : null;

    return {
      type: "usage_update",
      scope: "session",
      sessionStartedAt: this.startedAt,
      elapsedMs: Date.now() - this.startedAt,
      pricingSource: pricingSource(),
      configuredModels: configured,
      calls: this.calls,
      totals: {
        calls: totals.calls,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cachedTokens: totals.cachedTokens,
        uncachedTokens: totals.uncachedTokens,
        cacheHitRate: Math.round(totals.cacheHitRate * 1000) / 1000,
        totalTokens: totals.totalTokens,
        usd: fmt(totals.usd),
      },
      lastCall: last
        ? {
            agent: this.lastCall.agent,
            model: this.lastCall.model,
            rawModel: this.lastCall.rawModel,
            inputTokens: last.inputTokens,
            outputTokens: last.outputTokens,
            cachedTokens: last.cachedTokens,
            uncachedTokens: last.uncachedTokens,
            cacheHitRate: Math.round(last.cacheHitRate * 1000) / 1000,
            totalTokens: last.totalTokens,
            usd: fmt(last.usd),
            at: this.lastCall.at,
          }
        : null,
      byAgent: mapBuckets(this.byAgent),
      byModel: mapBuckets(this.byModel),
      unknownModels: this.unknownModels.slice(),
      rates: allRates(),
    };
  }
}
