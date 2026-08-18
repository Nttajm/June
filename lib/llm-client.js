import OpenAI from "openai";
import { config } from "./states.js";

let cached = null;
let cachedKey = "";

function cacheKey() {
  return `${config.llmProvider}|${config.llmBaseURL}|${config.llmApiKey ? "1" : "0"}`;
}

/** Shared OpenAI-SDK client. Fireworks uses the same SDK with a different base URL. */
export function getLlmClient() {
  const key = cacheKey();
  if (cached && cachedKey === key) return cached;
  cachedKey = key;
  if (!config.llmApiKey) {
    cached = null;
    return null;
  }
  const opts = { apiKey: config.llmApiKey };
  if (config.llmBaseURL) opts.baseURL = config.llmBaseURL;
  cached = new OpenAI(opts);
  return cached;
}

export function llmClientAvailable() {
  return Boolean(getLlmClient());
}
