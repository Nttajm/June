import { formatNoteList } from "./list-format.js";
import {
  parseYouTubeId,
  youtubeThumb,
  youtubeWatchUrl,
  pickYouTubeFromSources,
} from "./youtube-utils.js";

export const CLIENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "create_note_list",
      description:
        "Create a clean keepable bullet list from the latest search / recommendations and show it under the chat. Call when the user agrees to a list, or asks you to make/save a list of the spots you just found. Do not invent items — uses recent search results unless items are provided.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Optional list title, e.g. Best spots to eat in LA",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "install_app",
      description:
        "Install Gmail onto June's on-screen dock. Call ONLY after they agree to download it, and ONLY if Gmail is not already downloaded. If the prompt says Gmail is already downloaded, never call this.",
      parameters: {
        type: "object",
        properties: {
          app_id: {
            type: "string",
            enum: ["gmail"],
            description: "Virtual app to install. Currently only gmail.",
          },
        },
        required: ["app_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "copy_to_clipboard",
      description:
        "Put text on the user's device clipboard. Call when they ask to copy something, put a restaurant/link/list on their clipboard, or say copy that. Prefer copying the latest note list if they mean the list; otherwise pass the exact text (name + URL). Never claim you copied unless you call this tool.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "Exact text to copy. If omitted, copies the latest note list or last search links.",
          },
          label: {
            type: "string",
            description: "Short label for feedback, e.g. restaurant, list, link",
          },
          what: {
            type: "string",
            enum: ["list", "last_source", "custom"],
            description: "What to copy when text is empty. Default: list if available, else last sources.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "youtube_player_tool",
      description:
        "Control background YouTube audio on the Music · YouTube card. action play: start or REPLACE the current track (pass url/video_id; if you only have a song name, web_search site:youtube.com first). action pause: pause current audio. action resume: unpause current audio. action stop: stop and clear. Call pause/resume/stop with no URL when they already have something on. Never claim you paused/stopped/played unless this tool returns ok.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["play", "pause", "resume", "stop"],
            description: "play (default, also replaces whatever is on), pause, resume, or stop.",
          },
          video_id: {
            type: "string",
            description: "YouTube video id, if you already have it. Required for play unless last search/track has one.",
          },
          url: {
            type: "string",
            description: "Full YouTube URL (watch, youtu.be, embed, shorts).",
          },
          title: {
            type: "string",
            description: "Optional display title for the music card.",
          },
        },
      },
    },
  },
];

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function sourcesToPlain(sources = [], query = "") {
  const lines = [];
  if (query) lines.push(query);
  for (const s of sources) {
    const title = s.title || s.domain || "Item";
    const url = s.url || "";
    lines.push(url ? `${title}\n${url}` : title);
  }
  return lines.join("\n\n").trim();
}

export function isClientToolName(name) {
  return name === "create_note_list"
    || name === "copy_to_clipboard"
    || name === "install_app"
    || name === "youtube_player_tool";
}

/**
 * @returns {"list"|"clipboard"|null}
 */
export function detectClientToolIntent(userText = "", { listOfferPending = false } = {}) {
  const t = String(userText || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return null;

  if (
    /\b(clipboard|clip\s*board|copy\s+(that|this|it|the|those|them)|put\s+(that|this|it|those|them|the)\b.{0,40}\b(clipboard|clip\s*board)|save\s+to\s+(my\s+)?clipboard)\b/.test(t)
  ) {
    return "clipboard";
  }

  if (
    /\b(make\s+(me\s+)?(a\s+)?(nice\s+|clean\s+)?list|create\s+(me\s+)?(a\s+)?list|turn\s+(that|those|them|this)\s+into\s+a\s+list|keep\s+(track|a\s+list)|list\s+(of\s+)?(them|those|these|the\s+spots|the\s+restaurants))\b/.test(t)
  ) {
    return "list";
  }

  // Short yes after June offered a list
  if (
    listOfferPending
    && /^(yeah|yep|yes|sure|ok|okay|please|do\s+it|go\s+ahead|sounds\s+good|that'd\s+be\s+great|that\s+would\s+be\s+great)\b/.test(t)
    && t.length < 56
  ) {
    return "list";
  }

  return null;
}

/**
 * @returns {"gmail"|null}
 */
export function detectInstallAppIntent(userText = "", { gmailInstallOfferPending = false } = {}) {
  const t = String(userText || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return null;

  if (/\b(download|install|get|add)\b.{0,24}\b(gmail|the\s+gmail\s+app|e-?mail\s+app)\b/.test(t)) {
    return "gmail";
  }

  if (
    gmailInstallOfferPending
    && /^(yeah|yep|yes|sure|ok|okay|please|do\s+it|go\s+ahead|sounds\s+good|alright|yea|yup)\b/.test(t)
    && t.length < 56
  ) {
    return "gmail";
  }

  return null;
}

/**
 * Pause / resume / stop current YouTube audio (no search).
 * @returns {"pause"|"resume"|"stop"|null}
 */
export function detectYouTubeControlIntent(userText = "", { lastYouTube = null } = {}) {
  const t = String(userText || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return null;

  const hasTrack = Boolean(lastYouTube?.videoId || lastYouTube?.url);
  const started = /^(playing|paused|stopped)$/.test(String(lastYouTube?.status || ""));
  const namesANewTrack = /\b(play|put\s+on|queue)\b.{0,40}\b[a-z0-9]/.test(t)
    && !/^(play|put\s+on)\s+(it|that|this)\b/.test(t);

  if (namesANewTrack && !/\b(pause|stop|resume|unpause)\b/.test(t)) return null;

  const mentionsAudio = /\b(music|song|track|video|youtube|audio|playback|playing)\b/.test(t);

  if (
    /^(stop|stop\s+(it|that|this)|turn\s+(it\s+)?off|shut\s+(it\s+)?off)$/.test(t)
    || /\b(stop|turn\s+off|shut\s+off|kill)\b.{0,28}\b(music|song|track|video|youtube|audio|playback|playing)\b/.test(t)
    || /\b(stop\s+(the\s+)?(music|song|track|video|playback|audio))\b/.test(t)
  ) {
    if (hasTrack || mentionsAudio) return "stop";
  }

  if (
    /^(pause|pause\s+(it|that|this))$/.test(t)
    || /\bpause\b.{0,28}\b(music|song|track|video|youtube|audio|that|it|this|playback)\b/.test(t)
    || /\b(pause\s+(the\s+)?(music|song|track|video|playback|audio))\b/.test(t)
  ) {
    if (hasTrack || mentionsAudio) return "pause";
  }

  if (
    /^(resume|unpause|un-pause|continue|keep\s+going|keep\s+playing|play\s+again|start\s+again)$/.test(t)
    || /\b(resume|unpause|un-pause|continue\s+playing|keep\s+playing)\b/.test(t)
  ) {
    if (hasTrack || mentionsAudio) return "resume";
  }

  if (
    started
    && lastYouTube?.status === "paused"
    && /^(play|play\s+(it|that|this)|start\s+(it|that)|put\s+it\s+back\s+on)$/.test(t)
  ) {
    return "resume";
  }

  return null;
}

/**
 * Play an already-resolved YouTube link (no search needed).
 * @returns {boolean}
 */
export function detectYouTubePlayOnlyIntent(userText = "", { lastYouTube = null } = {}) {
  if (detectYouTubeControlIntent(userText, { lastYouTube })) return false;
  const t = String(userText || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;

  const hasLink = Boolean(
    lastYouTube?.videoId
    || lastYouTube?.url
    || parseYouTubeId(t)
  );

  if (
    hasLink
    && /\b(play|put\s+on|queue|start)\b.{0,20}\b(that|it|this|the\s+video|the\s+track|the\s+one)\b/.test(t)
  ) {
    return true;
  }

  if (parseYouTubeId(t) && /\b(play|put\s+on)\b/.test(t)) return true;

  return false;
}

export function buildExplicitYouTubeControlNudge(action) {
  const verb = action === "pause" ? "pause" : action === "stop" ? "stop" : "resume";
  return [
    `--- YOUTUBE ${verb.toUpperCase()} (MANDATORY THIS TURN) ---`,
    `The user wants you to ${verb} the current Music · YouTube audio.`,
    `You MUST call youtube_player_tool this turn with action "${verb}". Do not search. Do not start a new video.`,
    `Never claim you ${verb}d it unless the tool returned ok. If nothing_playing, say nothing is on.`,
  ].join("\n");
}

export function buildExplicitYouTubePlayNudge({ needsSearch = true } = {}) {
  if (needsSearch) {
    return [
      "--- YOUTUBE PLAY (MANDATORY THIS TURN) ---",
      "The user wants music or a video PLAYING on the Music · YouTube card.",
      "If something is already playing, this REPLACES it.",
      "You MUST call web_search first (site:youtube.com + song/artist) unless you already have a YouTube url from this turn.",
      "When search returns YouTube links, call youtube_player_tool with action play and the best url — the system may auto-play for you.",
      "Never claim it is playing unless youtube_player_tool returned ok.",
      "Speak a short beat WITH the tool call(s).",
    ].join("\n");
  }
  return [
    "--- YOUTUBE PLAY (MANDATORY THIS TURN) ---",
    "The user wants that YouTube track playing. You MUST call youtube_player_tool this turn with action play and the known url/video_id.",
    "If something else is already on, this replaces it. Do not search again unless the tool returns no_video.",
    "Never claim it is playing unless the tool returned ok.",
  ].join("\n");
}

export function detectInstallOfferDecline(userText = "", { gmailInstallOfferPending = false } = {}) {
  if (!gmailInstallOfferPending) return false;
  const t = String(userText || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t || t.length > 64) return false;
  return /^(no|nah|nope|no\s+thanks|no\s+thank\s+you|i'?m\s+good|im\s+good|all\s+good|not\s+now|don'?t|dont|skip|never\s+mind|nvm)\b/.test(t);
}

/** Short no / not now after a list offer — do not re-offer immediately. */
export function detectListOfferDecline(userText = "", { listOfferPending = false } = {}) {
  if (!listOfferPending) return false;
  const t = String(userText || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t || t.length > 64) return false;
  return /^(no|nah|nope|no\s+thanks|no\s+thank\s+you|i'?m\s+good|im\s+good|all\s+good|not\s+now|don'?t|dont|skip|never\s+mind|nvm)\b/.test(t);
}

export function buildClientToolGuidance({ listOfferDeclined = false, gmailInstalled = false } = {}) {
  const lines = [
    "--- CLIENT TOOLS (list + clipboard + apps) ---",
    "create_note_list: builds a neat bullet list from your latest web_search results and shows it under the chat. Call when they want a list, or say yes after you offered one.",
    "copy_to_clipboard: actually puts text on their phone/computer clipboard. Call when they ask to copy / put something on their clipboard. Never fake it.",
    gmailInstalled
      ? "install_app: Gmail is already downloaded. Do not call install_app. Do not mention downloading or installing Gmail."
      : "install_app: installs a virtual app on June's screen. Currently gmail. Call ONLY after they agree to download it, and ONLY if Gmail is not already downloaded. Never silent-install. Never re-download.",
    "youtube_player_tool: controls Music · YouTube audio. action play starts or REPLACES the current track (url/video_id; search site:youtube.com first if you only have a song name). action pause / resume / stop the current audio with no URL. REQUIRED after a music play request + web_search when results include YouTube. Never claim play/pause/stop unless this tool returns ok.",
    "LIST OFFERS (rare — do not nag):",
    "- Soft-offer a keepable list ONLY after multi-item recommendations they might want to keep (several restaurants, spots, events) — once, when it feels natural.",
    "- NEVER offer a list for single facts, timezones, weather, scores, hours, or one-off look-ups.",
    "- If they already declined or ignored a list offer, do NOT re-offer this turn or the next few.",
    "- If they did not ask and the search was not multi-item recs → skip the list offer entirely.",
    "If they say yes / make a list → call create_note_list (do not invent items).",
    "After a list exists (or they ask): softly offer clipboard once — \"want me to put that on your clipboard?\" — then call copy_to_clipboard only if they agree or ask.",
    "copy_to_clipboard actually writes their device clipboard. Never pretend you copied.",
    gmailInstalled
      ? "List/clipboard: one of those per turn is enough."
      : "List/clipboard: one of those per turn is enough. install_app can share a turn with a later gmail_* call after they agreed.",
    "youtube_player_tool can share a turn with web_search for a NEW track: search first, then play (replaces whatever is on). Pause / resume / stop do NOT search — call the tool with that action only.",
    "Speak a short beat with the tool call, then confirm after it lands.",
  ];
  if (listOfferDeclined) {
    lines.push("They recently declined a list offer — do NOT offer a list again unless they ask.");
  }
  return lines.join("\n");
}

export function buildExplicitClientToolNudge(kind) {
  if (kind === "list") {
    return [
      "--- CREATE LIST (MANDATORY THIS TURN) ---",
      "The user wants a keepable list. You MUST call create_note_list this turn.",
      "Do not invent spots — the tool uses the latest search results. Speak a short yes-beat WITH the tool call.",
    ].join("\n");
  }
  if (kind === "clipboard") {
    return [
      "--- CLIPBOARD (MANDATORY THIS TURN) ---",
      "The user wants something on their clipboard. You MUST call copy_to_clipboard this turn.",
      "Prefer what:\"list\" if a list was just made, or pass text with the restaurant name + URL. Never claim you copied without calling the tool.",
    ].join("\n");
  }
  if (kind === "install_gmail") {
    return [
      "--- INSTALL GMAIL (MANDATORY THIS TURN) ---",
      "The user agreed to download the Gmail app. You MUST call install_app this turn with app_id \"gmail\".",
      "Then proceed: if not connected, tell them to connect; if connected, you may call gmail_* next.",
      "Speak a short yes-beat WITH the tool call. Casual, like a friend.",
    ].join("\n");
  }
  if (kind === "youtube_play") {
    return buildExplicitYouTubePlayNudge({ needsSearch: true });
  }
  if (kind === "youtube_play_only") {
    return buildExplicitYouTubePlayNudge({ needsSearch: false });
  }
  if (kind === "youtube_pause") {
    return buildExplicitYouTubeControlNudge("pause");
  }
  if (kind === "youtube_resume") {
    return buildExplicitYouTubeControlNudge("resume");
  }
  if (kind === "youtube_stop") {
    return buildExplicitYouTubeControlNudge("stop");
  }
  return "";
}

/**
 * @param {object} toolCall
 * @param {{
 *   lastSearch?: { sources?: array, query?: string, spoken?: string },
 *   lastNote?: { title?: string, markdown?: string },
 *   onClipboard?: (text: string, label?: string) => void,
 *   onNoteList?: (note: { title: string, markdown: string }) => void,
 *   onAppInstall?: (info: { appId: string }) => void,
 *   lastYouTube?: { videoId?: string, url?: string, title?: string, status?: string },
 *   onYouTubePlay?: (info: { videoId: string, title: string, thumbnail: string, replaced?: boolean }) => void,
 *   onYouTubeControl?: (info: { action: "pause"|"resume"|"stop", videoId?: string, title?: string }) => void,
 * }} ctx
 */
export async function runClientTool(toolCall, ctx = {}) {
  const name = toolCall?.function?.name || toolCall?.name || "";
  const args = parseArgs(toolCall?.function?.arguments ?? toolCall?.arguments);
  const wrap = (payload) => ({
    tool_call_id: toolCall?.id || "",
    name,
    content: JSON.stringify(payload),
  });

  if (name === "create_note_list") {
    const search = ctx.lastSearch || {};
    const items = (search.sources || []).map((s) => ({
      title: s.title,
      url: s.url,
      domain: s.domain,
      snippet: s.snippet,
    }));
    if (!items.length) {
      return wrap({
        ok: false,
        error: "no_recent_search",
        detail: "No recent search results to turn into a list. Search first.",
      });
    }
    const formatted = await formatNoteList({
      title: args.title || "",
      query: search.query || "",
      spoken: search.spoken || "",
      items,
    });
    try {
      ctx.onNoteList?.({
        title: formatted.title,
        markdown: formatted.markdown,
      });
    } catch {}
    return wrap({
      ok: true,
      title: formatted.title,
      itemCount: items.length,
      hint: "List is on screen and saved to Artifacts exactly. You can offer to copy it to their clipboard next.",
    });
  }

  if (name === "copy_to_clipboard") {
    const what = args.what || "custom";
    let text = String(args.text || "").trim();
    let label = String(args.label || "").trim();

    if (!text) {
      if (what === "list" || (!args.what && ctx.lastNote?.markdown)) {
        text = String(ctx.lastNote?.markdown || "").trim();
        label = label || "list";
      } else if (what === "last_source" && ctx.lastSearch?.sources?.length) {
        const s = ctx.lastSearch.sources[0];
        text = [s.title, s.url].filter(Boolean).join("\n");
        label = label || s.title || "link";
      } else if (ctx.lastNote?.markdown) {
        text = String(ctx.lastNote.markdown).trim();
        label = label || "list";
      } else if (ctx.lastSearch?.sources?.length) {
        text = sourcesToPlain(ctx.lastSearch.sources, ctx.lastSearch.query);
        label = label || "sources";
      }
    }

    if (!text) {
      return wrap({
        ok: false,
        error: "nothing_to_copy",
        detail: "No text, list, or search results available to copy.",
      });
    }

    // Cap clipboard payload
    if (text.length > 12000) text = text.slice(0, 12000);

    try {
      ctx.onClipboard?.(text, label || "clipboard");
    } catch {}

    return wrap({
      ok: true,
      chars: text.length,
      label: label || "clipboard",
      preview: text.slice(0, 120),
    });
  }

  if (name === "install_app") {
    const appId = String(args.app_id || args.appId || "").trim().toLowerCase();
    if (appId !== "gmail") {
      return wrap({
        ok: false,
        error: "unsupported_app",
        detail: "Currently only gmail is supported.",
      });
    }
    const already = Boolean(ctx.gmailInstalled || ctx.gmailConnected);
    const connected = Boolean(ctx.gmailConnected);
    if (already) {
      return wrap({
        ok: true,
        appId,
        already_installed: true,
        connected,
        hint: "Gmail is already downloaded. Do NOT ask to download again. Use gmail_agent if they asked about mail.",
      });
    }
    try {
      ctx.onAppInstall?.({ appId });
    } catch {}
    return wrap({
      ok: true,
      appId,
      connected,
      hint: connected
        ? "Gmail app is on screen and already connected. Continue with gmail_agent if they asked about mail."
        : "Gmail app is on screen. If not connected, tell them to connect — a connect tab should open.",
    });
  }

  if (name === "youtube_player_tool") {
    let action = String(args.action || args.command || "play").toLowerCase().trim();
    if (action === "unpause" || action === "continue" || action === "un-pause") action = "resume";
    if (action === "replace" || action === "start" || action === "queue") action = "play";
    if (!["play", "pause", "resume", "stop"].includes(action)) action = "play";

    const fromArgs = parseYouTubeId(args.video_id) || parseYouTubeId(args.url);
    const fromLast = parseYouTubeId(ctx.lastYouTube?.videoId || ctx.lastYouTube?.url || "");
    const fromSearch = pickYouTubeFromSources(ctx.lastSearch?.sources);

    if (action === "pause" || action === "resume" || action === "stop") {
      const videoId = fromLast || fromArgs || fromSearch?.videoId || "";
      const title = String(ctx.lastYouTube?.title || args.title || fromSearch?.title || "").trim().slice(0, 140);
      if (!videoId && action !== "stop") {
        return wrap({
          ok: false,
          action,
          error: "nothing_playing",
          detail: `Nothing is on the Music card to ${action}.`,
        });
      }
      try {
        ctx.onYouTubeControl?.({ action, videoId, title });
      } catch {}
      const hints = {
        pause: "Paused on Music · YouTube card",
        resume: "Resumed on Music · YouTube card",
        stop: "Stopped Music · YouTube audio",
      };
      return wrap({
        ok: true,
        action,
        videoId,
        title,
        hint: hints[action],
      });
    }

    const videoId = fromArgs || fromSearch?.videoId || fromLast || "";
    if (!videoId) {
      return wrap({
        ok: false,
        action: "play",
        error: "no_video",
        detail: "No YouTube video id or url. Search site:youtube.com first, then call again with the URL.",
      });
    }
    const replaced = Boolean(fromLast && fromLast !== videoId);
    const title = String(
      args.title
      || (fromSearch?.videoId === videoId ? fromSearch.title : "")
      || (!replaced ? ctx.lastYouTube?.title : "")
      || fromSearch?.title
      || ""
    ).trim().slice(0, 140);
    const thumbnail = youtubeThumb(videoId);
    try {
      ctx.onYouTubePlay?.({ videoId, title, thumbnail, replaced });
    } catch {}
    return wrap({
      ok: true,
      action: "play",
      replaced,
      videoId,
      title,
      url: youtubeWatchUrl(videoId),
      hint: replaced
        ? "Replaced track on Music · YouTube card"
        : "Playing on Music · YouTube card",
    });
  }

  return wrap({ error: `Unknown client tool: ${name}` });
}
