import { config } from "./states.js";
import { getLlmClient } from "./llm-client.js";
import { chatModelOptions } from "./model-options.js";
import { normalizeChatUsage } from "./usage.js";

const client = getLlmClient();

const ACTIONS = new Set([
  "enter",
  "content",
  "exit",
  "format",
  "tweak",
  "copy",
  "speak",
  "done",
  "null",
]);

const CLASSIFY_PROMPT = `You are June's dictation-mode classifier. You never talk to the user. You only return JSON.

June is a spoken conversation. Almost every utterance is just talking to June. Brainstorm/dictation is a separate session MODE that must be turned on with an explicit command to the app — not inferred from topic, rambling, or wanting help writing.

## PHASES
- off: normal conversation. Default action is ALWAYS null.
- capturing: already in dictation. Detect more dump content vs an explicit stop.
- wrapup: they already stopped. They were asked to tweak, format, copy, hear it, or finish.

## ACTIONS
- enter — ONLY in phase off, and ONLY if they are explicitly commanding the dictation/brainstorm MODE on (a session switch: start capturing speech with no June reply). If the same utterance also contains dump content after the command, put that in remainder.
- content — phase capturing/wrapup: more dump material or format prefs. Never use in phase off.
- exit — capturing: they are clearly commanding the mode off / that they are done dumping. Thinking pauses are not exit.
- format / tweak / copy / speak / done — wrapup only, from meaning.
- null — everything else. Phase off: this is the default.

## remainder
Dump-worthy speech with the mode-command wording removed. Empty string if the utterance was only the command.

## formatHint
Tone / artifact kind / audience / extra if they said it. Null if unknown. Do not invent.

## PHASE OFF — enter is rare
Return enter only when they are addressing the MODE itself: they want the no-reply capture session to start now.

NOT enter (return null) even if they:
- are chatting, asking, answering, joking, thinking out loud for June to respond
- want June to write, draft, compose, or word something in a normal turn
- mention email, notes, ideas, lists, or "let me think"
- pause, trail off, say wait/hold on, or STT is noise/partial
- never mentioned turning a dictation/brainstorm/dump MODE on

When unsure, null. modeCommand must be true to enter.

## OUTPUT — ONLY JSON
{
  "action": "enter" | "content" | "exit" | "format" | "tweak" | "copy" | "speak" | "done" | null,
  "modeCommand": boolean,
  "remainder": string,
  "formatHint": { "tone": string|null, "kind": string|null, "audience": string|null, "extra": string|null }
}`;

const FORMAT_PROMPT = `You turn messy spoken dictation into clean writing the user can copy.

You receive a raw speech dump plus optional hints (tone, kind, audience, extra). Infer the artifact from the dump — email, message, note, list, outline, or other. Honor hints when present; otherwise pick a natural fit.

## RULES
- Coherent written English. Fix grammar, fillers, and rambling. Keep the user's meaning. Do not invent facts, names, or commitments they did not say.
- If it is an email (or they asked for one): title is the subject line; body is the email; clipboardText is paste-ready (Subject line + blank line + body). Include greeting/signoff only when the dump implies them.
- Otherwise: title is a short label; body is the full piece; clipboardText is what should hit the clipboard (usually the body, or title + body when a heading helps).
- Tone: use the requested tone when given; otherwise match the dump (don't make a casual rant into a legal letter).
- Output ONLY JSON:
{
  "kind": string,
  "title": string,
  "body": string,
  "clipboardText": string
}`;

export function brainstormAgentAvailable() {
  return Boolean(client) && config.brainstormEnabled !== false;
}

function extractChatText(response) {
  return String(response?.choices?.[0]?.message?.content || "").trim();
}

function parseJsonObject(text) {
  const raw = (text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
  }
  return null;
}

function cleanHint(raw) {
  if (!raw || typeof raw !== "object") {
    return { tone: null, kind: null, audience: null, extra: null };
  }
  const str = (v) => {
    const s = String(v || "").trim();
    if (!s || s.toLowerCase() === "null") return null;
    return s.slice(0, 240);
  };
  return {
    tone: str(raw.tone),
    kind: str(raw.kind),
    audience: str(raw.audience),
    extra: str(raw.extra),
  };
}

export function mergeFormatHint(prev, next) {
  const a = cleanHint(prev);
  const b = cleanHint(next);
  const extra = [a.extra, b.extra].filter(Boolean).join(" ").trim();
  return {
    tone: b.tone || a.tone,
    kind: b.kind || a.kind,
    audience: b.audience || a.audience,
    extra: extra || null,
  };
}

export function hintIsClear(hint) {
  const h = cleanHint(hint);
  return Boolean(h.kind || h.tone || h.audience);
}

function normalizeAction(value) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "null" || key === "") return null;
  return ACTIONS.has(key) ? key : null;
}

function normalizeClassify(parsed, { text = "", phase = "off" } = {}) {
  if (!parsed || typeof parsed !== "object") {
    return { action: null, remainder: "", formatHint: cleanHint(null) };
  }
  let action = normalizeAction(parsed.action ?? parsed.function);
  const modeCommand = parsed.modeCommand === true;
  if (phase === "off") {
    action = action === "enter" && modeCommand ? "enter" : null;
  } else if (action === "enter" && phase !== "off") {
    action = "content";
  }
  let remainder = parsed.remainder;
  if (remainder == null) remainder = action === "content" ? text : "";
  remainder = String(remainder || "").trim();
  return {
    action,
    remainder,
    formatHint: cleanHint(parsed.formatHint || parsed.hint),
  };
}

export async function classifyBrainstormTurn({
  text,
  phase = "off",
  dump = "",
  hint = null,
  signal = null,
  onUsage = null,
} = {}) {
  if (!brainstormAgentAvailable()) return { action: null, remainder: "", formatHint: cleanHint(null) };

  const response = await client.chat.completions.create(
    {
      ...chatModelOptions(config.memoryAiModel, { maxTokens: 140, temperature: 0.1 }),
      messages: [
        { role: "system", content: CLASSIFY_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            phase,
            userMessage: text,
            dumpSoFar: String(dump || "").slice(-4000),
            knownHint: cleanHint(hint),
          }),
        },
      ],
    },
    { signal },
  );

  const usage = normalizeChatUsage(response.usage);
  if (usage) {
    try {
      onUsage?.({ agent: "brainstorm", model: config.memoryAiModel, usage });
    } catch {}
  }

  return normalizeClassify(parseJsonObject(extractChatText(response)), { text, phase });
}

export async function formatBrainstormDump({
  dump,
  hint = null,
  signal = null,
  onUsage = null,
} = {}) {
  if (!brainstormAgentAvailable()) return null;
  const raw = String(dump || "").trim();
  if (!raw) return null;

  const response = await client.chat.completions.create(
    {
      ...chatModelOptions(config.memoryAiModel, { maxTokens: 1200, temperature: 0.3 }),
      messages: [
        { role: "system", content: FORMAT_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            dump: raw.slice(0, 12000),
            hint: cleanHint(hint),
          }),
        },
      ],
    },
    { signal },
  );

  const usage = normalizeChatUsage(response.usage);
  if (usage) {
    try {
      onUsage?.({ agent: "brainstorm", model: config.memoryAiModel, usage });
    } catch {}
  }

  const parsed = parseJsonObject(extractChatText(response));
  if (!parsed || typeof parsed !== "object") return null;
  const title = String(parsed.title || "").trim().slice(0, 160) || "Draft";
  const body = String(parsed.body || "").trim();
  if (!body) return null;
  const clipboardText = String(parsed.clipboardText || "").trim() || body;
  const kind = String(parsed.kind || "note").trim().slice(0, 40) || "note";
  return { kind, title, body, clipboardText };
}
