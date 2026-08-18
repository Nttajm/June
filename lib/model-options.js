/** o-series reasoning models reject temperature / max_tokens. */
export function isReasoningModel(model = "") {
  const m = String(model || "").toLowerCase();
  return /^(o1|o3|o4)(-|$)/.test(m);
}

export function isGptOssModel(model = "") {
  return /gpt-oss/i.test(String(model || ""));
}

/**
 * Chat Completions options for normal + reasoning models.
 * Reasoning: no temperature; max_completion_tokens with headroom; low effort for latency.
 * gpt-oss (Fireworks): keep reasoning_effort low so thinking does not starve spoken content.
 */
export function chatModelOptions(model, {
  temperature,
  maxTokens,
  reasoningEffort = "low",
  frequencyPenalty,
  presencePenalty,
} = {}) {
  const opts = { model };
  if (isReasoningModel(model)) {
    if (maxTokens != null) {
      opts.max_completion_tokens = Math.max(Number(maxTokens) || 0, 2048);
    }
    if (reasoningEffort) opts.reasoning_effort = reasoningEffort;
  } else {
    if (temperature != null) opts.temperature = temperature;
    if (maxTokens != null) opts.max_tokens = maxTokens;
    if (frequencyPenalty != null) opts.frequency_penalty = frequencyPenalty;
    if (presencePenalty != null) opts.presence_penalty = presencePenalty;
    if (isGptOssModel(model)) {
      const effort = String(reasoningEffort || "low").toLowerCase();
      opts.reasoning_effort = ["low", "medium", "high"].includes(effort) ? effort : "low";
    }
  }
  return opts;
}

/**
 * Responses API extras for reasoning models (background agents).
 * Low effort keeps latency down while still improving judgment.
 */
export function responsesReasoningExtras(model, { maxOutputTokens, reasoningEffort = "low" } = {}) {
  const extras = {};
  if (maxOutputTokens != null) {
    extras.max_output_tokens = isReasoningModel(model)
      ? Math.max(Number(maxOutputTokens) || 0, 2048)
      : maxOutputTokens;
  }
  if (isReasoningModel(model) && reasoningEffort) {
    extras.reasoning = { effort: reasoningEffort };
  }
  return extras;
}
