// 純函式工具：不依賴 Worker 環境，可直接用 vitest 測試

/** 移除中文句尾的「。」：行尾直接刪，行中的改成換行（模型不一定遵守「不加句號」的格式規則）。 */
export function cleanAnswer(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/。+\s*$/u, "").replace(/。+\s*(?=\S)/gu, "\n"))
    .join("\n")
    .split("\n")
    .map((line) => line.replace(/^[ \t]+/, ""))
    .join("\n")
    .trim();
}

// 只由這些詞（可重複、可組合）構成的訊息視為社交回應，例如「好的謝謝老師🙏」「喔喔喔 懂了🫡」
const SOCIAL_TOKENS = [
  "謝謝老師", "謝謝你", "謝謝", "感謝你", "感謝", "多謝", "謝啦", "謝了",
  "好的", "好喔", "好哦", "好啊", "好", "喔", "哦", "嗯", "欸",
  "了解", "收到", "知道了", "懂了", "沒問題", "老師",
  "okay", "ok", "thankyou", "thanks", "thx", "ty", "gotit", "noted", "sure", "np",
];
const SOCIAL_RE = new RegExp(`^(?:${SOCIAL_TOKENS.join("|")})+$`, "iu");
// 去掉空白、標點、符號與 emoji（含膚色、變體選擇符、ZWJ）
const NOISE_RE = /[\s\p{P}\p{S}\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]/gu;

/** 純文字社交回應（沒有圖片）回傳 true，代表不需要產生解答。純 emoji 也算。 */
export function isSocialOnly(text: string | null, hasImage: boolean): boolean {
  if (hasImage || text === null) return false;
  const core = text.replace(NOISE_RE, "");
  return core === "" || SOCIAL_RE.test(core);
}

/** 跳脫 HTML 特殊字元（Telegram HTML 模式、審核頁共用）。 */
export function escapeHtml(text: string | null | undefined): string {
  return (text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 依換行切段，每段不超過 size 字；單行過長時硬切。 */
export function splitText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (let line of text.split("\n")) {
    while (line.length > size) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(line.slice(0, size));
      line = line.slice(size);
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > size) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [""];
}

/** 截短顯示用文字。 */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Uint8Array → base64（分段處理，避免大圖片超過函式參數上限）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
