// LINE Messaging API：簽章驗證、取得暱稱、下載圖片、推播、標已讀
import { splitText } from "./text";
// LINE_API_BASE / LINE_DATA_BASE 只在本機模擬時覆寫，正式環境用預設值

const DEFAULT_API_BASE = "https://api.line.me";
const DEFAULT_DATA_BASE = "https://api-data.line.me";

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 驗證 X-Line-Signature（HMAC-SHA256，crypto.subtle.verify 為常數時間比較）。 */
export async function verifySignature(channelSecret: string, rawBody: string, signature: string | null): Promise<boolean> {
  if (!channelSecret || !signature) return false;
  const sig = base64ToBytes(signature);
  if (!sig) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(channelSecret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(rawBody));
}

function authHeaders(env: Env): HeadersInit {
  return { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
}

export async function getDisplayName(env: Env, userId: string): Promise<string> {
  const base = env.LINE_API_BASE || DEFAULT_API_BASE;
  const resp = await fetch(`${base}/v2/bot/profile/${encodeURIComponent(userId)}`, { headers: authHeaders(env) });
  if (!resp.ok) return "未知用戶";
  const data = (await resp.json()) as { displayName?: string };
  return data.displayName || "未知用戶";
}

// 單則文字上限沿用舊版程式的 5,000 字；一次推播最多 5 則訊息泡泡
const TEXT_LIMIT = 5000;
const MAX_BUBBLES = 5;

/** 把解答切成 LINE 訊息泡泡（每則 ≤ 5,000 字、最多 5 則）。 */
export function toTextBubbles(text: string): { type: "text"; text: string }[] {
  const chunks = splitText(text.trim(), TEXT_LIMIT);
  if (chunks.length > MAX_BUBBLES) {
    chunks.length = MAX_BUBBLES;
    chunks[MAX_BUBBLES - 1] = `${chunks[MAX_BUBBLES - 1].slice(0, TEXT_LIMIT - 20)}\n（內容過長，已截斷）`;
  }
  return chunks.map((t) => ({ type: "text", text: t }));
}

export type PushResult = { ok: true; duplicate: boolean } | { ok: false; status: number; error: string };

/**
 * 推播解答給學生。retryKey 由呼叫端保存並在重送時沿用：
 * LINE 在 24 小時內收到相同 key 會回 409（代表之前已送出），視為成功，不會重複發送。
 */
export async function pushText(env: Env, to: string, text: string, retryKey: string): Promise<PushResult> {
  const base = env.LINE_API_BASE || DEFAULT_API_BASE;
  const resp = await fetch(`${base}/v2/bot/message/push`, {
    method: "POST",
    headers: { ...authHeaders(env), "Content-Type": "application/json", "X-Line-Retry-Key": retryKey },
    body: JSON.stringify({ to, messages: toTextBubbles(text) }),
  });
  if (resp.ok) return { ok: true, duplicate: false };
  if (resp.status === 409) return { ok: true, duplicate: true };
  return { ok: false, status: resp.status, error: (await resp.text()).slice(0, 300) };
}

/** 標記已讀（連同之前的訊息）。只是體驗加分，失敗不影響流程。 */
export async function markAsRead(env: Env, token: string): Promise<boolean> {
  const base = env.LINE_API_BASE || DEFAULT_API_BASE;
  const resp = await fetch(`${base}/v2/bot/chat/markAsRead`, {
    method: "POST",
    headers: { ...authHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ markAsReadToken: token }),
  });
  return resp.ok;
}

export interface DownloadedImage {
  bytes: Uint8Array;
  contentType: string;
}

export async function downloadContent(env: Env, messageId: string): Promise<DownloadedImage | null> {
  const base = env.LINE_DATA_BASE || DEFAULT_DATA_BASE;
  const resp = await fetch(`${base}/v2/bot/message/${encodeURIComponent(messageId)}/content`, { headers: authHeaders(env) });
  if (!resp.ok) {
    console.log(JSON.stringify({ event: "line_download_failed", messageId, status: resp.status }));
    return null;
  }
  return {
    bytes: new Uint8Array(await resp.arrayBuffer()),
    contentType: resp.headers.get("content-type") || "image/jpeg",
  };
}
