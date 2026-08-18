import {
  listArtifacts,
  getArtifact,
  upsertArtifact,
  buildArtifactIndex,
  normalizeKind,
} from "./artifact-store.js";

export { buildArtifactIndex };

export const ARTIFACT_TOOLS = [
  {
    type: "function",
    function: {
      name: "save_artifact",
      description:
        "Keep exact wording in the Artifacts app. Call when they ask to remember/keep/save an email, a named list, a drafted message, or any text they will want back word-for-word. Pass the EXACT body — do not rewrite, tidy, or summarize. Lists and formatted brainstorm drafts are often saved automatically; still call this when they ask to keep something that is not already stored.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short label, e.g. Saturday spots, Email to Sam.",
          },
          body: {
            type: "string",
            description: "Exact text to store. Required unless a recent list, draft, or email is already in context.",
          },
          kind: {
            type: "string",
            enum: ["list", "email", "note", "draft"],
            description: "What this is. Default note.",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_artifacts",
      description:
        "Step 1 of exact recall. Titles and kinds of saved artifacts. Use when they ask what you saved, or before get_artifact if the ARTIFACTS index is empty. Do not recite this list as the document.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max titles to return (default 12, max 24).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_artifact",
      description:
        "Step 2 of exact recall. Fetch ONE saved artifact by title or id and return its body VERBATIM. Call when they want a saved list, email, draft, or exact wording back. After it returns, speak or paste that body as stored — never rephrase.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title from the ARTIFACTS index or list_artifacts." },
          id: { type: "string", description: "Artifact id if you have it." },
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

export function isArtifactToolName(name) {
  return name === "save_artifact" || name === "list_artifacts" || name === "get_artifact";
}

function fallbackBody(args, ctx = {}) {
  const direct = String(args.body || args.text || args.markdown || "").trim();
  if (direct) return direct;
  const kind = normalizeKind(args.kind);
  if (kind === "list" && ctx.lastNote?.markdown) return String(ctx.lastNote.markdown);
  if (kind === "email" && ctx.lastMail?.body) return String(ctx.lastMail.body);
  if (ctx.lastBrainstorm?.body) return String(ctx.lastBrainstorm.body);
  if (ctx.lastNote?.markdown) return String(ctx.lastNote.markdown);
  if (ctx.lastMail?.body) return String(ctx.lastMail.body);
  return "";
}

function fallbackTitle(args, ctx = {}, kind) {
  const direct = String(args.title || "").trim();
  if (direct) return direct;
  if (kind === "list" && ctx.lastNote?.title) return ctx.lastNote.title;
  if (kind === "email" && ctx.lastMail?.title) return ctx.lastMail.title;
  if (ctx.lastBrainstorm?.title) return ctx.lastBrainstorm.title;
  if (ctx.lastNote?.title) return ctx.lastNote.title;
  return "Untitled";
}

export function runArtifactTool(store, toolCall, ctx = {}) {
  const name = toolCall?.function?.name || toolCall?.name || "";
  const args = parseArgs(toolCall?.function?.arguments ?? toolCall?.arguments);
  const wrap = (payload) => ({
    tool_call_id: toolCall?.id || "",
    name,
    content: JSON.stringify(payload),
  });

  if (name === "list_artifacts") {
    return wrap({
      ok: true,
      items: listArtifacts(store, args.limit ?? 12),
    });
  }

  if (name === "get_artifact") {
    const hit = getArtifact(store, { id: args.id || "", title: args.title || "" });
    if (hit.error) {
      return wrap({
        ok: false,
        error: hit.error,
        available: hit.available,
        hint: "Nothing matched. Do not invent the document.",
      });
    }
    try { ctx.onOpen?.({ id: hit.id }); } catch {}
    return wrap({
      ok: true,
      id: hit.id,
      kind: hit.kind,
      title: hit.title,
      body: hit.body,
      hint: "This is the stored text. Use it verbatim. Do not rephrase.",
    });
  }

  if (name === "save_artifact") {
    const kind = normalizeKind(args.kind || (ctx.lastMail?.body && !args.body ? "email" : "") || ctx.lastBrainstorm?.kind || (ctx.lastNote?.markdown ? "list" : "note"));
    const body = fallbackBody(args, ctx);
    const title = fallbackTitle(args, ctx, kind);
    if (!body) {
      return wrap({
        ok: false,
        error: "empty_body",
        detail: "Pass the exact text, or save after a list / draft / email exists.",
      });
    }
    const result = upsertArtifact(store, {
      title,
      body,
      kind,
      source: "save_artifact",
    });
    if (!result.item) {
      return wrap({ ok: false, error: result.error || "save_failed" });
    }
    try { ctx.onSave?.(result); } catch {}
    return wrap({
      ok: true,
      id: result.item.id,
      kind: result.item.kind,
      title: result.item.title,
      updated: Boolean(result.updated),
      hint: "Saved to Artifacts exactly. Confirm briefly. Do not read the whole thing back unless they asked.",
    });
  }

  return wrap({ error: `Unknown artifact tool: ${name}` });
}

export function buildArtifactToolGuidance() {
  return [
    "--- ARTIFACTS (exact documents) ---",
    "Artifacts hold keepable text word-for-word: lists, emails, formatted drafts. Not casual chat. Not memory facts about who they are.",
    "save_artifact: keep exact wording when they ask to remember/keep an email, named list, or draft. Pass the body unchanged.",
    "list_artifacts / get_artifact: when they want a saved list, email, or draft back. get_artifact returns the stored body. Speak or use that body VERBATIM — do not rephrase, summarize, or polish.",
    "Lists from create_note_list and formatted brainstorm drafts are usually saved for you. Still call save_artifact if they ask to keep something else exact.",
    "Titles in the ARTIFACTS index are labels only. Never treat a title as the document.",
  ].join("\n");
}
