import { config } from "./states.js";

const TAVILY_URL = "https://api.tavily.com/search";
const SNIPPET_MAX = 280;
const CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 8000;

/** @type {Map<string, { at: number, payload: object }>} */
const searchCache = new Map();

export const SEARCH_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "REQUIRED for live look-ups. Call this tool — do NOT pretend to search or invent results. Use for best restaurants/food spots, bars, cafes, things to do, events, hours, weather, news, scores, prices, source-backed quiz/test/course/syllabus/policy/docs/requirements answers, and any city/local recommendation that needs current info. Also call this after memory or gmail returns nothing useful for a public/live ask. Skip when they are clearly just chatting, want a made-up example, or already asked you to wait. One web_search unless a different source already missed.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Short search query, as you would type into a search box.",
          },
          max_results: {
            type: "number",
            description: "How many results to return (1-5, default 4).",
          },
        },
        required: ["query"],
      },
    },
  },
];

export function searchToolsAvailable() {
  return Boolean(config.webSearchEnabled && config.tavilyApiKey);
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function trimSnippet(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= SNIPPET_MAX) return t;
  return `${t.slice(0, SNIPPET_MAX - 1).trim()}…`;
}

function normalizeQuery(query) {
  return String(query || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function cacheKey(query, maxResults, depth) {
  return `${normalizeQuery(query)}|${maxResults}|${depth}`;
}

function cacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return hit.payload;
}

function cacheSet(key, payload) {
  searchCache.set(key, { at: Date.now(), payload });
  if (searchCache.size > 80) {
    const oldest = searchCache.keys().next().value;
    if (oldest) searchCache.delete(oldest);
  }
}

function trimResults(rawResults, maxResults) {
  const list = Array.isArray(rawResults) ? rawResults : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const url = String(item?.url || "").trim();
    const domain = hostnameFromUrl(url) || String(item?.domain || "").trim();
    if (!url && !domain) continue;
    const key = domain || url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: String(item?.title || domain || url).slice(0, 140),
      url,
      domain,
      snippet: trimSnippet(item?.content || item?.snippet || ""),
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

export function extractSearchSources(resultContent) {
  try {
    const parsed = typeof resultContent === "string" ? JSON.parse(resultContent) : resultContent;
    const list = parsed?.results || parsed?.sources || [];
    if (!Array.isArray(list)) return [];
    return list
      .map((s) => ({
        title: String(s?.title || "").slice(0, 140),
        url: String(s?.url || ""),
        domain: String(s?.domain || hostnameFromUrl(s?.url || "")),
        snippet: String(s?.snippet || "").slice(0, 160),
      }))
      .filter((s) => s.url || s.domain);
  } catch {
    return [];
  }
}

/**
 * Async Tavily dispatcher. Returns a JSON-serializable result string for tool messages.
 * @param {object} toolCall
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function runWebSearchTool(toolCall, { fetchImpl, userText } = {}) {
  const name = toolCall?.function?.name || toolCall?.name || "web_search";
  const args = parseArgs(toolCall?.function?.arguments ?? toolCall?.arguments);
  let query = String(args.query || args.q || "").trim();
  query = normalizeYouTubeSearchQuery(query, userText || "");
  const maxResults = Math.min(
    5,
    Math.max(1, Number(args.max_results) || config.webSearchMaxResults || 4)
  );
  const depth = config.webSearchDepth || "basic";

  const wrap = (payload) => ({
    tool_call_id: toolCall?.id || "",
    name,
    content: JSON.stringify(payload),
  });

  if (!searchToolsAvailable()) {
    return wrap({ error: "web_search is not configured", results: [] });
  }
  if (!query) {
    return wrap({ error: "query is required", results: [] });
  }

  const key = cacheKey(query, maxResults, depth);
  const cached = cacheGet(key);
  if (cached) {
    return wrap({ ...cached, cached: true });
  }

  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const res = await doFetch(TAVILY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.tavilyApiKey}`,
      },
      body: JSON.stringify({
        api_key: config.tavilyApiKey,
        query,
        search_depth: depth,
        max_results: maxResults,
        include_answer: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return wrap({
        error: `tavily_http_${res.status}`,
        detail: String(errText).slice(0, 180),
        results: [],
      });
    }

    const data = await res.json();
    const payload = {
      query,
      results: trimResults(data?.results, maxResults),
    };
    cacheSet(key, payload);
    return wrap(payload);
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return wrap({
      error: aborted ? "tavily_timeout" : "tavily_failed",
      detail: aborted ? "search timed out" : String(err?.message || err).slice(0, 180),
      results: [],
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect when the user wants a live web look-up (not memory recall).
 * Used to force tool_choice → web_search so the model can't bluff.
 * @returns {boolean}
 */
/**
 * User wants a song/video played (YouTube), not a generic web look-up.
 * @returns {boolean}
 */
export function detectYouTubePlayIntent(userText = "") {
  const t = String(userText || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;

  // Pause / stop / resume — not a new search
  if (
    (/^(pause|unpause|resume|stop)\b/.test(t) && t.length < 48)
    || (
      /\b(pause|stop|resume|unpause|turn\s+off|shut\s+off)\b.{0,24}\b(music|song|track|video|audio|youtube|playback)\b/.test(t)
      && !/\b(play|put\s+on)\s+\w{3,}/.test(t)
    )
  ) {
    return false;
  }

  // "play that/it" needs a resolved link — handled by detectYouTubePlayOnlyIntent
  if (/^(play|put\s+on|queue|start)\s+(that|it|this)\b/.test(t) && t.length < 32) {
    return false;
  }

  if (
    /\b(change|switch|swap|replace)\b.{0,40}\b(song|track|music|video|it|this)\b/.test(t)
    || /\b(play|put\s+on)\s+(something\s+else|a\s+different|another)\b/.test(t)
    || (/\binstead\b/.test(t) && /\b(play|put\s+on|change|switch)\b/.test(t))
  ) {
    return true;
  }

  if (
    /\b(play|put\s+on|queue|start|listen\s+to|hear|spin|throw\s+on)\b.{0,48}\b(song|music|track|video|youtube|video\s+on\s+youtube|something)\b/.test(t)
    || /\b(play\s+(me\s+)?(a\s+)?(song|music|track|video|something))\b/.test(t)
    || /\b(put\s+(on|this\s+on)|queue\s+up|start\s+playing)\b/.test(t)
  ) {
    return true;
  }

  if (
    /\bplay\b/.test(t)
    && /\b(youtube|music|song|track|artist|album|playlist|radio)\b/.test(t)
  ) {
    return true;
  }

  // "play [artist/song name]" — short requests with a play verb
  if (
    /\bplay\b/.test(t)
    && !/\b(play\s+(a\s+)?(game|movie|film|podcast|trailer|clip\s+from|role|part|devil|dumb|along|hard|fair|safe|it\s+by\s+ear|possum|down|up|off|with|for|against))\b/.test(t)
    && t.length < 120
  ) {
    return true;
  }

  return false;
}

/** Prefer YouTube-hosted results when resolving a play request. */
export function normalizeYouTubeSearchQuery(query, userText = "") {
  const q = String(query || userText || "").trim();
  if (!q) return q;
  if (/site:\s*youtube/i.test(q) || /youtube\.com/i.test(q)) return q;
  const u = String(userText || "").toLowerCase();
  if (detectYouTubePlayIntent(u) || /\b(youtube|song|music|track|artist|album|playlist)\b/.test(u)) {
    return `${q} site:youtube.com`;
  }
  return q;
}

export function buildYouTubePlaySearchNudge() {
  if (!searchToolsAvailable()) return "";
  return [
    "--- YOUTUBE PLAY (MANDATORY TOOL CHAIN THIS TURN) ---",
    "The user wants music or a YouTube video PLAYED — not just described.",
    "Round 1: call web_search with a short query (include site:youtube.com when you only have a song/artist name).",
    "When results include a YouTube link, the system auto-starts youtube_player_tool — OR you MUST call youtube_player_tool yourself in the next tool round with action play and the best url/video_id.",
    "If something is already playing, this REPLACES it.",
    "Never claim it is playing unless youtube_player_tool returned ok.",
    "Speak one short beat WITH the search, then confirm casually once playback starts.",
  ].join("\n");
}

export function detectExplicitSearch(userText = "") {
  if (!searchToolsAvailable()) return false;
  const t = String(userText || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;

  // Play music / YouTube — search to resolve, then play (not a restaurant-style look-up)
  if (detectYouTubePlayIntent(t)) return true;

  // Explicit search verbs / look-up asks (not "yes" — that may mean list/clipboard)
  if (
    /\b(look\s+(that|it|this)?\s*up|look\s+up|search|google|find\s+out|check\s+(online|the\s+web|for)|can\s+you\s+(search|look|check|find)|pull\s+up|what'?s\s+the\s+latest)\b/.test(t)
  ) {
    return true;
  }

  // Time / fact look-ups
  if (
    /\b(weather|forecast|score|scores|who\s+won|did\s+.+\s+win|stock\s+price|how\s+much\s+is|open\s+now|opening\s+hours|hours\s+for|showtimes?|tickets?|traffic|delay|delays)\b/.test(t)
  ) {
    return true;
  }

  // Source-backed content: the user wants what an external authority is likely to
  // contain, not just a generic explanation from model knowledge.
  const asksForExternalContent =
    /\b(what(?:'s|\s+is|\s+would\s+be|\s+will\s+be|\s+happens|\s+do(?:es)?\s+.+\s+cover)|what\s+to\s+expect|first|next|sample|example|practice|actual|official|real)\b/.test(t)
    && /\b(on|in|for|from|about)\b/.test(t)
    && /\b(quiz|test|exam|midterm|final|course|class|syllabus|curriculum|assignment|homework|rubric|lesson|unit|module|policy|docs?|documentation|api|requirements?)\b/.test(t);
  if (asksForExternalContent && !/\b(make\s+(one|it)\s+up|invent|pretend|hypothetical|from\s+scratch)\b/.test(t)) {
    return true;
  }

  // Local / city recommendations that need live results (food, places, events)
  const hasPlace =
    /\b(in|near|around|at)\s+[a-z0-9]/.test(t)
    || /\b(sf|san\s+francisco|la|los\s+angeles|nyc|new\s+york|seattle|chicago|austin|miami|oakland|berkeley|mission|brooklyn|manhattan)\b/.test(t);
  const wantsRecs =
    /\b(best|top|good|great|recommend|recommendations?|spots?|places?|restaurants?|food|eat|eats|dinner|lunch|brunch|coffee|cafe|cafes|bars?|clubs?|things\s+to\s+do|what\s+to\s+do|events?|what'?s\s+on|happening)\b/.test(t);

  if (hasPlace && wantsRecs) return true;

  // "this weekend / tonight / today" + activity without waiting for soft offer when place known
  if (
    hasPlace
    && /\b(this\s+weekend|tonight|today|tomorrow|this\s+week)\b/.test(t)
    && /\b(do|go|eat|see|visit|hang|fun|plan|plans)\b/.test(t)
  ) {
    return true;
  }

  return false;
}

export function buildExplicitSearchNudge() {
  if (!searchToolsAvailable()) return "";
  return [
    "--- EXPLICIT WEB SEARCH (MANDATORY THIS TURN) ---",
    "The user wants live or source-backed look-up info. You MUST call web_search this turn — do NOT invent restaurants, spots, scores, events, quiz/test contents, policies, docs, or requirements from memory.",
    "Do NOT say you are searching / checking / looking it up unless you actually call the tool in the same turn.",
    "Speak one short real reaction WITH the tool call, then continue from the real results.",
  ].join("\n");
}

export function buildSearchToolGuidance() {
  if (!searchToolsAvailable()) return "";
  return [
    "--- WEB SEARCH (Tavily — live web) ---",
    "You HAVE a real web_search tool. When a look-up is needed, CALL IT. Never pretend to search. Never invent \"best spots\" lists as if you just looked them up.",
    "",
    "Two different jobs: memory is who THEY are. web_search / your own knowledge is information they want you to TELL them.",
    "Start with the source that should hold this. A matching memory title is NOT a public answer — do not scan_memory to reconstruct one.",
    "If memory or gmail already ran this turn and did not answer, you MAY web_search now instead of giving up.",
    "",
    "SEARCH NOW (same turn — call web_search):",
    "- Play music / YouTube: play [song], put on a track, listen to X, change the song — search site:youtube.com, then youtube_player_tool action play (replaces current audio)",
    "- Explicit: look up / search / google / check / find out / what's the latest",
    "- Best/top/recommend + place: \"best spots to eat in LA\", \"good coffee in SF\", \"restaurants near me in Oakland\"",
    "- Time-sensitive: news, scores, prices, weather, who won",
    "- Concrete local: hours, open now, tickets, showtimes, events this weekend, transit",
    "- Source-backed external content: what is likely/officially on a quiz, test, course week, syllabus, policy, docs page, API, assignment, or requirements list",
    "",
    "ANSWER FROM KNOWLEDGE (no web_search, no memory dig):",
    "- Static facts you actually know (timezones, geography, well-known outlines)",
    "- If the user wants a made-up/example item, make one from knowledge",
    "- If unsure or source-specific → either call web_search now, or say it's a realistic guess and give one soft offer (\"want me to look that up?\") — do not dig memory",
    "",
    "SOFT OFFER (one short \"want me to look that up?\"):",
    "- They want you to provide information and you are not sure — including short follow-ups that mean go-ahead after that ask",
    "- They ask for likely contents of a quiz/test/course/policy/docs/etc. and you choose not to search because they only need a rough example",
    "- \"any ideas?\" / \"what's fun\" with zero place context",
    "- If they already named a city + food/places/events → SEARCH NOW, do not stall with offers.",
    "- If they say yes after a search look-up offer → SEARCH NOW.",
    "- If they say yes after a list offer → create_note_list (not web_search).",
    "",
    "SKIP SEARCH:",
    "- Pure chat, feelings, teasing, memory about THEM (use memory tools instead)",
    "- Static facts you already know",
    "",
    "EXAMPLES:",
    "1. \"best spots to eat in LA\" → SEARCH NOW (web_search).",
    "2. \"look up SF weekend events\" → SEARCH NOW.",
    "3. \"is the Exploratorium open Sunday?\" → SEARCH NOW.",
    "4. \"weather in SF tomorrow\" → SEARCH NOW.",
    "5. \"any cool museums?\" (no city) → soft offer once; if they name a city → SEARCH.",
    "6. \"best coffee in the Mission\" → SEARCH NOW.",
    "7. \"things to do this weekend in SF\" → SEARCH NOW (city + timeframe).",
    "8. \"Giants score\" → SEARCH NOW.",
    "9. \"BART delays?\" → SEARCH NOW.",
    "10. \"what's happening at Chase Center this week\" → SEARCH NOW.",
    "11. \"remind me what we said about SF food\" → memory tools, NOT web_search.",
    "12. \"tell me a fun fact about the Golden Gate\" → answer briefly OR soft offer; not memory.",
    "13. \"what's the timezone in Australia\" → answer from knowledge (multiple zones); soft-offer look-up only if unsure — NOT SEARCH NOW, NOT memory.",
    "14. \"what's the capital of France\" → answer from knowledge; no search.",
    "15. \"what would be the first question on a course quiz?\" → SEARCH NOW unless they clearly ask you to invent a practice question.",
    "16. \"make me a practice quiz question\" → answer from knowledge; no search needed.",
    "17. \"play Bohemian Rhapsody\" / \"put on some Drake\" → web_search (site:youtube.com), then youtube_player_tool action play (replaces whatever is on).",
    "18. \"play that\" after you shared a YouTube link → youtube_player_tool action play only (no search).",
    "19. \"pause the music\" / \"pause that\" → youtube_player_tool action pause (no search).",
    "20. \"stop the song\" / \"turn it off\" → youtube_player_tool action stop (no search).",
    "21. \"resume\" / \"keep playing\" / \"play it\" while paused → youtube_player_tool action resume.",
    "",
    "One web_search unless a different source already missed. Keep the query short and specific (include city + category; for music add site:youtube.com).",
    "STEP MODE: speak a short searching beat WITH the real tool call, then AFTER results land continue with a found-it beat from REAL results only.",
    "NEVER invent sources or spots. Namedrop a source ONLY if that domain is in the returned results.",
    "Never read URLs aloud. Talk like a friend who actually looked it up.",
  ].join("\n");
}
