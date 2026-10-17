// Telegram 通知：所有動態內容都經過 escapeHtml；圖片 caption 為純文字（不設 parse_mode）
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

async function callApi(env: Env, method: string, init: RequestInit): Promise<void> {
  const resp = await fetch(apiUrl(env, method), init);
  if (!resp.ok) {
    // 丟出例外讓 alarm 重試；錯誤訊息不含 token
    throw new Error(`Telegram ${method} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
}

export async function sendMessage(env: Env, html: string, buttons: UrlButton[] = []): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: html.slice(0, TEXT_LIMIT),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
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

function reviewUrl(env: Env, q: QuestionRow, generate = false): string {
  return `${env.APP_BASE_URL}/review/${q.id}${generate ? "?generate=1" : ""}`;
}

/**
 * 依提問狀態發通知：
 * - AI 失敗：警告，請老師直接處理
 * - 非英文問題：一行精簡通知 +「產生解答」按鈕
 * - 題目／需要補資訊：照片（若有）＋ AI 草稿 + 給老師的備註 +「前往審核」按鈕
 */
export async function notifyQuestion(env: Env, q: QuestionRow, images: StoredImage[]): Promise<void> {
  const name = escapeHtml(q.student_name);
  const questionLine = q.question_text ? `📝 ${escapeHtml(q.question_text)}` : "📷 （只有照片）";

  if (q.ai_status === "error") {
    for (const [i, img] of images.entries()) await sendPhoto(env, img, `📷 ${q.student_name}（${i + 1}/${images.length}）`);
    await sendMessage(env, `⚠️ <b>AI 處理失敗</b>｜${name}\n${questionLine}\n\n請老師直接處理`, [{ text: "📝 前往審核", url: reviewUrl(env, q) }]);
    return;
  }

  if (q.kind === "non_question") {
    const preview = escapeHtml(truncate(q.question_text ?? "（只有照片）", 50));
    await sendMessage(env, `💬 <b>${name}</b>：${preview}\n<i>判斷為非英文問題，未產生草稿</i>`, [
      { text: "🤖 產生解答", url: reviewUrl(env, q, true) },
    ]);
    return;
  }

  for (const [i, img] of images.entries()) await sendPhoto(env, img, `📷 ${q.student_name}（${i + 1}/${images.length}）`);

  const label = q.kind === "need_more_info" ? "（需要學生補資訊）" : "";
  const contextLine = q.context_image_id ? "\n📎 AI 有參考學生前面傳的照片" : "";
  const note = q.tutor_note && q.tutor_note !== "無" ? `\n\n📌 <b>給老師</b>：${escapeHtml(q.tutor_note)}` : "";
  const header = `📩 <b>${name}</b> 的提問\n${questionLine}${contextLine}\n━━━━━━━━━━\n🤖 <b>AI 草稿</b>${label}\n`;
  const button = [{ text: "📝 前往審核", url: reviewUrl(env, q) }];

  const chunks = splitText(q.ai_answer ?? "", CHUNK_SIZE);
  for (const [i, chunk] of chunks.entries()) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    const part = chunks.length > 1 ? `（${i + 1}/${chunks.length}）\n` : "";
    const body = `${isFirst ? header : ""}${part}${escapeHtml(chunk)}${isLast ? note : ""}`;
    await sendMessage(env, body, isLast ? button : []);
  }
}
