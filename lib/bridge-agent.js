import { config } from "./states.js";
import { getLlmClient } from "./llm-client.js";
import { chatModelOptions } from "./model-options.js";
import { normalizeChatUsage } from "./usage.js";
import { getUserName } from "./memory-store.js";
import { pickSuggestedTopicHooks } from "./snapshot-agent.js";

const client = getLlmClient();

export function bridgeAgentAvailable() {
  return Boolean(client);
}

const BRIDGE_PROMPT = `You are June's BRIDGE — a tiny, fast idle-continuation mind.
You never speak as a separate voice. You continue June's last line using ONLY leftover whispers main did not already use.

## SHARED TURN HANDOFF

You receive:
- justSaid: exactly what June just spoke
- doNotAsk: beats/hooks main already covered — NEVER reuse these
- unusedWhispers: the ONLY allowed sources for a follow-up

If unusedWhispers is empty (no suggestions/interjections/memoryBridge/juneSelfDrop/snapshotHooks) → continue:false.

## WHEN TO CONTINUE

continue:true only when ONE unused whisper/hook still fits as a natural next beat after justSaid.

Prefer SKIP when:
- unusedWhispers is empty
- The leftover is already covered by justSaid / doNotAsk
- The user sounded closed / not interested / changed subject
- The leftover is about an older thread not in recentTurns
- You would only restate or re-ask what justSaid already did

## HOW TO WRITE THE BEAT (when continue: true)

- Continue straight from justSaid — jump into the next concrete detail.
- Ground the beat in ONE unused whisper/hook (set usedHook to that exact string).
- Do NOT greet or restate. Substance first.
- 1 short sentence. 2 max.
- June's voice: casual, no period at the end, no emojis, no dashes (- or --). No memory tags.

## OUTPUT — return ONLY valid JSON, no markdown:
{"continue":boolean,"text":string,"usedHook":string,"reason":string}

- continue false → text "" and usedHook ""
- usedHook must be the exact unused whisper/hook string you grounded the beat in
- reason is one short internal note`;

function freshList(list, used) {
  return (Array.isArray(list) ? list : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .filter((s) => !used.has(s.toLowerCase()));
}

function snapshotHooks(snapshotCache, usedTopicHooks = []) {
  if (!snapshotCache || snapshotCache.hasTopic === false) return [];
  const hooks = snapshotCache.topicHooks?.length
    ? snapshotCache.topicHooks
    : snapshotCache.conversationAngles || [];
  if (!hooks.length) return [];
  return pickSuggestedTopicHooks(hooks, usedTopicHooks, 4);
}

function collectLeftovers(thoughtCache, usedThinkerHooks, snapshotCache, usedTopicHooks) {
  const used = new Set(
    (Array.isArray(usedThinkerHooks) ? usedThinkerHooks : []).map((h) =>
      String(h).toLowerCase()
    )
  );
  const suggestions = freshList(thoughtCache?.suggestions, used);
  const interjections = freshList(thoughtCache?.interjections, used);
  const memoryBridge =
    thoughtCache?.memoryBridge && !used.has(String(thoughtCache.memoryBridge).toLowerCase())
      ? String(thoughtCache.memoryBridge).trim()
      : "";
  const juneSelfDrop =
    thoughtCache?.juneSelfDrop && !used.has(String(thoughtCache.juneSelfDrop).toLowerCase())
      ? String(thoughtCache.juneSelfDrop).trim()
      : "";
  const hooks = snapshotHooks(snapshotCache, usedTopicHooks);
  return { suggestions, interjections, memoryBridge, juneSelfDrop, hooks };
}

/**
 * Cheap local gate — skip the API call when there's nothing useful to bridge from.
 * leftoversOnly: bare snapshot topic is NOT enough; need concrete unused beats.
 */
export function hasBridgeMaterial(
  thoughtCache,
  {
    dryReplyStreak = 0,
    usedThinkerHooks = [],
    snapshotCache = null,
    usedTopicHooks = [],
    leftoversOnly = false,
  } = {}
) {
  if (dryReplyStreak >= 2) return false;

  const {
    suggestions,
    interjections,
    memoryBridge,
    juneSelfDrop,
    hooks,
  } = collectLeftovers(thoughtCache, usedThinkerHooks, snapshotCache, usedTopicHooks);

  const hasWhisper =
    suggestions.length > 0
    || interjections.length > 0
    || Boolean(memoryBridge)
    || Boolean(juneSelfDrop)
    || hooks.length > 0;

  if (leftoversOnly) {
    return hasWhisper;
  }

  if (!hasWhisper && !(snapshotCache?.topic && snapshotCache.hasTopic !== false)) {
    return false;
  }
  if (!hasWhisper) return false;

  const conf = typeof thoughtCache?.confidence === "number" ? thoughtCache.confidence : 0;
  if (
    conf < 0.2
    && suggestions.length === 0
    && !memoryBridge
    && !juneSelfDrop
    && hooks.length === 0
  ) {
    return false;
  }

  return true;
}

function parseJsonObject(text) {
  const raw = (text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
  }
  return null;
}

function normalizeResult(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return { continue: false, text: "", usedHook: "", reason: "parse_failed" };
  }
  const should = Boolean(parsed.continue);
  const text = should ? String(parsed.text || "").trim() : "";
  const usedHook = should ? String(parsed.usedHook || "").trim() : "";
  if (!should || !text || /^skip\b/i.test(text)) {
    return {
      continue: false,
      text: "",
      usedHook: "",
      reason: String(parsed.reason || "skip").slice(0, 120),
    };
  }
  return {
    continue: true,
    text: text.slice(0, 220),
    usedHook: usedHook.slice(0, 160),
    reason: String(parsed.reason || "").slice(0, 120),
  };
}

function buildWhisperPayload(thoughtCache, usedThinkerHooks = [], snapshotCache = null, usedTopicHooks = []) {
  const used = new Set(
    (Array.isArray(usedThinkerHooks) ? usedThinkerHooks : []).map((h) =>
      String(h).toLowerCase()
    )
  );
  const leftovers = collectLeftovers(
    thoughtCache,
    usedThinkerHooks,
    snapshotCache,
    usedTopicHooks
  );

  return {
    topic: thoughtCache?.topic || snapshotCache?.topic || "",
    confidence: thoughtCache?.confidence ?? 0,
    tone: thoughtCache?.tone || null,
    interjections: leftovers.interjections.slice(0, 2),
    suggestions: leftovers.suggestions.slice(0, 3),
    associations: freshList(thoughtCache?.associations, used).slice(0, 3),
    expansionAngles: freshList(thoughtCache?.expansionAngles, used).slice(0, 2),
    memoryBridge: leftovers.memoryBridge || null,
    juneSelfDrop: leftovers.juneSelfDrop || null,
    snapshotTopic: snapshotCache?.topic || null,
    snapshotHooks: leftovers.hooks,
    avoid: Array.isArray(thoughtCache?.avoid) ? thoughtCache.avoid.slice(0, 4) : [],
    usedHooks: (Array.isArray(usedThinkerHooks) ? usedThinkerHooks : []).slice(0, 8),
  };
}

/**
 * Decide + compose a short idle continuation from leftover Thinker whispers.
 * Never blocks the main voice path — session only calls this while idle.
 */
export async function runBridgeAgent({
  history = [],
  memory = {},
  thoughtCache = null,
  snapshotCache = null,
  usedThinkerHooks = [],
  usedTopicHooks = [],
  dryReplyStreak = 0,
  justSaid = "",
  doNotAsk = [],
  signal,
  onUsage = null,
} = {}) {
  if (!client) return { continue: false, text: "", usedHook: "", reason: "no_client" };
  if (
    !hasBridgeMaterial(thoughtCache, {
      dryReplyStreak,
      usedThinkerHooks,
      snapshotCache,
      usedTopicHooks,
      leftoversOnly: true,
    })
  ) {
    return { continue: false, text: "", usedHook: "", reason: "no_material" };
  }

  const unusedWhispers = buildWhisperPayload(
    thoughtCache,
    usedThinkerHooks,
    snapshotCache,
    usedTopicHooks
  );
  const leftoverCount =
    (unusedWhispers.suggestions?.length || 0)
    + (unusedWhispers.interjections?.length || 0)
    + (unusedWhispers.snapshotHooks?.length || 0)
    + (unusedWhispers.memoryBridge ? 1 : 0)
    + (unusedWhispers.juneSelfDrop ? 1 : 0);

  if (leftoverCount === 0) {
    return { continue: false, text: "", usedHook: "", reason: "no_leftovers" };
  }

  const recent = history.slice(-4).map((m) => ({
    role: m.role,
    content: String(m.content || "").slice(0, 320),
  }));

  const payload = {
    userName: getUserName(memory),
    dryReplyStreak,
    justSaid: String(justSaid || "").slice(0, 400),
    doNotAsk: (Array.isArray(doNotAsk) && doNotAsk.length
      ? doNotAsk
      : usedThinkerHooks
    ).slice(0, 8),
    unusedWhispers,
    recentTurns: recent,
  };

  try {
    const response = await client.chat.completions.create(
      {
        ...chatModelOptions(config.followupModel, {
          temperature: Math.min((config.mainTemperature || 0.56) + 0.05, 0.9),
          maxTokens: 160,
        }),
        messages: [
          { role: "system", content: BRIDGE_PROMPT },
          {
            role: "user",
            content: JSON.stringify(payload),
          },
        ],
      },
      { signal }
    );

    if (signal?.aborted) {
      return { continue: false, text: "", usedHook: "", reason: "aborted" };
    }

    const usage = normalizeChatUsage(response.usage);
    if (usage) {
      try {
        onUsage?.({
          agent: "followup",
          model: config.followupModel,
          usage,
        });
      } catch {}
    }

    const content = response.choices?.[0]?.message?.content || "";
    const result = normalizeResult(parseJsonObject(content));

    // Hard reject if Bridge tried to reuse a do-not-ask hook.
    if (result.continue && result.usedHook) {
      const blocked = new Set(
        payload.doNotAsk.map((h) => String(h).toLowerCase())
      );
      if (blocked.has(result.usedHook.toLowerCase())) {
        return {
          continue: false,
          text: "",
          usedHook: "",
          reason: "reused_do_not_ask",
        };
      }
    }

    return result;
  } catch (err) {
    if (err?.name === "AbortError" || signal?.aborted) {
      return { continue: false, text: "", usedHook: "", reason: "aborted" };
    }
    console.error("[bridge]", err.message);
    return { continue: false, text: "", usedHook: "", reason: err.message || "error" };
  }
}
