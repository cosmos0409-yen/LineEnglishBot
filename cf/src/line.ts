// LINE Messaging API：簽章驗證、取得暱稱、下載圖片
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
