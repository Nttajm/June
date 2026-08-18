import { getLlmClient, llmClientAvailable } from "./llm-client.js";
import { config, SYSTEM_PROMPT } from "./states.js";
import {
  buildMemoryInstructions,
  buildMemoryEngagement,
  buildConversationRhythm,
  isDryUtterance,
  countDryReplyStreak,
  enrichGreetingContext,
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
import {
  SEARCH_TOOLS,
  runWebSearchTool,
  buildSearchToolGuidance,
  searchToolsAvailable,
  extractSearchSources,
} from "./search-tools.js";
import {
  CLIENT_TOOLS,
  runClientTool,
  isClientToolName,
  buildClientToolGuidance,
} from "./client-tools.js";
import { buildYouTubePlayFromSearch, searchResultsHaveYouTube } from "./youtube-utils.js";
import {
  GMAIL_TOOLS,
  runGmailTool,
  gmailToolsAvailable,
  buildGmailToolGuidance,
} from "./gmail-tools.js";
import { runGmailAgent } from "./gmail-agent.js";
import {
  ARTIFACT_TOOLS,
  runArtifactTool,
  isArtifactToolName,
  buildArtifactToolGuidance,
  buildArtifactIndex,
} from "./artifact-tools.js";
import { shouldOfferNoteList } from "./list-format.js";
import { isReasoningModel, chatModelOptions } from "./model-options.js";
import { normalizeChatUsage } from "./usage.js";

export { isReasoningModel, chatModelOptions };

const client = getLlmClient();
const MAX_TOOL_ROUNDS = 3;

export function llmAvailable() {
  return llmClientAvailable();
}

/** Honor Thinker forceTools only when its whisper was for this same utterance (UPDATE→final ok). */
function thoughtForcesTools(thoughtCache, userText = "") {
  if (!thoughtCache?.forceTools && !thoughtCache?.recallIntent) return false;
  const src = String(thoughtCache.sourceTranscript || "").toLowerCase().replace(/\s+/g, " ").trim();
  const cur = String(userText || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!src || !cur) return false;
  if (src === cur) return true;
  // Partial UPDATE transcript vs final EndOfTurn
  if (cur.includes(src) || src.includes(cur)) return true;
  return false;
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
  const forcesTools = thoughtForcesTools(thoughtCache, userText);
  const concreteLead =
    (hasSuggestions && thoughtCache.suggestions[0])
    || (hasInterjections && thoughtCache.interjections[0])
    || (hasBridge ? thoughtCache.memoryBridge : null)
    || (hasTopic ? thoughtCache.topic : null);

  if (!hasBridge && !hasDrops && !hasTopic && !hasSelfDrop && !hasInterjections && !hasSuggestions && !hasTone && !forcesTools) {
    return "";
  }

  const lines = ["--- THINKER WHISPERS (background coach — use ONE when it fits, like a real person) ---"];
  lines.push("Prefer substance-first beats. Skip soft warm-up ladders.");
  lines.push("Memory angles are personal callbacks. If they asked you to tell them information, answer or offer a look-up — do not scan_memory for a public answer.");
  if (forcesTools) {
    lines.push("RECALL THIS TURN: call memory/past-chat tools. Never say you have no memory, don't keep logs, or forgot — dig first, then talk.");
  }

  if (dryReplyStreak >= 3) {
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

  if (hasSuggestions && dryReplyStreak < 3) {
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

  if (hasBridge && dryReplyStreak < 3) {
    lines.push(`Memory angle (adjacent — don't just name the topic, open a related thread): "${thoughtCache.memoryBridge}"`);
  }

  if (thoughtCache.expansionAngles?.length > 0 && dryReplyStreak < 3) {
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

  // Dry small-talk with a concrete lead: actually use it — don't stay in empty how-are-you ping-pong.
  if (isDryUtterance(userText) && concreteLead && dryReplyStreak < 3) {
    lines.push(
      `SHORT REPLY + OPENING: take ONE concrete lead now ("${String(concreteLead).slice(0, 120)}"). `
      + "Name the noun / ask one sharp question. Do NOT answer with only vibes, 'that's good', or another empty how-are-you."
    );
  } else if (isDryUtterance(userText) && dryReplyStreak >= 3) {
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
  const dryOpen = dryReplyStreak < 2 && suggested.length > 0 && Boolean(snapshotCache.topic);
  // Short hellos / dry replies still deserve the known topic — don't wait for
  // them to re-name it before June can use it.
  const pushHooks = suggested.length > 0 && dryReplyStreak < 2 && (topicActive || dryOpen);

  const lines = [];

  if (pushHooks) {
    lines.push(topicActive
      ? "--- TOPIC HOOKS (ACTIVE — use this turn) ---"
      : "--- TOPIC HOOKS (KNOWN THREAD — use this turn) ---");
    lines.push(`Topic: ${snapshotCache.topic} (${snapshotCache.topicType})`);
    if (snapshotCache.snapshot) lines.push(`Vibe: ${snapshotCache.snapshot}`);
    lines.push("");
    lines.push("MANDATE: You already know a live thread. Open from that concrete topic — never a blank status check when you have this.");
    lines.push("If they asked you to TELL them information, answer or offer a look-up first — hooks are seasoning, not a memory dig and not a deflection.");
    lines.push("Name-drop at least ONE specific hook this turn — in your reaction, your opinion, OR the question you ask — unless you are answering an info ask.");
    lines.push(`Priority hooks (pick 1-2, prefer unused): ${suggested.join(" · ")}`);
    if (usedTopicHooks.length > 0) {
      lines.push(`Already used (pick something fresh): ${usedTopicHooks.join(", ")}`);
    }
    lines.push("");
    lines.push("If you end with a question, it MUST reference a specific hook — not a generic how-was-class / what-else / blank status ask.");
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

/** Compact source-routing: first pick by job, then switch if that source misses. No keyword lists. */
function buildSourceSwitchGuidance() {
  return [
    "--- SOURCE SWITCH ---",
    "Pick the ONE source that should hold this. After it returns, if it does not actually answer the ask, call a DIFFERENT source — do not guess, do not pad.",
    "memory / past chats = who they are and what you talked about. web_search = live or public look-up. gmail = their inbox. artifacts = exact saved lists, emails, drafts — never paraphrase those.",
    "If the first source already answered, speak — do not stack extra tools. Same source again only for a tighter query, never a retry of the same lookup.",
  ].join("\n");
}

const TOOL_TRUTH = [
  "--- TOOL TRUTH ---",
  "An action exists only if its tool returned ok. Do not claim you searched, recalled, played, paused, copied, sent mail, or saved something unless that tool actually ran and succeeded. Never pretend to look something up.",
].join("\n");

function buildStaticSystem() {
  const parts = [
    SYSTEM_PROMPT,
    buildMemoryToolGuidance(),
    buildSourceSwitchGuidance(),
    TOOL_TRUTH,
  ];
  const searchGuide = buildSearchToolGuidance();
  if (searchGuide) parts.push(searchGuide);
  parts.push(buildClientToolGuidance({ listOfferDeclined: false, gmailInstalled: false }));
  parts.push(buildArtifactToolGuidance());
  const gmailGuide = buildGmailToolGuidance({ installed: false, connected: false });
  if (gmailGuide) parts.push(gmailGuide);
  const snapshotGuide = buildSnapshotToolGuidance();
  if (snapshotGuide) parts.push(snapshotGuide);
  return parts.join("\n\n");
}

const STATIC_SYSTEM = buildStaticSystem();

function buildFrozenTools() {
  const tools = [
    ...CLIENT_TOOLS,
    ...ARTIFACT_TOOLS,
    ...MEMORY_TOOLS,
    ...PAST_CHAT_TOOLS,
    ...SNAPSHOT_TOOLS,
  ];
  if (searchToolsAvailable()) tools.push(...SEARCH_TOOLS);
  if (gmailToolsAvailable()) tools.push(...GMAIL_TOOLS);
  return tools;
}

const FROZEN_TOOLS = buildFrozenTools();

function buildSessionState(clientHints = {}) {
  const installed = Array.isArray(clientHints.installedApps) && clientHints.installedApps.length
    ? clientHints.installedApps.map((id) => String(id)).filter(Boolean)
    : ["youtube", "artifacts"];
  const gmailInstalled = Boolean(clientHints.gmailInstalled || clientHints.gmailConnected);
  const gmailConnected = Boolean(clientHints.gmailConnected);
  const lines = [
    "--- SESSION STATE ---",
    `Installed apps: ${installed.join(", ")}`,
  ];
  if (gmailToolsAvailable()) {
    lines.push(
      gmailInstalled
        ? "Gmail downloaded: yes — already on the dock. Do not ask to download or call install_app."
        : "Gmail downloaded: no — ask before calling install_app."
    );
    lines.push(`Gmail connected: ${gmailConnected ? "yes" : "no"}.`);
  }
  if (clientHints.listOfferDeclined) {
    lines.push("They recently declined a list offer — do not re-offer unless they ask.");
  }
  const yt = clientHints.lastYouTube;
  if (yt && (yt.status || yt.title)) {
    const title = yt.title ? ` — ${yt.title}` : "";
    lines.push(`Music · YouTube: ${yt.status || "idle"}${title}`);
  }
  if (clientHints.gmailSendPending) {
    lines.push(
      `A Gmail confirm card is showing. Full recipient: ${clientHints.gmailSendTo || "see the card"}.`,
      "Do NOT send yet. Do NOT call gmail_send_email. Say the full address out loud if you have not, and wait for yes or no."
    );
  }
  return lines.join("\n");
}

function buildLiveContext(
  memory,
  context,
  thoughtCache,
  userText = "",
  history = [],
  recentCallbacks = [],
  snapshotCache = null,
  usedTopicHooks = [],
  pastChats = [],
  clientHints = {}
) {
  const dryReplyStreak = countDryReplyStreak(history, userText);
  const topicHooks = snapshotCache?.topicHooks || snapshotCache?.conversationAngles || [];
  const topicActive = isSnapshotTopicActive(snapshotCache, userText, history);
  const suggestedHooks = pickSuggestedTopicHooks(topicHooks, usedTopicHooks, 3);
  const thinkerLead =
    thoughtCache?.suggestions?.[0]
    || thoughtCache?.interjections?.[0]
    || thoughtCache?.memoryBridge
    || (thoughtCache?.confidence >= 0.35 ? thoughtCache?.topic : null)
    || null;
  const hooksEngaged =
    dryReplyStreak < 3
    && (
      (suggestedHooks.length > 0 && (topicActive || Boolean(snapshotCache?.topic)))
      || Boolean(thinkerLead)
    );

  const extra = buildMemoryInstructions(memory, context, userText);
  const pastIndex = buildPastChatIndex(pastChats);
  const artifactIndex = buildArtifactIndex(clientHints.artifacts);
  const rhythm = buildConversationRhythm(userText, history, recentCallbacks, {
    hooksEngaged,
    suggestedHooks: suggestedHooks.length ? suggestedHooks : (thinkerLead ? [thinkerLead] : []),
    dryReplyStreak,
    suggestedTopic: suggestedHooks[0] || thinkerLead || null,
  });
  const engagement = buildMemoryEngagement(memory, {
    userText,
    history,
    recentCallbacks,
    knownTopic: snapshotCache?.topic || null,
    memoryToolsOn: true,
  });
  const hints = buildThoughtHints(thoughtCache, userText, dryReplyStreak);
  const snapshot = buildSnapshotContext(snapshotCache, { usedTopicHooks, dryReplyStreak, userText, history });

  const parts = [extra];
  if (pastIndex) parts.push(pastIndex);
  if (artifactIndex) parts.push(artifactIndex);
  parts.push(buildSessionState(clientHints));
  parts.push(rhythm);
  if (engagement) parts.push(engagement);
  if (hints) parts.push(hints);
  if (snapshot) parts.push(snapshot);
  return parts.join("\n\n");
}

function youtubeSearchIntent(searchQuery = "") {
  return /(?:site:)?youtube\.com|youtu\.be/i.test(String(searchQuery || ""));
}

const GREETING_TASK = `--- GREETING TASK ---
The user just opened the app. They have not spoken yet. Generate ONE short casual spoken greeting — 1 sentence, maybe 2 max.

You have: GENERAL INFO (name, prefs), clock/timezone, and when available a LAST CONVERSATION block (time since last chat + title/summary/topics). Reason from those facts. Do not invent.

How to think (not scripts — invent your own line each time):
1. Read the gap. very_recent / short often feels like a quick return; same_day / overnight can still carry unfinished context; multi_day / long usually wants a fresher hello.
2. Read what last chat was about. Ask yourself: is that situation still plausibly ongoing or worth a light callback given the gap? Mid-activity / unfinished vibe + short gap → you can check in on it. One-off chat, settled topic, or long gap → leave it alone.
3. Optionally blend ONE standing fact (name, vibe from time of day) — never dump a list.
4. Pick ONE angle max: gap feel, last-thread continuity, name/time-of-day, or a soft name ask if unknown. Do not stack them all.

Hard rules:
- Do NOT invent facts missing from GENERAL INFO / LAST CONVERSATION.
- Do NOT loop the same interest every greeting if you have several.
- Do NOT use canned template lines. Any "back so soon / still at the party" vibes are clues about the capability, not phrases to reuse.
- Sound like a real phone call — short, casual, no periods at end. No memory tags. No emojis. no emdashes (--) or dashes (-).
- Do NOT end with a generic question unless it's specific to something you actually know. Prefer leading with their name or a concrete detail when you have one.`;

export async function generateGreeting({ memory, context, thoughtCache, snapshotCache = null, lastChat = null, pastChats = [] }) {
  if (!client) return null;

  const greetingContext = enrichGreetingContext(context, { memory, lastChat });
  // Prefer the continuity chat in the index when present; keep it short for greetings.
  const chatsForIndex = lastChat
    ? [lastChat, ...(Array.isArray(pastChats) ? pastChats : [])].slice(0, 4)
    : (Array.isArray(pastChats) ? pastChats.slice(0, 4) : []);

  const liveContext = buildLiveContext(
    memory,
    greetingContext,
    thoughtCache,
    "",
    [],
    [],
    snapshotCache,
    [],
    chatsForIndex,
    {}
  );

  const response = await client.chat.completions.create({
    ...chatModelOptions(config.openaiModel, { temperature: config.mainTemperature }),
    prompt_cache_key: "june-greeting",
    messages: [
      { role: "system", content: STATIC_SYSTEM },
      { role: "system", content: `${liveContext}\n\n${GREETING_TASK}` },
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

export async function* streamSnapshotFollowup({ history = [], memory, context, snapshotCache = null, usedTopicHooks = [], signal, onUsage = null } = {}) {
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
      stream_options: { include_usage: true },
    },
    { signal }
  );

  let roundUsage = null;
  for await (const chunk of stream) {
    if (signal?.aborted) break;
    if (chunk.usage) roundUsage = chunk.usage;
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
  const normalizedUsage = normalizeChatUsage(roundUsage);
  if (normalizedUsage) {
    try {
      onUsage?.({
        agent: "followup",
        model: config.followupModel,
        usage: normalizedUsage,
      });
    } catch {}
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
  /\b(?:ok(?:ay)?\s+)?(?:lemm?e?(?:\s+see|\s+look|\s+check|\s+hop)?|uhh?,?\s*(?:okay\s+)?I'?ll\s+(?:check|look)|wait(?:\s+wait)?|hang\s+on|one\s+sec|one\s+moment|give\s+me\s+(?:a\s+sec|one\s+more\s+sec)|let\s+me\s+(?:see|remember|check|look|think|find|connect)|still\s+looking|still\s+searching|still\s+pulling|still\s+on\s+it|almost\s+(?:got\s+it|there)|pulling\s+(?:that|it)\s+up|looking\s+(?:it|that)\s+up|searching|checking\s+now|connecting(?:\s+to\s+check)?|what\s+was\s+that|where\s+is\s+that|what\s+did\s+we\s+talk\s+about|it'?s\s+in\s+here\s+somewhere|mm+|mhm+|yeah+|alright)\b/gi;

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

function isSearchToolName(name) {
  return name === "web_search";
}

function isGmailToolName(name) {
  return String(name || "").startsWith("gmail_");
}

function isClientActionToolName(name) {
  return isClientToolName(name);
}

function describeUsedSources(toolNames = []) {
  const used = [];
  if (toolNames.some(isRecallToolName)) used.push("memory/past chats");
  if (toolNames.some(isSearchToolName)) used.push("web_search");
  if (toolNames.some(isGmailToolName)) used.push("gmail");
  if (toolNames.some(isArtifactToolName)) used.push("artifacts");
  return used;
}

/** Immediate searching-out-loud lines when web_search kicks with empty Phase A. */
const SEARCH_OPEN_BEATS = [
  "okay let me connect and check real quick… ",
  "one sec, pulling that up… ",
  "hold on, let me look that up… ",
  "lemme check that real quick… ",
  "okay hang on, searching… ",
  "wait, I'll look that up… ",
  "mm, let me find that… ",
  "give me a sec, looking it up… ",
  "alright, connecting to check… ",
  "one moment, pulling it up… ",
  "okay I got you, looking now… ",
  "hang on I'll find out… ",
  "lemme hop on that real quick… ",
  "wait wait, searching… ",
  "okay checking now… ",
];

/** Second beat if Tavily is still in flight (~1.5–3s after the open). */
const SEARCH_MID_BEATS = [
  "still looking… ",
  "almost got it… ",
  "give me one more sec… ",
  "mhm, still pulling it… ",
  "hang on it's loading… ",
  "yeah still searching… ",
  "one more beat… ",
  "almost there… ",
  "still on it… ",
  "okay almost… ",
];

/** Soft beats while list/clipboard tools run. */
const CLIENT_OPEN_BEATS = [
  "okay one sec… ",
  "yeah I got you… ",
  "mm, on it… ",
  "alright… ",
  "sure… ",
];

const YOUTUBE_OPEN_BEATS = [
  "okay putting that on… ",
  "one sec, queuing it up… ",
  "alright, loading that track… ",
  "hang on, starting it… ",
  "mm, playing that now… ",
];

const YOUTUBE_PAUSE_BEATS = [
  "okay pausing it… ",
  "one sec, holding that… ",
  "alright, pausing… ",
];

const YOUTUBE_STOP_BEATS = [
  "okay turning that off… ",
  "one sec, stopping it… ",
  "alright, killing that… ",
];

const YOUTUBE_RESUME_BEATS = [
  "okay putting it back on… ",
  "one sec, resuming… ",
  "alright, starting that again… ",
];

const GMAIL_OPEN_BEATS = [
  "okay let me check your mail real quick… ",
  "one sec, pulling up your inbox… ",
  "hang on, looking at your email… ",
  "lemme hop into gmail… ",
];

/** Short soft-bridge for non-recall tools (snapshot hooks, etc.). */
const SHORT_TOOL_BEATS = [
  "mm ",
  "yeah ",
];

/** Spoken when a round stalls before Phase A ever said anything real. */
const STALL_FALLBACK_OPEN = [
  "hey, sorry, having trouble connecting right now — try me again in a sec?",
  "hm, my connection's being slow — say that again in a bit?",
  "ugh, that's stuck on my end — mind trying that again?",
];

/** Spoken when a round stalls after Phase A / tools already ran. */
const STALL_FALLBACK_CONTINUE = [
  "sorry, that's taking way too long on my end — try asking again in a sec?",
  "hm, that got stuck pulling it together — mind trying that again?",
  "ugh, lost the connection there — ask me again in a bit?",
];

function toolNamesFromAcc(toolAcc) {
  return Object.values(toolAcc || {})
    .map((tc) => tc.function?.name || "")
    .filter(Boolean);
}

function youtubeActionFromAcc(toolAcc) {
  for (const tc of Object.values(toolAcc || {})) {
    if ((tc.function?.name || "") !== "youtube_player_tool") continue;
    const raw = String(tc.function?.arguments || "");
    const m = raw.match(/"action"\s*:\s*"(pause|resume|stop|play)"/i);
    if (m) return m[1].toLowerCase();
    try {
      const args = JSON.parse(raw || "{}");
      const action = String(args.action || "play").toLowerCase();
      if (action === "pause" || action === "resume" || action === "stop" || action === "play") {
        return action;
      }
    } catch {}
    return "play";
  }
  return "";
}

function buildStepContinueMessage({
  phaseAText,
  toolNames = [],
  snapshotCache = null,
  thoughtCache = null,
  usedTopicHooks = [],
  searchSources = [],
  searchQuery = "",
  listOfferDeclined = false,
  musicPlayRequested = false,
  youtubeAction = "",
}) {
  const usedSources = describeUsedSources(toolNames);
  const retrievalTurn = usedSources.length > 0;
  const lines = [
    "--- STEP CONTINUE ---",
    "You already started speaking. Tool results are in the messages above.",
    `You already said: "${String(phaseAText || "").trim().slice(0, 220)}"`,
    "Do NOT restart, re-greet, re-ack, or restate what you already said.",
    retrievalTurn
      ? "If those results answer the ask: add ONE short continuation mid-thought (1 sentence, 2 max)."
      : "Add ONE short continuation that segues naturally from that line. Start mid-thought. 1 short sentence, 2 max.",
    "Keep June's spoken voice. No memory tags, no emojis.",
  ];
  if (toolNames.length) {
    lines.push(`Tools just returned: ${toolNames.join(", ")}`);
  }
  if (retrievalTurn) {
    lines.push(
      `Already used: ${usedSources.join(", ")}.`,
      "If those results do NOT answer the ask, do not invent. Speak a short pivot if needed and call a DIFFERENT source (memory / past chats vs web_search vs gmail). Same source again only for a tighter query.",
    );
  }

  if (toolNames.includes("install_app")) {
    lines.push("");
    lines.push("--- APP INSTALL CONTINUE ---");
    lines.push("Gmail is on their dock. If the tool said already_installed, do not talk about downloading. If they still need to connect, tell them a connect tab opened (or Settings → Connect Gmail). Casual. Do not read a long URL. If already connected, continue with gmail_agent if you have not yet.");
  }

  if (toolNames.includes("youtube_player_tool")) {
    const action = youtubeAction || "play";
    lines.push("");
    lines.push("--- YOUTUBE CONTINUE ---");
    if (action === "pause") {
      lines.push("If youtube_player_tool returned ok, casually confirm you paused it. If nothing_playing, say nothing is on. Do not start a new search.");
    } else if (action === "stop") {
      lines.push("If youtube_player_tool returned ok, casually confirm you stopped it. If nothing_playing, say nothing is on. Do not start a new search.");
    } else if (action === "resume") {
      lines.push("If youtube_player_tool returned ok, casually confirm it's back on. If nothing_playing, say nothing is on.");
    } else {
      lines.push("If youtube_player_tool returned ok, casually confirm it's playing on the Music · YouTube card (if replaced, say you switched it). Do not read the URL. If no_video, say you still need a track and search or ask — never claim it is playing.");
    }
  }

  if (toolNames.some(isGmailToolName)) {
    lines.push("");
    lines.push("--- GMAIL CONTINUE ---");
    lines.push("Use the real tool results only. If gmail_agent returned spoken_summary and it answers the ask, say that (your voice, not a robot dump). Do not invent extra mail. The on-screen stack will shuffle to the matching email — do not tell them to download Gmail. If not_connected, tell them to connect. If a send returned ok, confirm it went out. If need_confirm_send, say the FULL recipient email address out loud and wait — a confirm card is on screen. Do not claim you sent. If mail is empty or unrelated to what they asked, switch source instead of guessing.");
  }

  if (toolNames.some(isArtifactToolName)) {
    lines.push("");
    lines.push("--- ARTIFACT CONTINUE ---");
    if (toolNames.includes("get_artifact")) {
      lines.push("If get_artifact returned a body, that text is the document. Speak or use it VERBATIM. Do not rephrase, summarize, or polish. If not_found, say you do not have that saved — do not invent it.");
    } else if (toolNames.includes("save_artifact")) {
      lines.push("If save_artifact returned ok, confirm briefly that it is in Artifacts. Do not read the whole thing back unless they asked.");
    } else {
      lines.push("Use the artifact tool results. Titles are labels only.");
    }
  }

  if (toolNames.some(isSearchToolName)) {
    const ytInResults = searchResultsHaveYouTube(searchSources);
    const ytPlayed = toolNames.includes("youtube_player_tool");

    if (musicPlayRequested || ytPlayed) {
      lines.push("");
      lines.push("--- MUSIC / YOUTUBE SEARCH CONTINUE ---");
      if (ytPlayed) {
        lines.push("Playback started on Music · YouTube. Confirm casually — name the track if results gave you one. Do NOT read URLs or dump search snippets.");
      } else if (ytInResults) {
        lines.push("Search returned YouTube links but playback has not started — you MUST call youtube_player_tool with the best url before speaking.");
      } else {
        lines.push("No YouTube link in results. Say you could not find it on YouTube — offer another search. Never claim it is playing.");
      }
    } else {
      const domains = [...new Set(
        (searchSources || []).map((s) => s.domain || s.title).filter(Boolean)
      )];
      const offerList = shouldOfferNoteList({
        sources: searchSources,
        query: searchQuery,
        declinedRecently: listOfferDeclined,
      });
      lines.push("");
      lines.push("--- WEB SEARCH CONTINUE (grounded only) ---");
      if (domains.length) {
        lines.push("Results are in. If they answer the ask, open with a natural found-it beat — vary it: \"okay here's what I found\", \"got it\", \"alright so\", \"okay so\". Do not reuse the same opener every time.");
        lines.push("ONLY state facts present in the returned results. NEVER invent sources, sites, numbers, or news.");
        lines.push(`You may namedrop a source ONLY if it is in this list: ${domains.join(", ")}.`);
        lines.push("If the hits are unrelated to the ask, switch source — do not force a fake answer from them.");
      } else {
        lines.push("No usable sources came back. Do not invent. Switch source if another tool could have this; otherwise say you couldn't find it.");
      }
      lines.push("Do not read URLs aloud. Do not dump snippets. Speak like a friend who just looked it up.");
      if (offerList) {
        lines.push("These look like multi-item keepable recs — you MAY end with ONE soft list offer once (e.g. \"want me to make a clean list of these so you can keep track?\") — do not stack questions. Skip if it feels unnatural.");
      } else {
        lines.push("Do NOT offer a clean/keepable list this turn — not multi-item keepable recs, or they recently declined. Just deliver the answer.");
      }
      lines.push("Interactive source tiles also appear under your reply; don't narrate the UI.");
    }
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
 * Main reply stream with bounded tool loop + in-turn step mode.
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
  onUsage = null,
  onToolsStarted = null,
  awaitEnrichment = null,
  getLiveSnapshot = null,
  getLiveThought = null,
  onSearchSources = null,
  clientHints = {},
  getClientToolContext = null,
  artifacts = null,
  promptCacheKey = "",
}) {
  if (!client) {
    yield "I'm not fully wired up yet, but I heard you say: " + userText;
    return;
  }

  let liveSnapshot = snapshotCache;
  let liveThought = thoughtCache;

  const liveContext = buildLiveContext(
    memory,
    context,
    liveThought,
    userText,
    history,
    recentCallbacks,
    liveSnapshot,
    usedTopicHooks,
    pastChats,
    clientHints
  );

  const dryReplyStreak = countDryReplyStreak(history, userText);
  const temperature = dryReplyStreak >= 2
    ? Math.min(config.mainTemperature + 0.12, 0.9)
    : config.mainTemperature;

  const messages = [
    { role: "system", content: STATIC_SYSTEM },
    ...history,
    { role: "user", content: userText },
    { role: "system", content: liveContext },
  ];
  const stepMode = config.stepModeEnabled !== false;
  const availableTools = FROZEN_TOOLS;
  let phaseASpoken = "";
  let toolsKickSent = false;
  let softBridgeYielded = false;
  let midBeatYielded = false;
  let softBridgeAt = 0;
  let lastOpenBeat = "";

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) return;

    const allowTools = round < MAX_TOOL_ROUNDS;
    const toolChoice = allowTools ? "auto" : "none";

    // Per-round watchdog: this LLM call (especially the post-tool "step_continue"
    // round) must not hang the turn forever if the provider stalls. Any chunk
    // (content or tool_call delta) resets the idle clock; silence for
    // mainRoundIdleTimeoutMs aborts just this round.
    const roundController = new AbortController();
    let stalled = false;
    let idleTimer = null;
    const armIdleWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        stalled = true;
        roundController.abort();
      }, config.mainRoundIdleTimeoutMs || 12000);
    };
    const onOuterAbort = () => roundController.abort();
    if (signal) {
      if (signal.aborted) roundController.abort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    const clearRoundWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (signal) signal.removeEventListener("abort", onOuterAbort);
    };

    const toolAcc = {};
    let finishReason = null;
    let contentBuf = "";
    let roundUsage = null;

    try {
      armIdleWatchdog();
      const stream = await client.chat.completions.create(
        {
          ...chatModelOptions(config.openaiModel, {
            temperature,
            // Soft variety — reduce verbatim phrase loops without word bans
            frequencyPenalty: 0.35,
            presencePenalty: 0.15,
          }),
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
          tools: availableTools,
          tool_choice: toolChoice,
        },
        { signal: roundController.signal }
      );

      for await (const chunk of stream) {
        armIdleWatchdog();
        if (signal?.aborted) { clearRoundWatchdog(); return; }
        if (chunk.usage) roundUsage = chunk.usage;
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
              const searchingNow = names.some(isSearchToolName);
              const gmailNow = names.some(isGmailToolName);
              const youtubeNow = names.includes("youtube_player_tool");
              const youtubeActionNow = youtubeNow ? youtubeActionFromAcc(toolAcc) : "";
              const clientNow = names.some(isClientActionToolName);
              const open = recallingNow
                ? pickRecallBeat(RECALL_OPEN_BEATS, lastOpenBeat)
                : searchingNow
                  ? pickRecallBeat(SEARCH_OPEN_BEATS, lastOpenBeat)
                  : gmailNow
                    ? pickRecallBeat(GMAIL_OPEN_BEATS, lastOpenBeat)
                  : youtubeActionNow === "pause"
                    ? pickRecallBeat(YOUTUBE_PAUSE_BEATS, lastOpenBeat)
                  : youtubeActionNow === "stop"
                    ? pickRecallBeat(YOUTUBE_STOP_BEATS, lastOpenBeat)
                  : youtubeActionNow === "resume"
                    ? pickRecallBeat(YOUTUBE_RESUME_BEATS, lastOpenBeat)
                  : youtubeNow
                    ? pickRecallBeat(YOUTUBE_OPEN_BEATS, lastOpenBeat)
                  : clientNow
                    ? pickRecallBeat(CLIENT_OPEN_BEATS, lastOpenBeat)
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
    } catch (err) {
      clearRoundWatchdog();
      if (signal?.aborted) return;
      const isAbort = err?.name === "AbortError" || err?.name === "APIUserAbortError";
      if (!isAbort) {
        console.error("[llm] round failed:", err?.message || err);
      }
      const spokeAlready = hasRealPhaseASpeech(phaseASpoken) || softBridgeYielded;
      const fallback = spokeAlready
        ? pickRecallBeat(STALL_FALLBACK_CONTINUE)
        : pickRecallBeat(STALL_FALLBACK_OPEN);
      const needsSpace = phaseASpoken && !/\s$/.test(phaseASpoken);
      try {
        onTrace?.({
          agent: "main",
          phase: "error",
          name: stalled ? "round_stalled" : "round_error",
          detail: { round, hadSpeech: spokeAlready, message: String(err?.message || err).slice(0, 200) },
        });
      } catch {}
      yield (spokeAlready && needsSpace ? " " : "") + fallback;
      return;
    }
    clearRoundWatchdog();

    const normalizedUsage = normalizeChatUsage(roundUsage);
    if (normalizedUsage) {
      try {
        onUsage?.({
          agent: "main",
          model: config.openaiModel,
          usage: normalizedUsage,
        });
      } catch {}
    }

    const toolCalls = Object.keys(toolAcc)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => toolAcc[k])
      .filter((tc) => tc.function?.name);

    // Prefer executing any assembled tool calls (streaming sometimes reports finish_reason
    // as "stop" even when tool_calls arrived). Only bail when there are none.
    if (!allowTools || toolCalls.length === 0) {
      return;
    }
    if (finishReason && finishReason !== "tool_calls" && finishReason !== "stop") {
      console.warn(`[tool] unexpected finish_reason=${finishReason} with ${toolCalls.length} tool call(s)`);
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
    const searchSources = [];
    const dispatched = [];

    for (const tc of toolCalls) {
      const name = tc.function?.name || "";
      toolNames.push(name);
      const argsRaw = tc.function?.arguments || "";
      let args = argsRaw;
      try { args = JSON.parse(argsRaw); } catch {}

      dispatched.push((async () => {
        let result;
        if (name === "web_search") {
          result = await runWebSearchTool(tc, { userText });
        } else if (name === "gmail_agent") {
          const ctx = typeof getClientToolContext === "function"
            ? (getClientToolContext() || {})
            : {};
          result = await runGmailAgent(tc, {
            ...ctx,
            userText,
            history,
            signal,
            onUsage,
            onTrace,
          });
        } else if (isGmailToolName(name)) {
          const ctx = typeof getClientToolContext === "function"
            ? (getClientToolContext() || {})
            : {};
          result = await runGmailTool(tc, ctx);
        } else if (isClientToolName(name)) {
          const ctx = typeof getClientToolContext === "function"
            ? (getClientToolContext() || {})
            : {};
          result = await runClientTool(tc, ctx);
        } else if (isArtifactToolName(name)) {
          const ctx = typeof getClientToolContext === "function"
            ? (getClientToolContext() || {})
            : {};
          const store = ctx.artifacts || artifacts;
          result = runArtifactTool(store, tc, {
            lastNote: ctx.lastNote,
            lastBrainstorm: ctx.lastBrainstorm,
            lastMail: ctx.lastMail,
            onSave: ctx.onArtifactSave,
            onOpen: ctx.onArtifactOpen,
          });
        } else if (name === "check_snapshot_hooks") {
          result = runSnapshotTool(liveSnapshot, tc, { userText, history, usedTopicHooks });
        } else {
          result = runMemoryTool(memory, tc, { pastChats });
        }
        return { tc, name, args, argsRaw, result };
      })());
    }

    const searching = toolNames.some(isSearchToolName);
    const gmailing = toolNames.includes("gmail_agent") || toolNames.some(isGmailToolName);
    const recalling = toolNames.some(isRecallToolName);
    const toolsPromise = Promise.all(dispatched);

    if (searching) {
      onTrace?.({
        agent: "main",
        phase: "tool",
        name: "web_search",
        detail: { status: "searching" },
      });
    }
    if (gmailing) {
      onTrace?.({
        agent: "main",
        phase: "tool",
        name: "gmail_agent",
        detail: { status: "searching" },
      });
    }

    // Mid-search beat WHILE Tavily / mail agent is still in flight (opening beat already spoken).
    if (
      stepMode
      && (searching || gmailing)
      && softBridgeYielded
      && !midBeatYielded
      && !hasRealPhaseASpeech(phaseASpoken)
      && !signal?.aborted
    ) {
      const targetMs = RECALL_MID_DELAY_MIN_MS
        + Math.floor(Math.random() * RECALL_MID_DELAY_SPAN_MS);
      const elapsed = softBridgeAt ? Date.now() - softBridgeAt : 0;
      const waitMs = Math.max(0, targetMs - elapsed);
      const raced = await Promise.race([
        toolsPromise.then(() => "done"),
        sleepMs(waitMs, signal).then(() => (signal?.aborted ? "abort" : "mid")),
      ]);
      if (raced === "mid" && !midBeatYielded && !signal?.aborted) {
        midBeatYielded = true;
        const mid = pickRecallBeat(SEARCH_MID_BEATS);
        phaseASpoken += mid;
        yield mid;
        onTrace?.({
          agent: "main",
          phase: "tool",
          name: "search_mid_beat",
          detail: { beat: mid.trim(), afterMs: Date.now() - softBridgeAt },
        });
        await sleepMs(RECALL_MID_GAP_MS, signal);
      }
    }

    const finished = await toolsPromise;
    let searchQuery = "";
    let youtubeAction = "";
    for (const { tc, name, args, argsRaw, result } of finished) {
      console.log(`[tool] ${name}`, argsRaw.slice?.(0, 80) || "");
      const sources = name === "web_search" ? extractSearchSources(result.content) : [];
      if (sources.length) {
        searchSources.push(...sources);
        try {
          let query = "";
          if (args && typeof args === "object") query = String(args.query || "");
          if (query) searchQuery = query;
          onSearchSources?.({ sources, query, result: result.content });
        } catch {}
      }
      if (name === "youtube_player_tool") {
        let parsed = {};
        try { parsed = JSON.parse(result.content || "{}"); } catch {}
        youtubeAction = String(parsed.action || args?.action || "play").toLowerCase();
      }
      let mailExtra = {};
      if (name === "gmail_agent" || isGmailToolName(name)) {
        try {
          const parsed = JSON.parse(result.content || "{}");
          if (Array.isArray(parsed.highlights) && parsed.highlights.length) {
            mailExtra.highlights = parsed.highlights;
          }
          if (Array.isArray(parsed.messages) && parsed.messages.length) {
            mailExtra.messages = parsed.messages;
          }
          if (parsed.id) mailExtra.focusId = parsed.id;
          else if (Array.isArray(parsed.highlights) && parsed.highlights[0]?.id) {
            mailExtra.focusId = String(parsed.highlights[0].id);
          }
          if (parsed.focusId) mailExtra.focusId = String(parsed.focusId);
          if (parsed.action) mailExtra.action = parsed.action;
        } catch {}
      }
      onTrace?.({
        agent: "main",
        phase: "tool",
        name,
        detail: {
          args,
          result: result.content,
          ...(sources.length ? { sources } : {}),
          ...mailExtra,
        },
      });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result.content,
      });
    }

    // Chain web_search → youtube_player_tool when the model already searched YouTube.
    const modelCalledYouTube = toolNames.includes("youtube_player_tool");
    const musicPlayRequested = youtubeSearchIntent(searchQuery);
    if (
      searching
      && musicPlayRequested
      && !modelCalledYouTube
      && searchResultsHaveYouTube(searchSources)
    ) {
      const autoTc = buildYouTubePlayFromSearch(searchSources);
      if (autoTc) {
        autoTc.id = autoTc.id || `auto_yt_${Date.now()}`;
        const ctx = typeof getClientToolContext === "function"
          ? (getClientToolContext() || {})
          : {};
        const ytResult = await runClientTool(autoTc, ctx);
        toolNames.push("youtube_player_tool");
        const lastAssistant = messages[messages.length - 1];
        if (lastAssistant?.role === "assistant") {
          lastAssistant.tool_calls = [...(lastAssistant.tool_calls || []), autoTc];
        }
        let ytArgs = {};
        try { ytArgs = JSON.parse(autoTc.function.arguments || "{}"); } catch {}
        onTrace?.({
          agent: "main",
          phase: "tool",
          name: "youtube_player_tool",
          detail: {
            args: ytArgs,
            result: ytResult.content,
            autoFromSearch: true,
          },
        });
        messages.push({
          role: "tool",
          tool_call_id: autoTc.id,
          content: ytResult.content,
        });
        youtubeAction = "play";
      }
    }

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
      && !searching
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
          searchSources,
          searchQuery,
          listOfferDeclined: Boolean(clientHints.listOfferDeclined),
          musicPlayRequested: youtubeSearchIntent(searchQuery),
          youtubeAction,
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
          searchDomains: searchSources.map((s) => s.domain).filter(Boolean),
        },
      });
    }
    // Loop continues — next round may explore further or speak Phase B continuation
  }
}
