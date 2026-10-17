import { DurableObject } from "cloudflare:workers";
import { downloadContent, getDisplayName } from "./line";
import { generateDraft } from "./openai";
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
// Cloudflare alarm 丟出例外後最多重試 6 次（retryCount 0 是第一次執行）
const LAST_RETRY = 6;

/**
 * 每位學生一個實例（以 LINE userId 命名）。
 * enqueue：存訊息並把 alarm 重設為 N 秒後 → 同一學生連續傳的訊息合併成一批。
 * alarm：只處理「當下快照」的訊息，成功後才刪除；處理中途新進來的訊息留給下一個 alarm。
 * alarm 丟出例外時 Cloudflare 會自動重試（最多 6 次），訊息不會遺失。
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
    const texts = messages.filter((m) => m.type === "text" && m.text).map((m) => m.text as string);
    const imageIds = messages.filter((m) => m.type === "image").map((m) => m.messageId);
    const others = messages.filter((m) => m.type !== "text" && m.type !== "image").map((m) => m.type);
    const text = texts.length > 0 ? texts.join("\n") : null;

    const log = (event: string, extra: Record<string, unknown>) =>
      console.log(JSON.stringify({ event, userId, batchSize: messages.length, retryCount, ...extra }));

    if (imageIds.length === 0 && text === null) {
      log("batch_skipped_no_content", { others });
      return;
    }
    if (isSocialOnly(text, imageIds.length > 0)) {
      log("batch_skipped_social", { text });
      return;
    }

    const displayName = await getDisplayName(this.env, userId);

    const images: { base64: string; contentType: string }[] = [];
    let missingImages = 0;
    for (const id of imageIds.slice(0, MAX_IMAGES)) {
      const img = await downloadContent(this.env, id);
      if (img) images.push({ base64: bytesToBase64(img.bytes), contentType: img.contentType });
      else missingImages++;
    }
    // 圖片下載失敗時不能「少了圖片照樣解題」：先丟例外讓 alarm 重試，最後一次重試才不帶圖片繼續
    if (missingImages > 0 && retryCount < LAST_RETRY) {
      throw new Error(`圖片下載失敗 ${missingImages} 張，等待重試`);
    }

    log("batch_processing", {
      displayName,
      text,
      imageCount: images.length,
      missingImages,
      imageBytes: images.reduce((n, img) => n + img.base64.length, 0),
    });

    const result = await generateDraft(this.env, { text, images });

    // 第 1 階段只寫 Log；第 2 階段改為寫入 D1 並通知 Telegram
    log("draft_ready", {
      displayName,
      text,
      imageCount: images.length,
      droppedImages: Math.max(0, imageIds.length - MAX_IMAGES),
      ...result.meta,
      draft: result.draft,
    });
  }
}
