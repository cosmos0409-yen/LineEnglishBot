import { DurableObject } from "cloudflare:workers";
import { createQuestion, getHistory, getQuestionByBatch, markNotified, recordStudentMessages, type QuestionRow } from "./db";
import { loadImage, saveImage, type StoredImage } from "./images";
import { downloadContent, getDisplayName } from "./line";
import { AI_ERROR_REASON, AiError, generateDraft, type AiErrorKind, type DraftInput, type DraftResult, type HistoryTurn } from "./openai";
import { claimFallbackWarning, type AiConfigInput } from "./settings";
import { getQuestion, saveRegeneratedDraft } from "./review";
import { getStudent, studentLabel, upsertStudent } from "./students";
import { notifyModelFallback, notifyQuestion } from "./telegram";
import { bytesToBase64, isSocialOnly } from "./text";

/** webhook 事件中處理需要的欄位（存進 DO 的 SQLite）。 */
export interface BufferedMessage {
  webhookEventId: string;
  timestamp: number;
  messageId: string;
  type: string; // text / image / 其他
  text: string | null;
  markAsReadToken: string | null;
}

/** AI 設定頁「測試」的結果（一個模型一筆）。 */
export interface AiTestResult {
  label: string;
  model: string;
  ok: boolean;
  seconds: number;
  skipped?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  kind?: string;
  answer?: string;
  error?: string;
}

const MAX_IMAGES = 4;
// Cloudflare alarm 丟出例外後最多重試 6 次（retryCount 0 是第一次執行；已在部署版確認最大為 6）
const LAST_RETRY = 6;
// 前文：同一學生最近 60 分鐘、最多 8 則
const HISTORY_WINDOW_MS = 60 * 60 * 1000;
const HISTORY_LIMIT = 8;

/**
 * 每位學生一個實例（以 LINE userId 命名）。
 * enqueue：存訊息並把 alarm 重設為 N 秒後 → 同一學生連續傳的訊息合併成一批。
 * alarm：只處理「當下快照」的訊息，成功後才刪除；處理中途新進來的訊息留給下一個 alarm。
 * alarm 丟出例外時 Cloudflare 會自動重試（最多 6 次），訊息不會遺失。
 * 每一步都可重跑：訊息以 event_id 去重、提問以 batch_id 去重、已通知的不重發。
 */
export class StudentBuffer extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS pending (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }

  async enqueue(userId: string, msg: BufferedMessage): Promise<void> {
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('user_id', ?)`, userId);
    // LINE 重送同一事件時 event_id 相同，忽略重複
    this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO pending (event_id, body) VALUES (?, ?)`, msg.webhookEventId, JSON.stringify(msg));
    const seconds = Number(this.env.BUFFER_SECONDS) || 30;
    await this.ctx.storage.setAlarm(Date.now() + seconds * 1000);
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const userRow = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'user_id'`).toArray()[0];
    const rows = this.ctx.storage.sql.exec<{ seq: number; body: string }>(`SELECT seq, body FROM pending ORDER BY seq`).toArray();
    if (!userRow || rows.length === 0) return;

    const userId = userRow.value;
    const maxSeq = rows[rows.length - 1].seq;
    const messages = rows.map((r) => JSON.parse(r.body) as BufferedMessage);

    const retryCount = alarmInfo?.retryCount ?? 0;
    try {
      await this.processBatch(userId, messages, retryCount);
    } catch (err) {
      // 記下是哪一批、第幾次重試、錯在哪，再丟出讓 alarm 重試
      console.log(JSON.stringify({ event: "batch_failed", userId, batchId: messages[0].webhookEventId, retryCount, error: String(err).slice(0, 500) }));
      throw err;
    }

    this.ctx.storage.sql.exec(`DELETE FROM pending WHERE seq <= ?`, maxSeq);
  }

  private async processBatch(userId: string, messages: BufferedMessage[], retryCount: number): Promise<void> {
    const batchId = messages[0].webhookEventId;
    const firstTs = Math.min(...messages.map((m) => m.timestamp));
    const texts = messages.filter((m) => m.type === "text" && m.text).map((m) => m.text as string);
    const imageIds = messages.filter((m) => m.type === "image").map((m) => m.messageId);
    const text = texts.length > 0 ? texts.join("\n") : null;

    const log = (event: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ event, userId, batchId, batchSize: messages.length, retryCount, ...extra }));

    // 所有學生訊息都留紀錄（包含社交回應），作為之後的前文
    await recordStudentMessages(
      this.env,
      messages.map((m) => ({
        eventId: m.webhookEventId,
        studentLineId: userId,
        type: m.type,
        text: m.text,
        imageId: m.type === "image" ? m.messageId : null,
        markAsReadToken: m.markAsReadToken,
        ts: m.timestamp,
      })),
    );

    if (imageIds.length === 0 && text === null) return log("batch_skipped_no_content");
    if (isSocialOnly(text, imageIds.length > 0)) return log("batch_skipped_social", { text });

    let question = await getQuestionByBatch(this.env, batchId);
    let images: StoredImage[] = [];

    if (!question) {
      images = await this.fetchAndStoreImages(userId, imageIds.slice(0, MAX_IMAGES), retryCount);
      const history = await getHistory(this.env, userId, firstTs, HISTORY_WINDOW_MS, HISTORY_LIMIT);
      const contextImageId = images.length === 0 ? [...history].reverse().find((h) => h.imageId)?.imageId ?? null : null;
      const contextImage = contextImageId ? await loadImage(this.env, contextImageId) : null;

      const turns: HistoryTurn[] = history.map((h) => ({
        role: h.role,
        text: h.text,
        hadImage: Boolean(h.imageId),
        minutesAgo: Math.max(1, Math.round((firstTs - h.ts) / 60000)),
      }));

      log("batch_processing", {
        text,
        imageCount: images.length,
        historyCount: turns.length,
        contextImage: Boolean(contextImage),
      });

      let result: DraftResult | null = null;
      let aiError: string | null = null;
      try {
        result = await generateDraft(this.env, {
          text,
          images: images.map((img) => ({ base64: bytesToBase64(img.bytes), contentType: img.contentType })),
          history: turns,
          contextImage: contextImage ? { base64: bytesToBase64(contextImage.bytes), contentType: contextImage.contentType } : null,
        });
      } catch (err) {
        // 金鑰失效、額度用完、模型設定錯：重試也不會好 → 直接存成「AI 失敗」並通知老師（寫明原因）
        // 其他（OpenAI 暫時故障、網路問題）：交給 alarm 重試，最後一次仍失敗才通知
        const retryable = !(err instanceof AiError) || err.retryable;
        if (retryable && retryCount < LAST_RETRY) throw err;
        aiError = (err instanceof AiError ? err.message : `${AI_ERROR_REASON.unknown}｜${String(err)}`).slice(0, 500);
        log("ai_failed", { kind: err instanceof AiError ? err.kind : "unknown", retryable, aiError });
      }

      const lineName = await getDisplayName(this.env, userId);
      await upsertStudent(this.env, userId, lineName);
      question = await createQuestion(this.env, {
        batchId,
        studentLineId: userId,
        studentName: lineName,
        questionText: text,
        imageIds: imageIds.slice(0, MAX_IMAGES),
        contextImageId: contextImage ? contextImageId : null,
        result,
        aiError,
        eventIds: messages.map((m) => m.webhookEventId),
        now: Date.now(),
      });
      log("question_saved", { questionId: question.id, kind: question.kind, aiStatus: question.ai_status, ...(result?.meta ?? {}) });
      // 設定的模型不能用、已自動改用預設模型：提醒老師1更新設定（一小時最多一次；提醒失敗不影響這一題）
      if (result?.meta.modelFallbackFrom && (await claimFallbackWarning(this.env))) {
        await notifyModelFallback(this.env, result.meta.modelFallbackFrom, result.meta.model).catch((e) =>
          log("fallback_warning_failed", { error: String(e).slice(0, 200) }),
        );
      }
    }

    if (question.notified_at === null) {
      if (images.length === 0) images = await this.loadQuestionImages(question);
      // 通知用老師設定的備註名稱（沒設定就用 LINE 暱稱）
      const student = await getStudent(this.env, userId);
      await notifyQuestion(this.env, question, images, student ? studentLabel(student) : question.student_name);
      await markNotified(this.env, question.id);
      log("telegram_notified", { questionId: question.id });
    }
  }

  /** 下載並存入 IMAGES_DB（已存的直接讀回）。下載失敗時，還有重試機會就丟例外，不會少了照片照樣解題。 */
  private async fetchAndStoreImages(userId: string, ids: string[], retryCount: number): Promise<StoredImage[]> {
    const images: StoredImage[] = [];
    let missing = 0;
    for (const id of ids) {
      const stored = await loadImage(this.env, id);
      if (stored) {
        images.push(stored);
        continue;
      }
      const downloaded = await downloadContent(this.env, id);
      if (!downloaded) {
        missing++;
        continue;
      }
      await saveImage(this.env, id, userId, downloaded);
      images.push(downloaded);
    }
    if (missing > 0 && retryCount < LAST_RETRY) throw new Error(`圖片下載失敗 ${missing} 張，等待重試`);
    return images;
  }

  /**
   * AI 設定頁的「測試」：用指定的模型各跑一次，不自動退回預設模型，如實回報能不能用。
   * 照片題用最近一題有照片的提問（只在系統內部使用）；純文字用固定的範例題。
   */
  async testAiConfig(config: AiConfigInput): Promise<AiTestResult[]> {
    const results: AiTestResult[] = [];
    const run = async (label: string, model: string, input: DraftInput) => {
      const started = Date.now();
      try {
        const r = await generateDraft(this.env, input, { config, allowFallback: false });
        results.push({
          label,
          model,
          ok: true,
          seconds: Math.round((Date.now() - started) / 100) / 10,
          promptTokens: r.meta.promptTokens,
          completionTokens: r.meta.completionTokens,
          kind: r.draft.kind,
          answer: r.draft.answer.slice(0, 600),
        });
      } catch (err) {
        results.push({ label, model, ok: false, seconds: Math.round((Date.now() - started) / 100) / 10, error: err instanceof AiError ? err.message : String(err).slice(0, 300) });
      }
    };

    await run("純文字題目", config.modelText, { text: "since 跟 ever since 有什麼不同？", images: [] });

    const latest = await this.env.DB.prepare(
      "SELECT image_ids, question_text FROM questions WHERE image_ids != '[]' ORDER BY created_at DESC LIMIT 1",
    ).first<{ image_ids: string; question_text: string | null }>();
    const imageId = latest ? (JSON.parse(latest.image_ids) as string[])[0] : undefined;
    const img = imageId ? await loadImage(this.env, imageId) : null;
    if (img) {
      await run("有照片的題目（用最近一題的照片）", config.modelImage, {
        text: latest?.question_text ?? null,
        images: [{ base64: bytesToBase64(img.bytes), contentType: img.contentType }],
      });
    } else {
      results.push({ label: "有照片的題目", model: config.modelImage, ok: false, seconds: 0, skipped: true, error: "目前沒有可用的照片題（可能都超過保存期限），這一項沒有測試" });
    }
    return results;
  }

  /** 審核頁讀照片（D1 照片轉換需要的 CPU 可能超過 Worker 的 10 ms，所以放在 DO 處理）。 */
  async getImage(imageId: string): Promise<StoredImage | null> {
    return loadImage(this.env, imageId);
  }

  /** 老師在審核頁按「產生 AI 草稿」：用原本的訊息、照片、前文重新產生，並強制作答。 */
  async regenerate(questionId: string): Promise<{ ok: true } | { ok: false; kind: AiErrorKind }> {
    const q = await getQuestion(this.env, questionId);
    if (!q) return { ok: false, kind: "unknown" };
    const images = await this.loadQuestionImages(q);
    const contextImage = q.context_image_id ? await loadImage(this.env, q.context_image_id) : null;
    const first = await this.env.DB.prepare("SELECT MIN(ts) AS ts FROM messages WHERE question_id = ?").bind(q.id).first<{ ts: number | null }>();
    const firstTs = first?.ts ?? q.created_at;
    const history = await getHistory(this.env, q.student_line_id, firstTs, HISTORY_WINDOW_MS, HISTORY_LIMIT);
    try {
      const result = await generateDraft(this.env, {
        text: q.question_text,
        images: images.map((img) => ({ base64: bytesToBase64(img.bytes), contentType: img.contentType })),
        history: history.map((h) => ({
          role: h.role,
          text: h.text,
          hadImage: Boolean(h.imageId),
          minutesAgo: Math.max(1, Math.round((firstTs - h.ts) / 60000)),
        })),
        contextImage: contextImage ? { base64: bytesToBase64(contextImage.bytes), contentType: contextImage.contentType } : null,
        forceAnswer: true,
      });
      await saveRegeneratedDraft(this.env, q.id, result);
      console.log(JSON.stringify({ event: "draft_regenerated", questionId: q.id, kind: result.draft.kind, ...result.meta }));
      return { ok: true };
    } catch (err) {
      console.log(JSON.stringify({ event: "regenerate_failed", questionId: q.id, error: String(err).slice(0, 300) }));
      return { ok: false, kind: err instanceof AiError ? err.kind : "unknown" };
    }
  }

  private async loadQuestionImages(q: QuestionRow): Promise<StoredImage[]> {
    const ids = JSON.parse(q.image_ids) as string[];
    const loaded = await Promise.all(ids.map((id) => loadImage(this.env, id)));
    return loaded.filter((img): img is StoredImage => img !== null);
  }
}
