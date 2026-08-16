import OpenAI from "openai";
import { config, SYSTEM_PROMPT } from "./states.js";
import {
  buildMemoryInstructions,
  buildMemoryEngagement,
  buildConversationRhythm,
  isDryUtterance,
  countDryReplyStreak,
} from "./memory.js";
import {
  MEMORY_TOOLS,
  PAST_CHAT_TOOLS,
  runMemoryTool,
  buildMemoryToolGuidance,
  buildPastChatIndex,
} from "./memory-tools.js";
import { isSnapshotTopicActive, pickSuggestedTopicHooks } from "./snapshot-agent.js";
import { SNAPSHOT_TOOLS, runSnapshotTool, buildSnapshotToolGuidance } from "./snapshot-tools.js";
import { isReasoningModel, chatModelOptions } from "./model-options.js";

export { isReasoningModel, chatModelOptions };

const client = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : null;
const MAX_TOOL_ROUNDS = 2;

export function llmAvailable() {
  return Boolean(client);
}

export function buildThoughtHints(thoughtCache, userText = "", dryReplyStreak = 0) {
  if (!thoughtCache) return "";

  const hasBridge = Boolean(thoughtCache.memoryBridge);
  const hasDrops = thoughtCache.casualDrops?.length > 0;
  const hasSelfDrop = Boolean(thoughtCache.juneSelfDrop);
  const hasTopic = thoughtCache.confidence >= 0.35 && thoughtCache.topic;
  const hasInterjections = thoughtCache.interjections?.length > 0;
  const hasSuggestions = thoughtCache.suggestions?.length > 0;
  const hasTone = Boolean(thoughtCache.tone?.userMood || thoughtCache.tone?.notes);

  if (!hasBridge && !hasDrops && !hasTopic && !hasSelfDrop && !hasInterjections && !hasSuggestions && !hasTone) {
    return "";
  }

  const lines = ["--- THINKER WHISPERS (background coach — use ONE when it fits, like a real person) ---"];
  lines.push("Prefer substance-first beats. Skip soft warm-up ladders.");

  if (dryReplyStreak >= 2) {
    lines.push("Dry streak — skip memory bridges and topic questions. Use juneSelfDrop, an interjection, drift, or ignore these hints — but NEVER claim their remembered hobbies as something you were just doing.");
  }

  if (hasTone) {
    const mood = thoughtCache.tone.userMood || "neutral";
    const energy = thoughtCache.tone.energy || "medium";
    lines.push(`User tone: ${mood} / energy ${energy}${thoughtCache.tone.notes ? ` — ${thoughtCache.tone.notes}` : ""}`);
  }

  if (hasInterjections) {
    lines.push(`Content beats you can weave in: ${thoughtCache.interjections.map((s) => `"${s}"`).join(" / ")}`);
  }

  if (hasSuggestions && dryReplyStreak < 2) {
    lines.push(`Relevant things you could mention or ask: ${thoughtCache.suggestions.join(" / ")}`);
  }

  if (thoughtCache.topic && hasTopic) {
    lines.push(`Active topic: ${thoughtCache.topic}`);
  }

  if (hasDrops) {
    lines.push(`Thoughts that could slip out naturally: ${thoughtCache.casualDrops.join(" / ")}`);
  }

  if (thoughtCache.associations?.length) {
    lines.push(`Loose associations if convo drifts: ${thoughtCache.associations.join(", ")}`);
  }

  if (hasBridge && dryReplyStreak < 2) {
    lines.push(`Memory angle (adjacent — don't just name the topic, open a related thread): "${thoughtCache.memoryBridge}"`);
  }

  if (thoughtCache.expansionAngles?.length > 0 && dryReplyStreak < 2) {
    lines.push(`Adjacent threads you could take it to: ${thoughtCache.expansionAngles.join(" / ")}`);
  }

  if (thoughtCache.personification?.pretendExperienced) {
    const how = thoughtCache.personification.ifAskedHow;
    lines.push(`You can act like you've experienced this topic ONLY if it is NOT from their memory${how ? `; if they ask how: "${how}"` : ""}`);
  }

  if (thoughtCache.juneSelfDrop) {
    lines.push(`Something YOU were just thinking (June's own life — never their hobbies remixed as yours): "${thoughtCache.juneSelfDrop}"`);
    lines.push("If that drop overlaps their memory interests, IGNORE it and invent an unrelated June beat, or ask about THEIR interest in second person.");
  }

  if (thoughtCache.avoid?.length) {
    lines.push(`Don't: ${thoughtCache.avoid.join("; ")}`);
  }

  if (isDryUtterance(userText) && (hasBridge || hasInterjections || dryReplyStreak >= 1)) {
    lines.push("Short reply — memory angle is optional. Match energy, tease, or take an expansion thread. Do NOT force the same topic back.");
  }

  return lines.join("\n");
}

export function buildSnapshotContext(snapshotCache, { usedTopicHooks = [], dryReplyStreak = 0, userText = "", history = [] } = {}) {
  if (!snapshotCache) return "";

  const topicHooks = snapshotCache.topicHooks?.length
    ? snapshotCache.topicHooks
    : snapshotCache.conversationAngles || [];

  if (!snapshotCache.snapshot && topicHooks.length === 0) return "";

  const topicActive = isSnapshotTopicActive(snapshotCache, userText, history);
  const suggested = pickSuggestedTopicHooks(topicHooks, usedTopicHooks, 3);
  const pushHooks = topicActive && dryReplyStreak < 2 && suggested.length > 0;

  const lines = [];

  if (pushHooks) {
    lines.push("--- TOPIC HOOKS (ACTIVE — use this turn) ---");
    lines.push(`Topic: ${snapshotCache.topic} (${snapshotCache.topicType})`);
    if (snapshotCache.snapshot) lines.push(`Vibe: ${snapshotCache.snapshot}`);
    lines.push("");
    lines.push("MANDATE: Topic is live. Name-drop at least ONE specific hook this turn — in your reaction, your opinion, OR the question you ask.");
    lines.push("When the topic is active, use hooks on roughly every other turn. Generic questions about the topic are banned.");
    lines.push(`Priority hooks (pick 1-2, prefer unused): ${suggested.join(" · ")}`);
    if (usedTopicHooks.length > 0) {
      lines.push(`Already used (pick something fresh): ${usedTopicHooks.join(", ")}`);
    }
    lines.push("");
    lines.push("If you end with a question, it MUST reference a specific hook — not 'how was class' or 'what else'.");
    lines.push(`Question shapes (vary — never reuse the same filler): "are you on ${suggested[0]} yet?" / "${suggested[1] || suggested[0]} is where it gets brutal though" / "you into ${suggested[2] || suggested[0]} or nah?"`);
    lines.push("");
    lines.push("All hooks:");
    for (const hook of topicHooks) {
      lines.push(`- ${hook}`);
    }
    lines.push("");
    lines.push(`>>> THIS TURN: weave in "${suggested[0]}"${suggested[1] ? ` or "${suggested[1]}"` : ""} — especially if you ask a question <<<`);
    return lines.join("\n");
  }

  lines.push("--- TOPIC HOOKS (background — use when topic comes back) ---");
  lines.push(`Topic: ${snapshotCache.topic} (${snapshotCache.topicType})`);
  if (snapshotCache.snapshot) lines.push(`Vibe: ${snapshotCache.snapshot}`);

  if (topicHooks.length > 0) {
    lines.push("");
    lines.push("When this topic is live again, name-drop ONE hook — especially in questions:");
    for (const hook of topicHooks) {
      lines.push(`- ${hook}`);
    }
  }

  lines.push("");
  lines.push("USE THIS: Specific hooks make you sound sharp. Drop a brand, term, or subtopic — never talk about the topic generically.");

  return lines.join("\n");
}

function buildSystemContent(
  memory,
  context,
  thoughtCache,
  userText = "",
  history = [],
  recentCallbacks = [],
  snapshotCache = null,
  usedTopicHooks = [],
  pastChats = []
) {
  const dryReplyStreak = countDryReplyStreak(history, userText);
  const topicHooks = snapshotCache?.topicHooks || snapshotCache?.conversationAngles || [];
  const topicActive = isSnapshotTopicActive(snapshotCache, userText, history);
  const suggestedHooks = pickSuggestedTopicHooks(topicHooks, usedTopicHooks, 3);
  const hooksEngaged = topicActive && dryReplyStreak < 2 && suggestedHooks.length > 0;

  const extra = buildMemoryInstructions(memory, context, userText);
  const pastIndex = buildPastChatIndex(pastChats);
  const rhythm = buildConversationRhythm(userText, history, recentCallbacks, {
    hooksEngaged,
    suggestedHooks,
    dryReplyStreak,
  });
  const engagement = buildMemoryEngagement(memory, { userText, history, recentCallbacks });
  const hints = buildThoughtHints(thoughtCache, userText, dryReplyStreak);
  const snapshot = buildSnapshotContext(snapshotCache, { usedTopicHooks, dryReplyStreak, userText, history });
  const toolGuide = buildMemoryToolGuidance();
  const snapshotToolGuide = buildSnapshotToolGuidance(snapshotCache);
  const parts = [SYSTEM_PROMPT, extra];
  if (pastIndex) parts.push(pastIndex);
  parts.push(toolGuide);
  if (snapshotToolGuide) parts.push(snapshotToolGuide);
  parts.push(rhythm);
  if (engagement) parts.push(engagement);
  if (hints) parts.push(hints);
  if (snapshot) parts.push(snapshot);
  return parts.join("\n\n");
}

function buildAvailableTools(snapshotCache) {
  const topicHooks = snapshotCache?.topicHooks?.length
    ? snapshotCache.topicHooks
    : snapshotCache?.conversationAngles || [];

  const base = [...MEMORY_TOOLS, ...PAST_CHAT_TOOLS];
  return (snapshotCache && (snapshotCache.snapshot || topicHooks.length > 0))
    ? [...base, ...SNAPSHOT_TOOLS]
    : base;
}

const GREETING_TASK = `--- GREETING TASK ---
The user just opened the app. They have not spoken yet. Generate ONE short casual spoken greeting — 1 sentence, maybe 2 max.
Read the GENERAL INFO block above first — it is always available on greetings. If Name is set, use that name/nickname. If standing prefs exist (speech style, humor rules, always-do habits), follow them from the first word — do not wait to be reminded.
You MAY weave ONE other general_info fact naturally (don't dump a list).
Match the time of day and vibe from context. If Name is unknown, work in a casual ask for it.
Do NOT invent facts that are not in GENERAL INFO / memory. Do NOT loop the same detail every greeting if you have several.
If context includes time since last chat, you MAY reference it on greeting ("back so soon?") — rarely, only when the gap is interesting.
If they ask what you've been up to or how you've been, use the time span from context (e.g. "nothing much the last hour", "since the last couple days I've just been...").
Sound like a real phone call — short, casual, no periods at end. No memory tags. No emojis. no emdashes (--) or dashes (-). Do NOT end with a generic question unless it's specific to something you know about them. Lead with their name or a specific detail you know — e.g. "hey Jay, what's on your mind this evening?" — not a padded warm-up about chilling or vibes`;

export async function generateGreeting({ memory, context, thoughtCache, snapshotCache = null }) {
  if (!client) return null;

  const response = await client.chat.completions.create({
    ...chatModelOptions(config.openaiModel, { temperature: config.mainTemperature }),
    messages: [
      { role: "system", content: `${buildSystemContent(memory, context, thoughtCache, "", [], [], snapshotCache)}\n\n${GREETING_TASK}` },
      { role: "user", content: "Greet me as I open the app." },
    ],
  });

  return response.choices[0]?.message?.content?.trim() || null;
}

const FOLLOWUP_TASK = `--- KEEP-TALKING TASK (idle continuation) ---
You JUST replied and the user has gone quiet for a beat. Keep talking like a real friend filling a tiny silence on a call — pick your own thought back up and add ONE more specific beat.
- Continue straight from your last line — jump into the next concrete detail. Do NOT greet or restate what you or they already said. Start on substance (a noun, a take, a specific beat), not a soft warm-up word.
- Drop ONE concrete detail, hot take, or fact tied to a topic hook below. Be specific, never generic.
- 1 short sentence. 2 max. This is a small add-on, not a new monologue.
- End it as a statement. Do NOT ask another question (you already asked one).
- June's voice: casual, lowercase-ish, no period at the end, no emojis, no dashes (- or --... use a comma or just keep going). No memory tags.
If nothing specific is worth adding, reply with exactly: SKIP`;

export async function* streamSnapshotFollowup({ history = [], memory, context, snapshotCache = null, usedTopicHooks = [], signal } = {}) {
  if (!client || !snapshotCache) return;

  const topicHooks = snapshotCache.topicHooks?.length
    ? snapshotCache.topicHooks
    : snapshotCache.conversationAngles || [];
  if (topicHooks.length === 0) return;

  const suggested = pickSuggestedTopicHooks(topicHooks, usedTopicHooks, 4);
  const hookPool = suggested.length ? suggested : topicHooks.slice(0, 4);

  const lines = [];
  lines.push(`Topic: ${snapshotCache.topic}${snapshotCache.topicType ? ` (${snapshotCache.topicType})` : ""}`);
  if (snapshotCache.snapshot) lines.push(`Vibe: ${snapshotCache.snapshot}`);
  lines.push(`Pick the ONE hook that best fits where the convo just was (prefer fresh): ${hookPool.join(" · ")}`);
  if (usedTopicHooks.length) lines.push(`Already used (avoid): ${usedTopicHooks.join(", ")}`);

  const systemContent = `${SYSTEM_PROMPT}\n\n${FOLLOWUP_TASK}\n\n--- SNAPSHOT HOOKS ---\n${lines.join("\n")}`;
  const recent = history.slice(-4);

  const stream = await client.chat.completions.create(
    {
      ...chatModelOptions(config.followupModel, {
        temperature: Math.min(config.mainTemperature + 0.05, 0.95),
        maxTokens: 60,
      }),
      messages: [
        { role: "system", content: systemContent },
        ...recent,
        { role: "user", content: "(the user is quiet — keep your last thought going with one specific beat, or reply SKIP)" },
      ],
      stream: true,
    },
    { signal }
  );

  for await (const chunk of stream) {
    if (signal?.aborted) break;
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
}

/** Immediate searching-out-loud lines when tools kick with empty Phase A. */
const RECALL_OPEN_BEATS = [
  "lemme see… ",
  "uhh, okay I'll check… ",
  "hang on… ",
  "wait, let me look… ",
  "okay one sec… ",
  "mm, let me think… ",
];

/** Second beat if recall is still in flight (~1.5–3s after the open). */
const RECALL_MID_BEATS = [
  "still looking… ",
  "mhm… ",
  "what was that… ",
  "where is that… ",
  "what did we talk about… ",
  "it's in here somewhere… ",
];

/** Breath after a mid-search beat before Phase B starts talking. */
const RECALL_MID_GAP_MS = 300;

/** Delay from open beat → mid beat (natural searching silence). */
const RECALL_MID_DELAY_MIN_MS = 1500;
const RECALL_MID_DELAY_SPAN_MS = 1500; // → up to 3000ms

const MURMUR_PHRASE_RE =
  /\b(?:ok(?:ay)?\s+)?(?:lemm?e?(?:\s+see|\s+look)?|uhh?,?\s*(?:okay\s+)?I'?ll\s+check|wait(?:\s+wait)?|hang\s+on|one\s+sec|let\s+me\s+(?:see|remember|check|look|think)|still\s+looking|what\s+was\s+that|where\s+is\s+that|what\s+did\s+we\s+talk\s+about|it'?s\s+in\s+here\s+somewhere|mm+|mhm+|yeah+)\b/gi;

function hasRealPhaseASpeech(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  // Strip searching/murmur beats; anything left of substance counts as real Phase A
  const leftover = t
    .replace(MURMUR_PHRASE_RE, " ")
    .replace(/[.…,!-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return leftover.length >= 8;
}

function pickRecallBeat(pool, exclude = "") {
  const options = pool.filter((b) => b !== exclude);
  const list = options.length ? options : pool;
  return list[Math.floor(Math.random() * list.length)];
}

function sleepMs(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isRecallToolName(name) {
  return /^(scan_memory_category|get_memory_detail|list_past_chats|get_past_chat)$/.test(name || "");
}

/** Short soft-bridge for non-recall tools (snapshot hooks, etc.). */
const SHORT_TOOL_BEATS = [
  "mm ",
  "yeah ",
];

function toolNamesFromAcc(toolAcc) {
  return Object.values(toolAcc || {})
    .map((tc) => tc.function?.name || "")
    .filter(Boolean);
}

function buildStepContinueMessage({
  phaseAText,
  toolNames = [],
  snapshotCache = null,
  thoughtCache = null,
  usedTopicHooks = [],
}) {
  const lines = [
    "--- STEP CONTINUE ---",
    "You already started speaking. Tool results are in the messages above.",
    `You already said: "${String(phaseAText || "").trim().slice(0, 220)}"`,
    "Add ONE short continuation that segues naturally from that line.",
    "Do NOT restart, re-greet, re-ack, or restate what you already said.",
    "Start mid-thought on substance (a specific hook, fact, or sharp question).",
    "1 short sentence, 2 max. Keep June's spoken voice. No memory tags, no emojis.",
  ];
  if (toolNames.length) {
    lines.push(`Tools just returned: ${toolNames.join(", ")}`);
  }

  const hooks = snapshotCache?.topicHooks?.length
    ? snapshotCache.topicHooks
    : snapshotCache?.conversationAngles || [];
  if (snapshotCache?.topic && hooks.length) {
    const suggested = pickSuggestedTopicHooks(hooks, usedTopicHooks, 3);
    lines.push(`Fresh snapshot: ${snapshotCache.topic}${snapshotCache.topicType ? ` (${snapshotCache.topicType})` : ""}`);
    if (snapshotCache.snapshot) lines.push(`Vibe: ${snapshotCache.snapshot}`);
    if (suggested.length) lines.push(`Prefer weaving one of: ${suggested.join(" · ")}`);
  }

  if (thoughtCache?.suggestions?.length) {
    lines.push(`Thinker hints (optional, pick at most one): ${thoughtCache.suggestions.slice(0, 2).join(" / ")}`);
  } else if (thoughtCache?.interjections?.length) {
    lines.push(`Thinker beats (optional): ${thoughtCache.interjections.slice(0, 2).join(" / ")}`);
  }

  return lines.join("\n");
}

/**
 * Accumulate streamed tool_call fragments by index into complete tool_calls.
 */
function mergeToolCallDeltas(acc, deltas) {
  for (const tc of deltas || []) {
    const idx = tc.index ?? 0;
    if (!acc[idx]) {
      acc[idx] = {
        id: tc.id || "",
        type: "function",
        function: { name: "", arguments: "" },
      };
    }
    if (tc.id) acc[idx].id = tc.id;
    if (tc.function?.name) acc[idx].function.name += tc.function.name;
    if (tc.function?.arguments) acc[idx].function.arguments += tc.function.arguments;
  }
  return acc;
}

/**
 * Main reply stream with bounded two-step memory tool loop + in-turn step mode.
 * Phase A speaks immediately; tools enrich; Phase B continues the same TTS stream.
 * Only content deltas are yielded — tool chatter never reaches TTS/UI.
 */
export async function* streamReply({
  history,
  userText,
  memory,
  context,
  thoughtCache,
  recentCallbacks = [],
  signal,
  snapshotCache = null,
  usedTopicHooks = [],
  pastChats = [],
  onTrace,
  onToolsStarted = null,
  awaitEnrichment = null,
  getLiveSnapshot = null,
  getLiveThought = null,
}) {
  if (!client) {
    yield "I'm not fully wired up yet, but I heard you say: " + userText;
    return;
  }

  let liveSnapshot = snapshotCache;
  let liveThought = thoughtCache;

  const systemContent = buildSystemContent(
    memory,
    context,
    liveThought,
    userText,
    history,
    recentCallbacks,
    liveSnapshot,
    usedTopicHooks,
    pastChats
  );

  const dryReplyStreak = countDryReplyStreak(history, userText);
  const temperature = dryReplyStreak >= 2
    ? Math.min(config.mainTemperature + 0.12, 0.9)
    : config.mainTemperature;

  const messages = [
    { role: "system", content: systemContent },
    ...history,
    { role: "user", content: userText },
  ];
  let availableTools = buildAvailableTools(liveSnapshot);
  const stepMode = config.stepModeEnabled !== false;
  let phaseASpoken = "";
  let toolsKickSent = false;
  let softBridgeYielded = false;
  let midBeatYielded = false;
  let softBridgeAt = 0;
  let lastOpenBeat = "";

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) return;

    const allowTools = round < MAX_TOOL_ROUNDS;
    const stream = await client.chat.completions.create(
      {
        ...chatModelOptions(config.openaiModel, { temperature }),
        messages,
        stream: true,
        ...(allowTools
          ? { tools: availableTools, tool_choice: "auto" }
          : { tool_choice: "none" }),
      },
      { signal }
    );

    const toolAcc = {};
    let finishReason = null;
    let contentBuf = "";

    for await (const chunk of stream) {
      if (signal?.aborted) return;
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta || {};
      if (delta.content) {
        contentBuf += delta.content;
        phaseASpoken += delta.content;
        yield delta.content;
      }
      if (delta.tool_calls) {
        mergeToolCallDeltas(toolAcc, delta.tool_calls);
        if (!toolsKickSent) {
          toolsKickSent = true;
          try { onToolsStarted?.(); } catch {}
        }
        // Soft-bridge only when Phase A is empty/murmur — never overwrite a real reaction.
        // Wait until we know the tool name so recall phrases don't leak onto snapshot tools.
        if (
          stepMode
          && !softBridgeYielded
          && !hasRealPhaseASpeech(contentBuf)
        ) {
          const names = toolNamesFromAcc(toolAcc);
          if (names.length) {
            softBridgeYielded = true;
            softBridgeAt = Date.now();
            const recallingNow = names.some(isRecallToolName);
            const open = recallingNow
              ? pickRecallBeat(RECALL_OPEN_BEATS, lastOpenBeat)
              : pickRecallBeat(SHORT_TOOL_BEATS, lastOpenBeat);
            lastOpenBeat = open;
            const beat = (contentBuf && !/\s$/.test(contentBuf) ? " " : "") + open;
            contentBuf += beat;
            phaseASpoken += beat;
            yield beat;
          }
        }
      }
    }

    const toolCalls = Object.keys(toolAcc)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => toolAcc[k])
      .filter((tc) => tc.function?.name);

    if (finishReason !== "tool_calls" || toolCalls.length === 0 || !allowTools) {
      return;
    }

    // Append assistant tool-call message (may include spoken Phase A beat in contentBuf)
    messages.push({
      role: "assistant",
      content: contentBuf || null,
      tool_calls: toolCalls,
    });

    // Prefer live snapshot for tool dispatch (may have refreshed during Phase A)
    if (typeof getLiveSnapshot === "function") {
      try {
        const fresh = getLiveSnapshot();
        if (fresh) liveSnapshot = fresh;
      } catch {}
    }

    const toolNames = [];
    for (const tc of toolCalls) {
      const name = tc.function?.name || "";
      toolNames.push(name);
      const argsRaw = tc.function?.arguments || "";
      let args = argsRaw;
      try { args = JSON.parse(argsRaw); } catch {}
      const result = name === "check_snapshot_hooks"
        ? runSnapshotTool(liveSnapshot, tc, { userText, history, usedTopicHooks })
        : runMemoryTool(memory, tc, { pastChats });
      console.log(`[tool] ${name}`, argsRaw.slice?.(0, 80) || "");
      onTrace?.({
        agent: "main",
        phase: "tool",
        name,
        detail: { args, result: result.content },
      });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result.content,
      });
    }

    const recalling = toolNames.some(isRecallToolName);

    // Only budget-wait for thinker/snapshot on recall turns — otherwise peek caches and go.
    // (Force-kicked enrichment used to stall every tool turn for up to ~700ms.)
    const enrichPromise = (stepMode && typeof awaitEnrichment === "function")
      ? awaitEnrichment(recalling ? (config.stepEnrichWaitMs || 700) : 0).catch(() => null)
      : null;

    // Mid-search beat while recall is still in flight — feels like actually looking
    if (
      stepMode
      && softBridgeYielded
      && !midBeatYielded
      && recalling
      && !hasRealPhaseASpeech(phaseASpoken)
      && !signal?.aborted
    ) {
      const targetMs = RECALL_MID_DELAY_MIN_MS
        + Math.floor(Math.random() * RECALL_MID_DELAY_SPAN_MS); // 1.5–3s after open
      const elapsed = softBridgeAt ? Date.now() - softBridgeAt : 0;
      await sleepMs(targetMs - elapsed, signal);
      if (!signal?.aborted && !midBeatYielded) {
        midBeatYielded = true;
        const mid = pickRecallBeat(RECALL_MID_BEATS);
        phaseASpoken += mid;
        yield mid;
        onTrace?.({
          agent: "main",
          phase: "tool",
          name: "recall_mid_beat",
          detail: { beat: mid.trim(), afterMs: Date.now() - softBridgeAt },
        });
        // Short breath so "still looking…" lands before the answer starts
        await sleepMs(RECALL_MID_GAP_MS, signal);
      }
    }

    if (enrichPromise) {
      try {
        const enriched = await enrichPromise;
        if (enriched?.snapshotCache) liveSnapshot = enriched.snapshotCache;
        if (enriched?.thoughtCache) liveThought = enriched.thoughtCache;
      } catch {}
    } else {
      if (typeof getLiveSnapshot === "function") {
        try { liveSnapshot = getLiveSnapshot() || liveSnapshot; } catch {}
      }
      if (typeof getLiveThought === "function") {
        try { liveThought = getLiveThought() || liveThought; } catch {}
      }
    }

    availableTools = buildAvailableTools(liveSnapshot);

    // Soft-bridge counts as spoken so Phase B does not re-ack / re-search out loud
    if (stepMode && (hasRealPhaseASpeech(phaseASpoken) || softBridgeYielded)) {
      messages.push({
        role: "system",
        content: buildStepContinueMessage({
          phaseAText: phaseASpoken,
          toolNames,
          snapshotCache: liveSnapshot,
          thoughtCache: liveThought,
          usedTopicHooks,
        }),
      });
      onTrace?.({
        agent: "main",
        phase: "tool",
        name: "step_continue",
        detail: {
          phaseAChars: phaseASpoken.length,
          tools: toolNames,
          snapshotTopic: liveSnapshot?.topic || null,
        },
      });
    }
    // Loop continues — next round may explore further or speak Phase B continuation
  }
}
