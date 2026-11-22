import { describe, expect, it } from "vitest";
import { createSessionCookie, matchPin, verifySession } from "../src/auth";
import { formatTaipei, html, raw, timeAgo } from "../src/html";
import { toTextBubbles } from "../src/line";
import { CLASS_MAX, cleanField, NAME_MAX, studentLabel } from "../src/students";
import { getAiConfig, isValidModelId, validateAiInput } from "../src/settings";
import { approve, OPEN_CONDITION, saveRegeneratedDraft } from "../src/review";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  claimNotify,
  findMergeTarget,
  getQuestionByEvent,
  listUnnotified,
  markNotified,
  MERGE_WINDOW_MS,
  mergeIntoQuestion,
  NOTIFY_GIVE_UP_MS,
  NOTIFY_LEASE_MS,
  recordNotifyError,
  type QuestionRow,
} from "../src/db";
import type { DraftResult } from "../src/openai";

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

describe("待處理清單的條件（OPEN_CONDITION）", () => {
  it("AI 失敗（kind 為 NULL）的題目要算待處理；非英文、已處理、已送出不算", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE questions (id TEXT, status TEXT, kind TEXT)");
    const rows: [string, string, string | null][] = [
      ["question", "pending", "question"],
      ["ai_failed", "pending", null],
      ["need_info", "pending", "need_more_info"],
      ["non_question", "pending", "non_question"],
      ["dismissed", "dismissed", "non_question"],
      ["sent", "sent", "question"],
      ["push_failed", "push_failed", "question"],
      ["non_question_forced_sent", "push_failed", "non_question"],
    ];
    const insert = db.prepare("INSERT INTO questions VALUES (?, ?, ?)");
    for (const r of rows) insert.run(...r);
    const open = (db.prepare(`SELECT id FROM questions q WHERE ${OPEN_CONDITION} ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
    expect(open).toEqual(["ai_failed", "need_info", "non_question_forced_sent", "push_failed", "question"]);
  });
});

/** 用 node:sqlite 模擬 D1（只實作這裡用到的 prepare/bind/first/run），資料表由實際的 migration 建立。 */
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  const dir = join(__dirname, "../migrations/main");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  const prepare = (sql: string) => {
    let args: SQLInputValue[] = [];
    const stmt = {
      bind: (...a: SQLInputValue[]) => ((args = a), stmt),
      first: async () => db.prepare(sql).get(...args) ?? null,
      run: async () => ({ results: db.prepare(sql).all(...args) }),
    };
    return stmt;
  };
  // D1 的 batch 是同一個交易、依序執行；測試只需要依序執行
  const batch = async (stmts: ReturnType<typeof prepare>[]) => {
    const out = [];
    for (const st of stmts) out.push(await st.run());
    return out;
  };
  return { db, env: { DB: { prepare, batch } } as unknown as Env };
}

describe("Telegram 通知補發（claimNotify / listUnnotified）", () => {
  const now = Date.UTC(2026, 10, 21, 12, 0);
  const setup = () => {
    const t = sqliteD1();
    const add = (id: string, createdAt: number, notifiedAt: number | null = null) =>
      t.db
        .prepare(
          `INSERT INTO questions (id, batch_id, student_line_id, student_name, image_ids, ai_status, status, notified_at, created_at, updated_at)
           VALUES (?, ?, ?, 'x', '[]', 'ok', 'pending', ?, ?, ?)`,
        )
        .run(id, `b-${id}`, `U-${id}`, notifiedAt, createdAt, createdAt);
    return { ...t, add };
  };

  it("同一題同時只有一個人能發；超過租約或還沒成功才能再發", async () => {
    const { env, db, add } = setup();
    add("q1", now - 60_000);
    expect(await claimNotify(env, "q1", now)).toBe(true);
    expect(await claimNotify(env, "q1", now + 1000)).toBe(false); // 租約中（例如排程和緩衝區同時想發）
    expect(await claimNotify(env, "q1", now + NOTIFY_LEASE_MS + 1)).toBe(true); // 發到一半當掉、租約已過
    expect((db.prepare("SELECT notify_attempts FROM questions WHERE id = 'q1'").get() as { notify_attempts: number }).notify_attempts).toBe(2);

    await recordNotifyError(env, "q1", "Telegram sendMessage 500: x");
    expect(await claimNotify(env, "q1", now + NOTIFY_LEASE_MS + 2)).toBe(true); // 失敗會放掉租約，下一次排程馬上能再試
    await markNotified(env, "q1", now + NOTIFY_LEASE_MS + 3);
    const row = db.prepare("SELECT notified_at, notify_error FROM questions WHERE id = 'q1'").get() as { notified_at: number; notify_error: string | null };
    expect(row.notify_error).toBeNull(); // 成功後清掉錯誤原因
    expect(await claimNotify(env, "q1", now + 10 * NOTIFY_LEASE_MS)).toBe(false); // 已通知的不再發
  });

  it("補發清單：只列 2 天內、還沒通知、不在租約中的題目，由舊到新", async () => {
    const { env, add } = setup();
    add("new", now - 60_000);
    add("old_ok", now - 2 * 3600_000);
    add("notified", now - 60_000, now - 50_000);
    add("too_old", now - NOTIFY_GIVE_UP_MS - 1);
    add("leased", now - 60_000);
    await claimNotify(env, "leased", now - 1000);
    expect((await listUnnotified(env, now)).map((r) => r.id)).toEqual(["old_ok", "new"]);
    expect((await listUnnotified(env, now)).find((r) => r.id === "new")?.student_line_id).toBe("U-new");
  });
});

describe("getAiConfig", () => {
  const env = (dbError: boolean, rows: { key: string; value: string }[] = []) =>
    ({
      OPENAI_MODEL_IMAGE: "img-default",
      OPENAI_MODEL_TEXT: "txt-default",
      OPENAI_REASONING_EFFORT: "medium",
      DB: {
        prepare: () => ({
          run: async () => {
            if (dbError) throw new Error("D1_ERROR: no such table: settings");
            return { results: rows };
          },
        }),
      },
    }) as unknown as Env;
  it("讀不到設定資料表時改用預設值，不丟錯", async () => {
    const c = await getAiConfig(env(true));
    expect([c.modelImage, c.modelText, c.effort]).toEqual(["img-default", "txt-default", "medium"]);
    expect(c.custom).toEqual({});
  });
  it("有自訂值時覆蓋預設、並標記為自訂", async () => {
    const c = await getAiConfig(env(false, [{ key: "model_text", value: "txt-custom" }]));
    expect([c.modelImage, c.modelText]).toEqual(["img-default", "txt-custom"]);
    expect(c.custom).toEqual({ model_text: true });
  });
});

describe("AI 設定驗證", () => {
  it("模型名稱只接受英數與 . _ : -", () => {
    expect(isValidModelId("gpt-6.1-sol")).toBe(true);
    expect(isValidModelId("ft:gpt-6-luna:org:abc")).toBe(true);
    expect(isValidModelId("")).toBe(false);
    expect(isValidModelId("gpt 6")).toBe(false);
    expect(isValidModelId("<script>")).toBe(false);
    expect(isValidModelId("x".repeat(65))).toBe(false);
  });
  it("思考深度只接受 low / medium / high", () => {
    expect(validateAiInput({ modelImage: "gpt-6.1-sol", modelText: "gpt-6-luna", effort: "medium" })).toBeNull();
    expect(validateAiInput({ modelImage: "gpt-6.1-sol", modelText: "gpt-6-luna", effort: "max" })).not.toBeNull();
    expect(validateAiInput({ modelImage: "bad model", modelText: "gpt-6-luna", effort: "low" })).not.toBeNull();
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

describe("學生分幾次傳的訊息併入同一題", () => {
  const t0 = Date.UTC(2026, 10, 22, 4, 30);
  const setup = () => {
    const t = sqliteD1();
    const addQ = (id: string, createdAt: number, extra: Record<string, SQLInputValue> = {}) => {
      const row: Record<string, SQLInputValue> = {
        id, batch_id: `b-${id}`, student_line_id: "U1", student_name: "HAO", image_ids: "[]", ai_status: "ok", kind: "question",
        ai_answer: "舊草稿", final_answer: "舊草稿", status: "pending", notified_at: createdAt + 1000, created_at: createdAt, updated_at: createdAt, ...extra,
      };
      const cols = Object.keys(row);
      t.db.prepare(`INSERT INTO questions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => row[c]));
    };
    const addMsg = (eventId: string, ts: number, questionId: string | null, type = "text", text: string | null = "x") =>
      t.db
        .prepare("INSERT INTO messages (event_id, student_line_id, role, type, text, image_id, question_id, ts) VALUES (?, 'U1', 'student', ?, ?, ?, ?, ?)")
        .run(eventId, type, text, type === "image" ? `img-${eventId}` : null, questionId, ts);
    const get = (id: string) => t.db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as Record<string, unknown>;
    return { ...t, addQ, addMsg, get };
  };
  const draft = (answer: string, kind: "question" | "need_more_info" | "non_question" = "question") =>
    ({ draft: { kind, answer, tutor_note: "無", confidence: "high" }, meta: { model: "m" } }) as unknown as DraftResult;

  it("最新一題、等待審核、沒人按過通過、10 分鐘內才併入", async () => {
    const { env, addQ, addMsg } = setup();
    addQ("q1", t0);
    addMsg("e1", t0, "q1");
    expect((await findMergeTarget(env, "U1", t0 + 43_000))?.id).toBe("q1"); // HAO 的情況：照片後 43 秒才打字
    expect(await findMergeTarget(env, "U1", t0 + MERGE_WINDOW_MS + 1)).toBeNull(); // 隔太久
    expect(await findMergeTarget(env, "U2", t0 + 1000)).toBeNull(); // 別的學生
  });

  it("有老師按過通過、已送出、已標記不需回覆，或不是最新一題 → 不併入", async () => {
    const cases: Record<string, SQLInputValue>[] = [{ approver_tutor: 1 }, { status: "sent" }, { status: "dismissed" }];
    for (const extra of cases) {
      const { env, addQ, addMsg } = setup();
      addQ("q1", t0, extra);
      addMsg("e1", t0, "q1");
      expect(await findMergeTarget(env, "U1", t0 + 1000)).toBeNull();
    }
    const { env, addQ, addMsg } = setup();
    addQ("q_old", t0 - 1000);
    addMsg("e0", t0 - 1000, "q_old");
    addQ("q_new", t0, { status: "sent" });
    addMsg("e1", t0, "q_new");
    expect(await findMergeTarget(env, "U1", t0 + 1000)).toBeNull(); // 最新的一題已送出，不會跳去併入更舊的
  });

  it("併入後：內容與草稿更新、版本 +1、訊息連到同一題、補充通知為靜音一行", async () => {
    const { env, db, addQ, addMsg, get } = setup();
    addQ("q1", t0, { image_ids: '["img-e1"]' });
    addMsg("e1", t0, "q1", "image", null);
    addMsg("e2", t0 + 43_000, null, "text", "可以幫我看一下6.跟8.嗎");
    const target = (await findMergeTarget(env, "U1", t0 + 43_000)) as QuestionRow;
    const merged = await mergeIntoQuestion(env, target, {
      questionText: "可以幫我看一下6.跟8.嗎", imageIds: ["img-e1"], contextImageId: null, result: draft("6. ... 8. ..."), aiError: null,
      notifyKind: "update", notifyNote: "「可以幫我看一下6.跟8.嗎」", eventIds: ["e2"], now: t0 + 60_000,
    });
    expect(merged?.draft_version).toBe(2);
    expect(get("q1")).toMatchObject({ merge_count: 1, ai_answer: "6. ... 8. ...", final_answer: "6. ... 8. ...", notified_at: null, notify_kind: "update" });
    expect((db.prepare("SELECT question_id FROM messages WHERE event_id = 'e2'").get() as { question_id: string }).question_id).toBe("q1");
    expect((await getQuestionByEvent(env, "e2"))?.id).toBe("q1"); // alarm 重跑時知道這一批已處理過
  });

  it("AI 失敗時保留原本的草稿，只記錄錯誤", async () => {
    const { env, addQ, addMsg, get } = setup();
    addQ("q1", t0);
    addMsg("e1", t0, "q1");
    const target = (await findMergeTarget(env, "U1", t0 + 1000)) as QuestionRow;
    await mergeIntoQuestion(env, target, {
      questionText: "x\ny", imageIds: [], contextImageId: null, result: null, aiError: "OpenAI 暫時無法使用｜503",
      notifyKind: "update", notifyNote: "「y」", eventIds: [], now: t0 + 2000,
    });
    expect(get("q1")).toMatchObject({ ai_status: "error", ai_answer: "舊草稿", final_answer: "舊草稿", question_text: "x\ny" });
  });

  it("AI 寫草稿期間老師按了通過 → 不併入（回傳 null），訊息不會被連過去", async () => {
    const { env, db, addQ, addMsg, get } = setup();
    addQ("q1", t0);
    addMsg("e1", t0, "q1");
    addMsg("e2", t0 + 1000, null);
    const target = (await findMergeTarget(env, "U1", t0 + 1000)) as QuestionRow;
    db.prepare("UPDATE questions SET approver_cheng_jie = 1 WHERE id = 'q1'").run();
    const merged = await mergeIntoQuestion(env, target, {
      questionText: "x", imageIds: [], contextImageId: null, result: draft("新"), aiError: null, notifyKind: "update", notifyNote: null, eventIds: ["e2"], now: t0 + 2000,
    });
    expect(merged).toBeNull();
    expect(get("q1")).toMatchObject({ ai_answer: "舊草稿", draft_version: 1 });
    expect((db.prepare("SELECT question_id FROM messages WHERE event_id = 'e2'").get() as { question_id: string | null }).question_id).toBeNull();
  });

  it("老師送出時草稿已更新 → 擋下（draft_updated）；用新版本號才能通過", async () => {
    const { env, db, addQ } = setup();
    addQ("q1", t0);
    db.prepare("UPDATE questions SET draft_version = 2 WHERE id = 'q1'").run();
    const stale = await approve(env, "q1", "tutor", "老師改的版本", false, 1);
    expect(stale).toEqual({ kind: "rejected", reason: "draft_updated" });
    const ok = await approve(env, "q1", "tutor", "老師改的版本", false, 2);
    expect(ok.kind).toBe("waiting");
  });

  it("老師按「產生 AI 草稿」也會讓版本 +1（另一位老師開著的舊頁面送出會被擋下）", async () => {
    const { env, addQ, get } = setup();
    addQ("q1", t0);
    await saveRegeneratedDraft(env, "q1", draft("重寫"));
    expect(get("q1")).toMatchObject({ draft_version: 2, ai_answer: "重寫" });
  });
});
