import { config } from "./states.js";
import { getLlmClient } from "./llm-client.js";
import { chatModelOptions } from "./model-options.js";
import { normalizeChatUsage } from "./usage.js";

const client = getLlmClient();

/**
 * Whether a soft list offer is appropriate after a web search.
 * Only for multi-item keepable recs (restaurants, spots, events) — never for
 * single facts, weather, scores, timezones, one-off look-ups.
 */
export function shouldOfferNoteList({
  sources = [],
  query = "",
  declinedRecently = false,
} = {}) {
  if (declinedRecently) return false;
  const items = (sources || []).filter((s) => s?.url || s?.domain || s?.title);
  if (items.length < 3) return false;

  const q = String(query || "").toLowerCase().replace(/\s+/g, " ").trim();
  // Live facts — never nag a keepable list
  if (
    /\b(weather|forecast|score|scores|who\s+won|stock|price|timezone|time\s*zone|what\s+time|hours|open\s+now|showtimes?|tickets?|traffic|delay|delays)\b/.test(q)
  ) {
    return false;
  }

  // Keepable multi-item recommendations
  return /\b(restaurant|restaurants|food|eat|eats|dinner|lunch|brunch|coffee|cafe|cafes|bar|bars|spot|spots|place|places|hotel|hotels|event|events|things\s+to\s+do|museum|museums|recommend|recommendations?|best|top|good|great)\b/.test(q);
}

/**
 * Build interactive reply cards from web search sources.
 * @param {{ sources?: array, query?: string, spoken?: string, declinedRecently?: boolean }} opts
 */
export function buildSearchReplyCards({
  sources = [],
  query = "",
  spoken = "",
  declinedRecently = false,
} = {}) {
  const tiles = (sources || [])
    .filter((s) => s?.url || s?.domain)
    .slice(0, 6)
    .map((s, i) => ({
      id: `tile_${i}_${String(s.domain || "src").replace(/\W+/g, "").slice(0, 12)}`,
      kind: "source_tile",
      title: String(s.title || s.domain || "Source").slice(0, 100),
      subtitle: String(s.domain || "").replace(/^www\./i, ""),
      url: String(s.url || (s.domain ? `https://${s.domain}` : "")),
      domain: String(s.domain || "").replace(/^www\./i, ""),
      snippet: String(s.snippet || "").slice(0, 160),
    }));

  if (!tiles.length) return [];

  const cards = [
    {
      id: "source_row",
      kind: "source_row",
      title: query ? `Sources for “${String(query).slice(0, 48)}”` : "Sources",
      tiles,
    },
  ];

  if (shouldOfferNoteList({ sources: tiles, query, declinedRecently })) {
    cards.push({
      id: "list_offer",
      kind: "list_offer",
      title: "Want a clean list?",
      body: "I can turn these into a neat keepable list — names, links, short notes.",
      action: "format_list",
      actionLabel: "Create list",
      payload: {
        query: query || "",
        spoken: String(spoken || "").slice(0, 600),
        items: tiles.map((t) => ({
          title: t.title,
          url: t.url,
          domain: t.domain,
          snippet: t.snippet,
        })),
      },
    });
  }

  return cards;
}

/**
 * Separate cheap formatter — ChatGPT-style bullet list from search tiles.
 */
export async function formatNoteList({ title = "", items = [], spoken = "", query = "" } = {}) {
  if (!client) {
    return fallbackList({ title, items, query });
  }

  const model = config.followupModel || "gpt-4o-mini";
  const itemLines = (items || [])
    .slice(0, 8)
    .map((it, i) => `${i + 1}. ${it.title || "Item"}${it.domain ? ` (${it.domain})` : ""}${it.url ? `\n   ${it.url}` : ""}${it.snippet ? `\n   note: ${String(it.snippet).slice(0, 120)}` : ""}`)
    .join("\n");

  const response = await client.chat.completions.create({
    ...chatModelOptions(model, { temperature: 0.4, maxTokens: 700 }),
    messages: [
      {
        role: "system",
        content: [
          "You format keepable note lists for a voice assistant named June.",
          "Return ONLY a clean markdown note — no preamble.",
          "Structure:",
          "- A short title line as # Heading",
          "- One short intro sentence",
          "- Bullet list (- item) with bold name, optional one-line note, and the URL on its own line indented or in parentheses",
          "- Keep it scannable and useful. No emojis. No fluff.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          title ? `Preferred title: ${title}` : "",
          query ? `Search query: ${query}` : "",
          spoken ? `June said: ${spoken}` : "",
          "Items:",
          itemLines || "(none)",
        ].filter(Boolean).join("\n"),
      },
    ],
  });

  const markdown = response.choices[0]?.message?.content?.trim() || "";
  const usage = normalizeChatUsage(response.usage);
  if (!markdown) return { ...fallbackList({ title, items, query }), usage };

  return {
    title: extractMdTitle(markdown) || title || query || "Saved list",
    markdown,
    usage,
    model,
  };
}

function extractMdTitle(md) {
  const m = String(md || "").match(/^#\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 80) : "";
}

function fallbackList({ title, items, query }) {
  const heading = title || query || "Saved list";
  const bullets = (items || [])
    .map((it) => {
      const name = it.title || it.domain || "Item";
      const link = it.url ? `\n  ${it.url}` : "";
      const note = it.snippet ? `\n  ${String(it.snippet).slice(0, 100)}` : "";
      return `- **${name}**${note}${link}`;
    })
    .join("\n");
  const markdown = `# ${heading}\n\nQuick list from June's search:\n\n${bullets || "- (no items)"}`;
  return { title: heading, markdown, usage: null, model: null };
}
