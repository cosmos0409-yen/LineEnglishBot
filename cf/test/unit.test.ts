import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignature } from "../src/line";
import { AI_ERROR_REASON, classifyOpenAIError } from "../src/openai";
import { bytesToBase64, cleanAnswer, escapeHtml, isSocialOnly, splitText } from "../src/text";

describe("verifySignature", () => {
  const secret = "dev-secret";
  const body = JSON.stringify({ events: [{ type: "message" }] });
  const good = createHmac("sha256", secret).update(body).digest("base64");

  it("正確簽章通過", async () => {
    expect(await verifySignature(secret, body, good)).toBe(true);
  });
  it("內容被改過就拒絕", async () => {
    expect(await verifySignature(secret, body + " ", good)).toBe(false);
  });
  it("錯誤 secret、缺簽章、亂碼簽章都拒絕", async () => {
    expect(await verifySignature("other", body, good)).toBe(false);
    expect(await verifySignature(secret, body, null)).toBe(false);
    expect(await verifySignature(secret, body, "%%%not-base64")).toBe(false);
    expect(await verifySignature("", body, good)).toBe(false);
  });
});

describe("cleanAnswer", () => {
  it("刪除行尾句號、行中句號改換行，英文句點保留", () => {
    const input = "8. D scarce（稀少的）。To be frank 是固定說法。\nI'm recovering from the flu.\n答案是 A。";
    expect(cleanAnswer(input)).toBe("8. D scarce（稀少的）\nTo be frank 是固定說法\nI'm recovering from the flu.\n答案是 A");
  });
  it("移除行首多餘空白，保留空行", () => {
    expect(cleanAnswer("3. D grocery\n grocery 是名詞\n\n  例句")).toBe("3. D grocery\ngrocery 是名詞\n\n例句");
  });
});

describe("escapeHtml", () => {
  it("跳脫 & < > \"", () => {
    expect(escapeHtml(`<b>"A&B"</b>`)).toBe("&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;");
    expect(escapeHtml(null)).toBe("");
  });
});

describe("splitText", () => {
  it("每段不超過上限、內容不遺失", () => {
    const text = Array.from({ length: 200 }, (_, i) => `第${i}行 ${"x".repeat(40)}`).join("\n");
    const chunks = splitText(text, 1000);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.join("\n")).toBe(text);
  });
  it("單行超長時硬切", () => {
    const chunks = splitText("y".repeat(2500), 1000);
    expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 500]);
  });
});

describe("isSocialOnly", () => {
  it.each(["謝謝老師🙏🙏", "好的謝謝老師", "喔喔喔喔喔喔 懂了🫡", "😮 感謝🙏", "👌🏾", "🉑", "OK", "thank you!", "了解謝謝老師🙏🙏"])(
    "社交回應：%s",
    (t) => expect(isSocialOnly(t, false)).toBe(true),
  );
  it.each([
    "since 跟ever since 有區別嗎",
    "老師明天要帶什麼？",
    "那這題呢",
    "好吧",
    "謝謝老師 那這題呢",
    "crush,crash的用法有什麼差別呢？",
    "今天考大卷 嗚啊大卷很慘",
  ])("要交給 AI 判斷：%s", (t) => expect(isSocialOnly(t, false)).toBe(false));
  it("有圖片一律不算社交回應", () => expect(isSocialOnly("謝謝", true)).toBe(false));
  it("沒有文字不算社交回應", () => expect(isSocialOnly(null, false)).toBe(false));
});

describe("classifyOpenAIError", () => {
  const body = (code: string) => JSON.stringify({ error: { message: "x", code } });
  it.each([
    [401, body("token_invalidated"), "auth", false],
    [401, body("invalid_api_key"), "auth", false],
    [403, body("unsupported_country_region_territory"), "auth", false],
    [429, body("insufficient_quota"), "quota", false],
    [429, body("rate_limit_exceeded"), "rate_limit", true],
    [404, body("model_not_found"), "model", false],
    [400, body("invalid_request_error"), "model", false],
    [500, "<html>oops</html>", "server", true],
    [503, "", "server", true],
  ])("HTTP %i %s → %s（可重試：%s）", (status, b, kind, retryable) => {
    const e = classifyOpenAIError(status, b);
    expect(e.kind).toBe(kind);
    expect(e.retryable).toBe(retryable);
    // 訊息格式「給老師的原因｜技術細節」：通知與審核頁取 ｜ 前面那段
    expect(e.message.split("｜")[0]).toBe(AI_ERROR_REASON[kind as keyof typeof AI_ERROR_REASON]);
    expect(e.message).toContain(`HTTP ${status}`);
  });
});

describe("bytesToBase64", () => {
  it("大檔案與 Node Buffer 結果一致", () => {
    const bytes = new Uint8Array(200_000).map((_, i) => (i * 31) % 256);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
