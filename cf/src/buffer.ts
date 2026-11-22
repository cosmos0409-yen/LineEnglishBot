import { DurableObject } from "cloudflare:workers";
import {
  claimNotify,
  createQuestion,
  findMergeTarget,
  getHistory,
  getQuestionByBatch,
  getQuestionByEvent,
  getQuestionMessages,
  markNotified,
  mergeIntoQuestion,
  recordNotifyError,
  recordStudentMessages,
  type QuestionRow,
} from "./db";
import { loadImage, saveImage, type StoredImage } from "./images";
import { downloadContent, getDisplayName } from "./line";
import { AI_ERROR_REASON, AiError, generateDraft, type AiErrorKind, type DraftInput, type DraftResult, type HistoryTurn } from "./openai";
import { claimFallbackWarning, type AiConfigInput } from "./settings";
import { getQuestion, saveRegeneratedDraft } from "./review";
import { getStudent, studentLabel, upsertStudent } from "./students";
import { notifyModelFallback, notifyQuestion } from "./telegram";
import { bufferDelaySeconds, bytesToBase64, isSocialOnly, truncate } from "./text";

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
 * 上一題老師還沒處理、和上一則訊息相隔 10 分鐘內 → 併入同一題並重寫草稿（只發一行靜音的補充通知）。
 * alarm 丟出例外時 Cloudflare 會自動重試（最多 6 次），訊息不會遺失。
 * 每一步都可重跑：訊息以 event_id 去重、已連到題目的批次不重複處理、已通知的不重發。
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
    // 只有照片、還沒打字時多等一下：學生常常傳完照片才開始打說明
    const types = this.ctx.storage.sql.exec<{ body: string }>(`SELECT body FROM pending`).toArray().map((r) => (JSON.parse(r.body) as BufferedMessage).type);
    const seconds = bufferDelaySeconds(types, Number(this.env.BUFFER_SECONDS) || 30);
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
    let processed: { question: QuestionRow; images: StoredImage[] } | null;
    try {
      processed = await this.processBatch(userId, messages, retryCount);
    } catch (err) {
      // 記下是哪一批、第幾次重試、錯在哪，再丟出讓 alarm 重試
      console.log(JSON.stringify({ event: "batch_failed", userId, batchId: messages[0].webhookEventId, retryCount, error: String(err).slice(0, 500) }));
      throw err;
    }

    // 題目存好就清掉這一批：Telegram 通知失敗不能卡住學生之後傳的訊息（失敗的通知由排程補發）
    this.ctx.storage.sql.exec(`DELETE FROM pending WHERE seq <= ?`, maxSeq);
    if (processed) await this.notify(processed.question, processed.images);
  }

  /** 排程補發：通知失敗的題目每 5 分鐘再試一次。 */
  async retryNotify(questionId: string): Promise<boolean> {
    const q = await getQuestion(this.env, questionId);
    return q ? this.notify(q) : false;
  }

  /**
   * 發 Telegram 通知。先取得發送權（避免排程與這裡同時發），失敗時把原因寫進資料庫、不丟例外。
   * 回傳是否這次發送成功。
   */
  private async notify(question: QuestionRow, images: StoredImage[] = []): Promise<boolean> {
    if (question.notified_at !== null || !(await claimNotify(this.env, question.id))) return false;
    const log = (event: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ event, questionId: question.id, attempt: question.notify_attempts + 1, ...extra }));
    try {
      // 補充通知只有一行文字，不重發照片
      if (images.length === 0 && question.notify_kind !== "update") images = await this.loadQuestionImages(question);
      // 通知用老師設定的備註名稱（沒設定就用 LINE 暱稱）
      const student = await getStudent(this.env, question.student_line_id);
      await notifyQuestion(this.env, question, images, student ? studentLabel(student) : question.student_name);
      await markNotified(this.env, question.id);
      log("telegram_notified");
      return true;
    } catch (err) {
      const error = String(err).slice(0, 500);
      log("telegram_notify_failed", { error });
      await recordNotifyError(this.env, question.id, error).catch(() => {});
      return false;
    }
  }

  /** 處理一批訊息，回傳要通知的題目（社交回應等不需要題目的批次回傳 null）。 */
  private async processBatch(userId: string, messages: BufferedMessage[], retryCount: number): Promise<{ question: QuestionRow; images: StoredImage[] } | null> {
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

    if (imageIds.length === 0 && text === null) {
      log("batch_skipped_no_content");
      return null;
    }
    if (isSocialOnly(text, imageIds.length > 0)) {
      log("batch_skipped_social", { text });
      return null;
    }

    // 已處理過（alarm 重跑）：直接回傳那一題，不重複呼叫 AI
    const done = (await getQuestionByEvent(this.env, batchId)) ?? (await getQuestionByBatch(this.env, batchId));
    if (done) return { question: done, images: [] };

    // 上一題老師還沒處理、10 分鐘內 → 併入同一題（學生常常先傳照片、隔一下才打字說明）
    const target = await findMergeTarget(this.env, userId, firstTs);
    if (target) {
      const merged = await this.mergeBatch(target, userId, messages, retryCount, log);
      if (merged) return merged;
      // AI 寫草稿的期間老師剛好按了通過或重寫草稿：改成另開一題
      log("merge_skipped_target_changed", { questionId: target.id });
    }

    const images = await this.fetchAndStoreImages(userId, imageIds.slice(0, MAX_IMAGES), retryCount);
    const { input, contextImageId, historyCount } = await this.buildDraftInput(userId, firstTs, text, images);
    log("batch_processing", { text, imageCount: images.length, historyCount, contextImage: Boolean(contextImageId) });
    const { result, aiError } = await this.draft(input, retryCount, log);

    const lineName = await getDisplayName(this.env, userId);
    await upsertStudent(this.env, userId, lineName);
    const question = await createQuestion(this.env, {
      batchId,
      studentLineId: userId,
      studentName: lineName,
      questionText: text,
      imageIds: imageIds.slice(0, MAX_IMAGES),
      contextImageId,
      result,
      aiError,
      eventIds: messages.map((m) => m.webhookEventId),
      now: Date.now(),
    });
    log("question_saved", { questionId: question.id, kind: question.kind, aiStatus: question.ai_status, ...(result?.meta ?? {}) });
    return { question, images };
  }

  /**
   * 把這一批併入老師還沒處理的上一題：用這一題「全部」的照片與文字重寫草稿，並決定下一則通知的格式。
   * 題目在 AI 寫草稿期間被老師處理了就回傳 null。
   */
  private async mergeBatch(
    target: QuestionRow,
    userId: string,
    messages: BufferedMessage[],
    retryCount: number,
    log: (event: string, extra?: Record<string, unknown>) => void,
  ): Promise<{ question: QuestionRow; images: StoredImage[] } | null> {
    const earlier = await getQuestionMessages(this.env, target.id);
    const all = [
      ...earlier.map((m) => ({ type: m.type, text: m.text, imageId: m.image_id, ts: m.ts })),
      ...messages.map((m) => ({ type: m.type, text: m.text, imageId: m.type === "image" ? m.messageId : null, ts: m.timestamp })),
    ].sort((a, b) => a.ts - b.ts);
    const allText = all.filter((m) => m.type === "text" && m.text).map((m) => m.text as string).join("\n") || null;
    const allImageIds = all.filter((m) => m.type === "image" && m.imageId).map((m) => m.imageId as string);
    const imageIds = allImageIds.slice(0, MAX_IMAGES);

    const images = await this.fetchAndStoreImages(userId, imageIds, retryCount);
    const { input, contextImageId, historyCount } = await this.buildDraftInput(userId, all[0].ts, allText, images);
    log("batch_merging", { questionId: target.id, imageCount: images.length, historyCount, mergeCount: target.merge_count + 1 });
    const { result, aiError } = await this.draft({ ...input, merged: true }, retryCount, log);

    // 補充通知要寫出這次補傳了什麼
    const addedImages = messages.filter((m) => m.type === "image").length;
    const addedText = messages.filter((m) => m.type === "text" && m.text).map((m) => m.text as string).join(" ");
    let note = [addedImages ? `照片 ${addedImages} 張` : "", addedText ? `「${truncate(addedText, 60)}」` : ""].filter(Boolean).join("＋");
    if (allImageIds.length > MAX_IMAGES) note += `（照片超過 ${MAX_IMAGES} 張，多的沒有給 AI 看）`;

    // 通知格式：第一則還沒發出去 → 照樣發完整的新提問；原本沒有草稿（非英文、AI 失敗）、補充後才有 → 完整通知；其他 → 靜音一行
    let notifyKind: QuestionRow["notify_kind"];
    if (target.notified_at === null && target.notify_kind === "new") {
      notifyKind = "new";
    } else {
      const hadDraft = target.ai_status === "ok" && target.kind !== "non_question";
      const hasDraft = result !== null && result.draft.kind !== "non_question";
      const pendingUpgrade = target.notified_at === null && target.notify_kind === "upgrade";
      notifyKind = (!hadDraft && hasDraft) || pendingUpgrade ? "upgrade" : "update";
      // 上一則補充通知還沒發出去：把兩次補傳的內容合在一起
      if (target.notified_at === null && target.notify_note) note = `${target.notify_note}；${note}`;
    }

    const question = await mergeIntoQuestion(this.env, target, {
      questionText: allText,
      imageIds,
      contextImageId,
      result,
      aiError,
      notifyKind,
      notifyNote: note,
      eventIds: messages.map((m) => m.webhookEventId),
      now: Date.now(),
    });
    if (!question) return null;
    log("question_merged", { questionId: question.id, kind: question.kind, aiStatus: question.ai_status, notifyKind, ...(result?.meta ?? {}) });
    return { question, images };
  }

  /** 組 AI 的輸入：beforeTs 之前 60 分鐘內的前文；這次沒有照片時補上前文最近的一張。 */
  private async buildDraftInput(userId: string, beforeTs: number, text: string | null, images: StoredImage[]) {
    const history = await getHistory(this.env, userId, beforeTs, HISTORY_WINDOW_MS, HISTORY_LIMIT);
    const ctxId = images.length === 0 ? ([...history].reverse().find((h) => h.imageId)?.imageId ?? null) : null;
    const contextImage = ctxId ? await loadImage(this.env, ctxId) : null;
    const turns: HistoryTurn[] = history.map((h) => ({
      role: h.role,
      text: h.text,
      hadImage: Boolean(h.imageId),
      minutesAgo: Math.max(1, Math.round((beforeTs - h.ts) / 60000)),
    }));
    const input: DraftInput = {
      text,
      images: images.map((img) => ({ base64: bytesToBase64(img.bytes), contentType: img.contentType })),
      history: turns,
      contextImage: contextImage ? { base64: bytesToBase64(contextImage.bytes), contentType: contextImage.contentType } : null,
    };
    return { input, contextImageId: contextImage ? ctxId : null, historyCount: turns.length };
  }

  /**
   * 呼叫 AI。金鑰失效、額度用完、模型設定錯：重試也不會好 → 回傳 aiError（存成「AI 失敗」並通知老師，寫明原因）；
   * 其他（OpenAI 暫時故障、網路問題）：丟出讓 alarm 重試，最後一次仍失敗才回傳 aiError。
   */
  private async draft(
    input: DraftInput,
    retryCount: number,
    log: (event: string, extra?: Record<string, unknown>) => void,
  ): Promise<{ result: DraftResult | null; aiError: string | null }> {
    try {
      const result = await generateDraft(this.env, input);
      // 設定的模型不能用、已自動改用預設模型：提醒老師1更新設定（一小時最多一次；提醒失敗不影響這一題）
      if (result.meta.modelFallbackFrom && (await claimFallbackWarning(this.env))) {
        await notifyModelFallback(this.env, result.meta.modelFallbackFrom, result.meta.model).catch((e) =>
          log("fallback_warning_failed", { error: String(e).slice(0, 200) }),
        );
      }
      return { result, aiError: null };
    } catch (err) {
      const retryable = !(err instanceof AiError) || err.retryable;
      if (retryable && retryCount < LAST_RETRY) throw err;
      const aiError = (err instanceof AiError ? err.message : `${AI_ERROR_REASON.unknown}｜${String(err)}`).slice(0, 500);
      log("ai_failed", { kind: err instanceof AiError ? err.kind : "unknown", retryable, aiError });
      return { result: null, aiError };
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
