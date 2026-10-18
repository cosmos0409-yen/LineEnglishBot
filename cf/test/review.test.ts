import { describe, expect, it } from "vitest";
import { createSessionCookie, matchPin, verifySession } from "../src/auth";
import { formatTaipei, html, raw, timeAgo } from "../src/html";
import { toTextBubbles } from "../src/line";
import { CLASS_MAX, cleanField, NAME_MAX, studentLabel } from "../src/students";

const env = (over: Partial<Record<string, string>> = {}) =>
  ({ SESSION_SECRET: "test-secret", PIN_CHENG_JIE: "111111", PIN_TUTOR: "222222", ...over }) as unknown as Env;

const cookieValue = (setCookie: string) => setCookie.split(";")[0].split("=").slice(1).join("=");

describe("matchPin", () => {
  it("對應到正確身分", async () => {
    expect(await matchPin(env(), "111111")).toBe("cheng_jie");
    expect(await matchPin(env(), "222222")).toBe("tutor");
  });
  it("錯誤、空白、未設定的 PIN 都不通過", async () => {
    expect(await matchPin(env(), "000000")).toBeNull();
    expect(await matchPin(env(), "")).toBeNull();
    expect(await matchPin(env({ PIN_TUTOR: "" }), "")).toBeNull();
    expect(await matchPin(env({ SESSION_SECRET: "" }), "111111")).toBeNull();
  });
});

describe("session cookie", () => {
  it("簽發後可驗證，且屬性正確", async () => {
    const set = await createSessionCookie(env(), "tutor");
    expect(set).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(set).toMatch(/Max-Age=31536000/);
    expect(await verifySession(env(), cookieValue(set))).toBe("tutor");
  });
  it("被竄改就失效", async () => {
    const v = cookieValue(await createSessionCookie(env(), "tutor"));
    const [payload, sig] = v.split(".");
    const forged = Buffer.from(JSON.stringify({ r: "cheng_jie", v: "x", iat: Date.now() })).toString("base64url");
    expect(await verifySession(env(), `${forged}.${sig}`)).toBeNull();
    expect(await verifySession(env(), `${payload}.AAAA`)).toBeNull();
    expect(await verifySession(env(), "garbage")).toBeNull();
    expect(await verifySession(env(), null)).toBeNull();
  });
  it("更換 PIN 後舊 Cookie 自動失效（只影響被換的那位）", async () => {
    const tutor = cookieValue(await createSessionCookie(env(), "tutor"));
    const cj = cookieValue(await createSessionCookie(env(), "cheng_jie"));
    const changed = env({ PIN_TUTOR: "999999" });
    expect(await verifySession(changed, tutor)).toBeNull();
    expect(await verifySession(changed, cj)).toBe("cheng_jie");
  });
  it("超過一年失效、換了 SESSION_SECRET 也失效", async () => {
    const old = cookieValue(await createSessionCookie(env(), "tutor", Date.now() - 366 * 24 * 3600 * 1000));
    expect(await verifySession(env(), old)).toBeNull();
    const v = cookieValue(await createSessionCookie(env(), "tutor"));
    expect(await verifySession(env({ SESSION_SECRET: "rotated" }), v)).toBeNull();
  });
});

describe("html 樣板", () => {
  it("插入值自動跳脫，raw 原樣輸出", () => {
    const evil = `<script>alert("x")</script>`;
    expect(html`<p>${evil}</p>`.value).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
    expect(html`<p title="${evil}">${raw("<b>ok</b>")}</p>`.value).toContain('title="&lt;script&gt;alert(&quot;x&quot;)');
    expect(html`<ul>${["<a>", "b"].map((s) => html`<li>${s}</li>`)}</ul>`.value).toBe("<ul><li>&lt;a&gt;</li><li>b</li></ul>");
    expect(html`${null}${undefined}${false}${0}`.value).toBe("0");
  });
  it("台灣時間與相對時間", () => {
    expect(formatTaipei(Date.UTC(2026, 3, 7, 7, 49))).toBe("4/7 15:49"); // 舊版顯示 07:49（UTC）的 bug
    expect(formatTaipei(Date.UTC(2026, 11, 31, 20, 5))).toBe("1/1 04:05");
    const now = Date.UTC(2026, 9, 18, 12, 0);
    expect(timeAgo(now - 30_000, now)).toBe("剛剛");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5 分鐘前");
    expect(timeAgo(now - 3 * 3600_000, now)).toBe("3 小時前");
    expect(timeAgo(now - 49 * 3600_000, now)).toBe("2 天前");
  });
});

describe("學生名稱", () => {
  it("備註名稱優先，空白時用 LINE 暱稱", () => {
    expect(studentLabel({ display_name: "王小明", line_name: "slowbro" })).toBe("王小明");
    expect(studentLabel({ display_name: "  ", line_name: "slowbro" })).toBe("slowbro");
    expect(studentLabel({ display_name: null, line_name: null, student_name: "舊暱稱" })).toBe("舊暱稱");
  });
  it("cleanField：去空白、壓縮空白、限長，空字串存成 null", () => {
    expect(cleanField("  高一  C 班 ", CLASS_MAX)).toBe("高一 C 班");
    expect(cleanField("   ", CLASS_MAX)).toBeNull();
    expect(cleanField(null, NAME_MAX)).toBeNull();
    expect(cleanField("x".repeat(50), NAME_MAX)?.length).toBe(NAME_MAX);
  });
});

describe("toTextBubbles", () => {
  it("短解答一則", () => {
    expect(toTextBubbles("  8. D scarce  ")).toEqual([{ type: "text", text: "8. D scarce" }]);
  });
  it("長解答切成多則、每則 ≤ 5000 字、最多 5 則", () => {
    const long = Array.from({ length: 400 }, (_, i) => `第${i}行 ${"x".repeat(60)}`).join("\n"); // 約 27,000 字
    const bubbles = toTextBubbles(long);
    expect(bubbles.length).toBe(5);
    expect(bubbles.every((b) => b.text.length <= 5000)).toBe(true);
    expect(bubbles[4].text.endsWith("（內容過長，已截斷）")).toBe(true);
  });
});
