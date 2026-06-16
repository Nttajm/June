export const Fn = Object.freeze({
  PAUSE: "pause",
  RESUME: "resume",
  SLEEP: "sleep",
});

/** Only hardcoded trigger — "go to sleep" / "go sleep" */
export function detectSleepCommand(userText) {
  const t = (userText || "").toLowerCase();
  return /\bgo\s+(?:to\s+)?sleep\b/.test(t);
}

export function normalizeFunction(name) {
  if (!name || typeof name !== "string") return null;
  const key = name.trim().toLowerCase();
  if (key === Fn.PAUSE || key === Fn.RESUME) return key;
  return null;
}
