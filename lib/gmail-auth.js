import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { config } from "./states.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN_PATH = path.join(root, ".gmail-tokens.json");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

export function gmailConfigured() {
  return Boolean(config.gmailEnabled && config.googleClientId && config.googleClientSecret);
}

export function getLocalAuthUrl() {
  return `http://localhost:${config.port}/api/gmail/auth`;
}

function createOAuthClient() {
  return new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    config.gmailRedirectUri
  );
}

function loadTokens() {
  try {
    const raw = fs.readFileSync(TOKEN_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  const prev = loadTokens() || {};
  const merged = { ...prev, ...tokens };
  if (merged.refresh_token || merged.access_token || merged.installed) {
    merged.installed = true;
  }
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

export function isGmailConnected() {
  const tokens = loadTokens();
  return Boolean(tokens?.refresh_token || tokens?.access_token);
}

/** Downloaded/connected at least once — survives new voice sessions. */
export function isGmailAppInstalled() {
  const tokens = loadTokens();
  const installed = Boolean(tokens?.installed || tokens?.refresh_token || tokens?.access_token);
  if (installed && !tokens?.installed) {
    try { markGmailAppInstalled(); } catch {}
  }
  return installed;
}

export function markGmailAppInstalled() {
  try {
    const prev = loadTokens() || {};
    if (prev.installed) return;
    saveTokens({ installed: true });
  } catch {}
}

export function getAuthUrl() {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
}

export async function exchangeCode(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(String(code || ""));
  saveTokens(tokens);
  return true;
}

export function getGmailAuthClient() {
  if (!gmailConfigured()) return null;
  const tokens = loadTokens();
  if (!tokens?.access_token && !tokens?.refresh_token) return null;
  const client = createOAuthClient();
  client.setCredentials(tokens);
  client.on("tokens", (fresh) => {
    try {
      saveTokens(fresh);
    } catch {}
  });
  return client;
}

export async function getGmailStatus() {
  const configured = gmailConfigured();
  const connected = isGmailConnected();
  let email = null;
  if (connected) {
    try {
      const auth = getGmailAuthClient();
      if (auth) {
        const gmail = google.gmail({ version: "v1", auth });
        const profile = await gmail.users.getProfile({ userId: "me" });
        email = profile.data?.emailAddress || null;
      }
    } catch {
      email = null;
    }
  }
  return { configured, connected, installed: isGmailAppInstalled(), ...(email ? { email } : {}) };
}
