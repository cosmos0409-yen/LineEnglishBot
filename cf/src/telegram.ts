// Telegram 通知：所有動態內容都經過 escapeHtml；圖片 caption 為純文字（不設 parse_mode）
// 不用 Emoji：以粗體標題與文字標籤分段（Telegram 無法顯示自訂線條圖示）
import type { QuestionRow } from "./db";
import type { StoredImage } from "./images";
import { escapeHtml, splitText, truncate } from "./text";

const DEFAULT_API_BASE = "https://api.telegram.org";
const TEXT_LIMIT = 4096;
const CHUNK_SIZE = 3000; // 預留標頭、按鈕與跳脫字元的空間

interface UrlButton {
  text: string;
  url: string;
}

function apiUrl(env: Env, method: string): string {
  return `${env.TELEGRAM_API_BASE || DEFAULT_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

// 被限流（429）時照 Telegram 指定的秒數等待後重送；等太久的交給排程稍後補發
const MAX_RETRY_AFTER_S = 30;
const MAX_RATE_LIMIT_RETRIES = 2;

async function callApi(env: Env, method: string, init: RequestInit): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(apiUrl(env, method), init);
    if (resp.ok) return;
    const text = await resp.text();
    if (resp.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      let retryAfter: number | undefined;
      try {
        retryAfter = (JSON.parse(text) as { parameters?: { retry_after?: number } }).parameters?.retry_after;
      } catch {
        // 回應不是 JSON：當作沒有指定秒數
      }
      if (retryAfter !== undefined && retryAfter <= MAX_RETRY_AFTER_S) {
        console.log(JSON.stringify({ event: "telegram_rate_limited", method, retryAfter, attempt }));
        await new Promise((r) => setTimeout(r, retryAfter * 1000 + 200));
        continue;
      }
    }
    // 錯誤訊息不含 token
    throw new Error(`Telegram ${method} ${resp.status}: ${text.slice(0, 200)}`);
  }
}

export async function sendMessage(env: Env, html: string, buttons: UrlButton[] = [], silent = false): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: html.slice(0, TEXT_LIMIT),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  // 靜音：群組成員仍看得到訊息，但手機通知不發出聲音
  if (silent) body.disable_notification = true;
  if (buttons.length > 0) body.reply_markup = { inline_keyboard: [buttons.map((b) => ({ text: b.text, url: b.url }))] };
  await callApi(env, "sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function sendPhoto(env: Env, img: StoredImage, caption: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", env.TELEGRAM_CHAT_ID);
  form.append("caption", truncate(caption, 1000));
  form.append("photo", new Blob([img.bytes], { type: img.contentType }), "question.jpg");
  await callApi(env, "sendPhoto", { method: "POST", body: form });
}

/** 老師1 設定的模型無法使用、已自動改用預設模型時提醒（呼叫端負責頻率限制）。 */
export async function notifyModelFallback(env: Env, from: string, to: string): Promise<void> {
  await sendMessage(
    env,
    `<b>AI 模型自動切換</b>\n設定的模型 ${escapeHtml(from)} 目前無法使用，已暫時改用預設模型 ${escapeHtml(to)}，學生照常收到解答。\n請到 AI 設定頁更新模型。`,
    [{ text: "前往 AI 設定", url: `${env.APP_BASE_URL}/settings` }],
  );
}

function reviewUrl(env: Env, q: QuestionRow, generate = false): string {
  return `${env.APP_BASE_URL}/review/${q.id}${generate ? "?generate=1" : ""}`;
}

/**
 * 依提問狀態發通知：
 * - 學生補傳內容、已併入這一題（notify_kind = update）：靜音一行，寫出補傳了什麼
 * - AI 失敗：警告，請老師直接處理
 * - 非英文問題：精簡通知 +「產生解答」按鈕
 * - 題目／需要補資訊：照片（若有）＋ AI 草稿 + 給老師的備註 +「前往審核」按鈕
 */
export async function notifyQuestion(env: Env, q: QuestionRow, images: StoredImage[], studentName: string): Promise<void> {
  const name = escapeHtml(studentName);
  const questionLine = q.question_text ? `問題：${escapeHtml(q.question_text)}` : "問題：（只傳了照片）";
  const photoCaption = (i: number) => `${studentName} 的照片（${i + 1}/${images.length}）`;

  if (q.notify_kind === "update") {
    const status =
      q.ai_status === "error"
        ? `AI 重寫草稿失敗：${escapeHtml((q.ai_error ?? "原因不明").split("｜")[0])}，請到審核頁重新產生`
        : q.kind === "non_question"
          ? "AI 仍判斷不是英文問題"
          : "草稿已更新";
    await sendMessage(env, `<b>補充｜${name}</b>　${escapeHtml(q.notify_note ?? "補傳了內容")}\n<i>${status}</i>`, [{ text: "前往審核", url: reviewUrl(env, q) }], true);
    return;
  }
  // 原本是非英文訊息或 AI 失敗、學生補充後才有草稿：照新提問的格式完整通知，標註是補充後的
  const upgraded = q.notify_kind === "upgrade" ? "（學生補充後）" : "";

  if (q.ai_status === "error") {
    for (const [i, img] of images.entries()) await sendPhoto(env, img, photoCaption(i));
    // ai_error 格式：「給老師看的原因｜技術細節」，通知只放原因
    const reason = escapeHtml((q.ai_error ?? "原因不明").split("｜")[0]);
    await sendMessage(env, `<b>AI 處理失敗｜${name}</b>\n${questionLine}\n\n原因：${reason}\n修正後可在審核頁按「重新產生 AI 草稿」，或直接手寫解答`, [
      { text: "前往審核", url: reviewUrl(env, q) },
    ]);
    return;
  }

  if (q.kind === "non_question") {
    const preview = escapeHtml(truncate(q.question_text ?? "（只傳了照片）", 50));
    await sendMessage(env, `<b>非英文問題｜${name}</b>\n${preview}\n<i>未產生草稿</i>`, [
      { text: "產生解答", url: reviewUrl(env, q, true) },
    ]);
    return;
  }

  for (const [i, img] of images.entries()) await sendPhoto(env, img, photoCaption(i));

  const label = q.kind === "need_more_info" ? "（需要學生補資訊）" : "";
  const contextLine = q.context_image_id ? "\n<i>AI 有參考學生前面傳的照片</i>" : "";
  const note = q.tutor_note && q.tutor_note !== "無" ? `\n\n<b>給老師</b>：${escapeHtml(q.tutor_note)}` : "";
  const header = `<b>新提問${upgraded}｜${name}</b>\n${questionLine}${contextLine}\n──────────\n<b>AI 草稿</b>${label}\n`;
  const button = [{ text: "前往審核", url: reviewUrl(env, q) }];

  const chunks = splitText(q.ai_answer ?? "", CHUNK_SIZE);
  for (const [i, chunk] of chunks.entries()) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    const part = chunks.length > 1 ? `（${i + 1}/${chunks.length}）\n` : "";
    const body = `${isFirst ? header : ""}${part}${escapeHtml(chunk)}${isLast ? note : ""}`;
    await sendMessage(env, body, isLast ? button : []);
  }
}
