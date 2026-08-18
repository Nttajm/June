import { generateId, memoryNow } from "./memory-store.js";

export const ARTIFACT_SCHEMA_VERSION = 1;
export const MAX_ARTIFACTS = 80;
export const MAX_ARTIFACT_BODY = 12000;

const KINDS = new Set(["list", "email", "note", "draft"]);

export function createEmptyArtifacts() {
  return { version: ARTIFACT_SCHEMA_VERSION, items: [] };
}

export function normalizeKind(raw) {
  const s = String(raw || "").toLowerCase().trim();
  if (s === "email" || s === "mail") return "email";
  if (s === "list") return "list";
  if (s === "draft") return "draft";
  if (s === "message" || s === "note" || s === "outline") return "note";
  return KINDS.has(s) ? s : "note";
}

function clipTitle(raw) {
  const t = String(raw || "").replace(/\s+/g, " ").trim();
  return (t || "Untitled").slice(0, 120);
}

function clipBody(raw) {
  return String(raw || "").trim().slice(0, MAX_ARTIFACT_BODY);
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const body = clipBody(raw.body ?? raw.markdown ?? raw.text ?? raw.clipboardText);
  if (!body) return null;
  const createdAt = String(raw.createdAt || raw.timestamp || memoryNow());
  return {
    id: String(raw.id || generateId()),
    kind: normalizeKind(raw.kind),
    title: clipTitle(raw.title),
    body,
    source: String(raw.source || "save_artifact").slice(0, 40),
    createdAt,
    updatedAt: String(raw.updatedAt || createdAt),
  };
}

export function normalizeArtifacts(raw) {
  if (!raw || typeof raw !== "object") return createEmptyArtifacts();
  const list = Array.isArray(raw.items) ? raw.items : (Array.isArray(raw) ? raw : []);
  const items = [];
  const seen = new Set();
  for (const row of list) {
    const item = normalizeItem(row);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  items.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  return {
    version: ARTIFACT_SCHEMA_VERSION,
    items: items.slice(0, MAX_ARTIFACTS),
  };
}

export function listArtifacts(store, limit = 24) {
  const items = normalizeArtifacts(store).items;
  const n = Math.max(1, Math.min(40, Number(limit) || 24));
  return items.slice(0, n).map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    updatedAt: item.updatedAt,
    chars: item.body.length,
  }));
}

export function getArtifact(store, { id = "", title = "" } = {}) {
  const items = normalizeArtifacts(store).items;
  const wantId = String(id || "").trim();
  if (wantId) {
    const hit = items.find((item) => item.id === wantId);
    if (hit) return { ...hit };
  }
  const wantTitle = String(title || "").trim().toLowerCase();
  if (wantTitle) {
    const exact = items.find((item) => item.title.toLowerCase() === wantTitle);
    if (exact) return { ...exact };
    const loose = items.find((item) => item.title.toLowerCase().includes(wantTitle) || wantTitle.includes(item.title.toLowerCase()));
    if (loose) return { ...loose };
  }
  return { error: "not_found", available: listArtifacts({ items }, 8) };
}

export function upsertArtifact(store, input = {}) {
  const next = normalizeArtifacts(store);
  const body = clipBody(input.body ?? input.markdown ?? input.text ?? input.clipboardText);
  if (!body) {
    return { store: next, item: null, error: "empty_body" };
  }
  const now = memoryNow();
  const kind = normalizeKind(input.kind);
  const title = clipTitle(input.title);
  const wantId = String(input.id || "").trim();
  let existing = wantId ? next.items.find((item) => item.id === wantId) : null;
  if (!existing) {
    const wantTitle = title.toLowerCase();
    existing = next.items.find((item) => item.kind === kind && item.title.toLowerCase() === wantTitle);
  }
  if (existing) {
    existing.kind = kind;
    existing.title = title;
    existing.body = body;
    existing.source = String(input.source || existing.source || "save_artifact").slice(0, 40);
    existing.updatedAt = now;
    next.items = [existing, ...next.items.filter((item) => item.id !== existing.id)].slice(0, MAX_ARTIFACTS);
    return { store: next, item: { ...existing }, updated: true };
  }
  const item = {
    id: generateId(),
    kind,
    title,
    body,
    source: String(input.source || "save_artifact").slice(0, 40),
    createdAt: now,
    updatedAt: now,
  };
  next.items = [item, ...next.items].slice(0, MAX_ARTIFACTS);
  return { store: next, item: { ...item }, updated: false };
}

export function buildArtifactIndex(store, limit = 8) {
  const items = listArtifacts(store, limit);
  if (!items.length) return "";
  const lines = [
    "--- ARTIFACTS (exact saved documents — titles only) ---",
    "Keepable lists, emails, and formatted drafts. Titles are labels, not the text.",
    "When they want a saved list, email, or draft back, call get_artifact and use the body VERBATIM. Do not rephrase, summarize, or polish.",
  ];
  for (const item of items) {
    lines.push(`- [${item.kind}] ${item.title}`);
  }
  return lines.join("\n");
}
