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

/** Exact trigger — "enter brainstorm mode" (STT may split brainstorm). */
export function detectBrainstormEnterCommand(userText) {
  return /\benter\s+brain\s*storm\s+mode\b/i.test(userText || "");
}

/** Exact trigger — "exit brainstorm mode". */
export function detectBrainstormExitCommand(userText) {
  return /\bexit\s+brain\s*storm\s+mode\b/i.test(userText || "");
}

export function stripBrainstormModeCommand(userText) {
  return String(userText || "")
    .replace(/\b(?:enter|exit)\s+brain\s*storm\s+mode\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectPauseCommand(userText) {
  const t = (userText || "").toLowerCase().trim();
  if (/\b(music|song|track|youtube|audio|playback|video)\b/.test(t)) return false;
  return /^(?:pause|hold on|wait|stop)\b/.test(t) || /\b(?:pause|hold on a sec|be quiet)\b/.test(t);
}

export function detectResumeCommand(userText) {
  const t = (userText || "").toLowerCase().trim();
  if (/\b(music|song|track|youtube|audio|playback|video)\b/.test(t)) return false;
  return /^(?:resume|continue|keep going|go ahead)\b/.test(t) || /\b(?:resume|keep going|i'?m back)\b/.test(t);
}

export function normalizeFunction(name) {
  if (!name || typeof name !== "string") return null;
  const key = name.trim().toLowerCase();
  if (key === Fn.PAUSE || key === Fn.RESUME) return key;
  return null;
}
