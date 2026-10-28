// 導師身分：PIN 登入 + 簽章 Cookie（裝置記憶 365 天）
// Cookie 內含 PIN 版本（PIN 的雜湊前綴），更換 PIN 後所有裝置自動登出。

export type Role = "cheng_jie" | "tutor";
// 介面上顯示的名稱（只改這裡就好）；內部代號 cheng_jie／tutor 與 PIN 的 secret 名稱維持不變
// 老師1（cheng_jie）可以「直接通過」與修改 AI 設定
export const ROLE_LABEL: Record<Role, string> = { cheng_jie: "老師1", tutor: "老師2" };

export const SESSION_COOKIE = "lt_session";
export const SESSION_MAX_AGE_SEC = 365 * 24 * 60 * 60;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MAX_FAILURES = 5;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: ("sign" | "verify")[]) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function pinFor(env: Env, role: Role): string {
  return (role === "cheng_jie" ? env.PIN_CHENG_JIE : env.PIN_TUTOR) || "";
}

async function pinVersion(env: Env, role: Role): Promise<string> {
  return (await sha256Hex(`${env.SESSION_SECRET}:${role}:${pinFor(env, role)}`)).slice(0, 16);
}

/** 比對 PIN，回傳對應身分；未設定的 PIN 永遠不會通過。以 HMAC 後比對，避免時間差洩漏。 */
export async function matchPin(env: Env, input: string): Promise<Role | null> {
  if (!input || !env.SESSION_SECRET) return null;
  const key = await hmacKey(env.SESSION_SECRET, ["sign"]);
  const mac = async (s: string) => new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(s)));
  const given = await mac(input);
  let found: Role | null = null;
  for (const role of ["cheng_jie", "tutor"] as Role[]) {
    const pin = pinFor(env, role);
    if (!pin) continue;
    if (constantTimeEqual(given, await mac(pin))) found = role;
  }
  return found;
}

export async function createSessionCookie(env: Env, role: Role, now = Date.now()): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ r: role, v: await pinVersion(env, role), iat: now })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET, ["sign"]), enc.encode(payload)));
  const value = `${payload}.${b64url(sig)}`;
  return `${SESSION_COOKIE}=${value}; Max-Age=${SESSION_MAX_AGE_SEC}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** 驗證 Cookie：簽章正確、未過期、PIN 版本與現在一致才回傳身分。 */
export async function verifySession(env: Env, cookieValue: string | null, now = Date.now()): Promise<Role | null> {
  if (!cookieValue || !env.SESSION_SECRET) return null;
  const [payload, sig] = cookieValue.split(".");
  const sigBytes = sig ? fromB64url(sig) : null;
  if (!payload || !sigBytes) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SECRET, ["verify"]), sigBytes, enc.encode(payload));
  if (!ok) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload) ?? new Uint8Array())) as { r: Role; v: string; iat: number };
    if (data.r !== "cheng_jie" && data.r !== "tutor") return null;
    if (now - data.iat > SESSION_MAX_AGE_SEC * 1000) return null;
    if (data.v !== (await pinVersion(env, data.r))) return null;
    return data.r;
  } catch {
    return null;
  }
}

/**
 * CSRF token：由登入 Cookie 推出（HMAC），放在每個需要登入的表單裡。
 * 不依賴 Origin 標頭：部分內嵌瀏覽器送出表單時 Origin 會是 "null"。
 */
export async function csrfToken(env: Env, cookieValue: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET, ["sign"]), enc.encode(`csrf:${cookieValue}`)));
  return b64url(sig).slice(0, 32);
}

export async function verifyCsrf(env: Env, cookieValue: string | null, token: string | null): Promise<boolean> {
  if (!cookieValue || !token) return false;
  return constantTimeEqual(enc.encode(await csrfToken(env, cookieValue)), enc.encode(token));
}

export async function isLocked(env: Env, ip: string, now = Date.now()): Promise<boolean> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND ts > ?")
    .bind(ip, now - LOCK_WINDOW_MS)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= LOCK_MAX_FAILURES;
}

export async function recordFailure(env: Env, ip: string, now = Date.now()): Promise<void> {
  await env.DB.prepare("INSERT INTO login_failures (ip, ts) VALUES (?, ?)").bind(ip, now).run();
}

export async function purgeOldFailures(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM login_failures WHERE ts < ?").bind(now - LOCK_WINDOW_MS).run();
}
