import { DurableObject } from "cloudflare:workers";
import { createQuestion, getHistory, getQuestionByBatch, markNotified, recordStudentMessages, type QuestionRow } from "./db";
import { loadImage, saveImage, type StoredImage } from "./images";
import { downloadContent, getDisplayName } from "./line";
import { generateDraft, type DraftResult, type HistoryTurn } from "./openai";
import { notifyQuestion } from "./telegram";
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

    await this.processBatch(userId, messages, alarmInfo?.retryCount ?? 0);

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
        // 還有重試機會就交給 alarm 重試；最後一次仍失敗才存成「AI 失敗」並通知老師
        if (retryCount < LAST_RETRY) throw err;
        aiError = String(err).slice(0, 500);
      }

      question = await createQuestion(this.env, {
        batchId,
        studentLineId: userId,
        studentName: await getDisplayName(this.env, userId),
        questionText: text,
        imageIds: imageIds.slice(0, MAX_IMAGES),
        contextImageId: contextImage ? contextImageId : null,
        result,
        aiError,
        eventIds: messages.map((m) => m.webhookEventId),
        now: Date.now(),
      });
      log("question_saved", { questionId: question.id, kind: question.kind, aiStatus: question.ai_status, ...(result?.meta ?? {}) });
    }

    if (question.notified_at === null) {
      if (images.length === 0) images = await this.loadQuestionImages(question);
      await notifyQuestion(this.env, question, images);
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

  private async loadQuestionImages(q: QuestionRow): Promise<StoredImage[]> {
    const ids = JSON.parse(q.image_ids) as string[];
    const loaded = await Promise.all(ids.map((id) => loadImage(this.env, id)));
    return loaded.filter((img): img is StoredImage => img !== null);
  }
}
