import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignature } from "../src/line";
import { notifyQuestion, sendMessage } from "../src/telegram";
import type { QuestionRow } from "../src/db";
import { SYSTEM_PROMPT } from "../src/prompt";
import { AI_ERROR_REASON, buildMessages, classifyOpenAIError } from "../src/openai";
import { bufferDelaySeconds, bytesToBase64, cleanAnswer, escapeHtml, isSocialOnly, splitText } from "../src/text";

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

describe("Telegram 限流（429）", () => {
  const env = { TELEGRAM_API_BASE: "https://tg.test", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "-1" } as unknown as Env;
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  afterEach(() => vi.unstubAllGlobals());

  it("照 retry_after 等待後重送成功", async () => {
    const calls: number[] = [];
    vi.stubGlobal("fetch", async () => {
      calls.push(Date.now());
      return calls.length === 1 ? reply(429, { ok: false, parameters: { retry_after: 1 } }) : reply(200, { ok: true });
    });
    await sendMessage(env, "hi");
    expect(calls.length).toBe(2);
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(1000);
  });

  it("要等太久或一直被限流就丟錯（交給排程補發），其他錯誤不重送", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => (n++, reply(429, { ok: false, parameters: { retry_after: 120 } })));
    await expect(sendMessage(env, "hi")).rejects.toThrow(/429/);
    expect(n).toBe(1);

    n = 0;
    vi.stubGlobal("fetch", async () => (n++, reply(400, { ok: false, description: "Bad Request: can't parse entities" })));
    await expect(sendMessage(env, "hi")).rejects.toThrow(/400.*parse entities/);
    expect(n).toBe(1);
  });
});

describe("緩衝等待時間", () => {
  it("只有照片時等 3 倍；有文字（或只有貼圖）照一般秒數", () => {
    expect(bufferDelaySeconds(["image"], 30)).toBe(90);
    expect(bufferDelaySeconds(["image", "sticker"], 30)).toBe(90);
    expect(bufferDelaySeconds(["image", "text"], 30)).toBe(30);
    expect(bufferDelaySeconds(["text"], 30)).toBe(30);
    expect(bufferDelaySeconds(["sticker"], 30)).toBe(30);
  });
});

describe("送給 AI 的內容", () => {
  const img = { base64: "AAAA", contentType: "image/jpeg" };
  const userParts = (input: Parameters<typeof buildMessages>[0]) => {
    const msgs = buildMessages(input);
    return (msgs[msgs.length - 1].content as { type: string; text?: string }[]).map((p) => (p.type === "text" ? p.text : "[圖]"));
  };
  it("多張照片標上傳送順序；併入的題目說明是分幾次傳的", () => {
    expect(userParts({ text: "6 跟 8，還有這頁的 8", images: [img, img], merged: true })).toEqual([
      "（學生分幾次傳了下面的照片與文字，請當成同一個提問一起回答；文字依傳送時間排列）",
      "（照片 1／2，依學生傳送順序）",
      "[圖]",
      "（照片 2／2，依學生傳送順序）",
      "[圖]",
      "6 跟 8，還有這頁的 8",
    ]);
  });
  it("只有一張照片時不加標籤（和原本一樣）", () => {
    expect(userParts({ text: null, images: [img] })).toEqual(["[圖]", "（學生只傳了圖片，沒有附文字）"]);
  });
  it("Prompt 有「只有照片時不延續舊話題」與「夾雜非英文事項寫進給老師備註」的規則", () => {
    expect(SYSTEM_PROMPT).toContain("不要延續前面已經回答過的話題");
    expect(SYSTEM_PROMPT).toContain("學生另外提到");
  });
});

describe("補充通知", () => {
  const env = { TELEGRAM_API_BASE: "https://tg.test", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "-1", APP_BASE_URL: "https://app.test" } as unknown as Env;
  afterEach(() => vi.unstubAllGlobals());
  const capture = () => {
    const sent: { url: string; body: Record<string, unknown> | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    return sent;
  };
  const q = (over: Partial<QuestionRow>) =>
    ({ id: "q1", question_text: "6 跟 8", ai_status: "ok", kind: "question", ai_answer: "草稿", tutor_note: "無", context_image_id: null, notify_kind: "new", notify_note: null, ...over }) as QuestionRow;
  const img = { bytes: new Uint8Array([1]), contentType: "image/jpeg" };

  it("update：一則靜音文字，寫出補傳了什麼，不重發照片", async () => {
    const sent = capture();
    await notifyQuestion(env, q({ notify_kind: "update", notify_note: "照片 1 張＋「還有這頁的8.」" }), [img], "<HAO>");
    expect(sent.length).toBe(1);
    expect(sent[0].url).toMatch(/sendMessage$/);
    expect(sent[0].body).toMatchObject({ disable_notification: true });
    expect(String(sent[0].body?.text)).toContain("<b>補充｜&lt;HAO&gt;</b>　照片 1 張＋「還有這頁的8.」");
    expect(String(sent[0].body?.text)).toContain("草稿已更新");
  });

  it("upgrade：照新提問格式完整通知（有聲、附照片），標註是補充後的", async () => {
    const sent = capture();
    await notifyQuestion(env, q({ notify_kind: "upgrade" }), [img], "HAO");
    expect(sent.map((s) => s.url.split("/").pop())).toEqual(["sendPhoto", "sendMessage"]);
    expect(sent[1].body).not.toHaveProperty("disable_notification");
    expect(String(sent[1].body?.text)).toContain("新提問（學生補充後）｜HAO");
  });
});
