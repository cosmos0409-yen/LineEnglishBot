import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignature } from "../src/line";
import { bytesToBase64, cleanAnswer, isSocialOnly } from "../src/text";

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

describe("bytesToBase64", () => {
  it("大檔案與 Node Buffer 結果一致", () => {
    const bytes = new Uint8Array(200_000).map((_, i) => (i * 31) % 256);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
