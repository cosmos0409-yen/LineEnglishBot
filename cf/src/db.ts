// 主資料庫（DB）：提問與對話紀錄
import type { Draft, DraftResult } from "./openai";

export interface QuestionRow {
  id: string;
  batch_id: string;
  student_line_id: string;
  student_name: string;
  question_text: string | null;
  image_ids: string;
  context_image_id: string | null;
  kind: Draft["kind"] | null;
  ai_status: "ok" | "error";
  ai_error: string | null;
  ai_answer: string | null;
  tutor_note: string | null;
  confidence: string | null;
  final_answer: string | null;
  status: string;
  notified_at: number | null;
  notify_attempts: number;
  notify_attempt_at: number | null;
  notify_error: string | null;
  created_at: number;
}

export interface StudentMessage {
  eventId: string;
  studentLineId: string;
  type: string;
  text: string | null;
  imageId: string | null;
  markAsReadToken: string | null;
  ts: number;
}

export interface HistoryItem {
  role: "student" | "teacher";
  type: string;
  text: string | null;
  imageId: string | null;
  ts: number;
}

/** 記錄學生訊息（以 event_id 去重，重試時不會重複）。 */
export async function recordStudentMessages(env: Env, msgs: StudentMessage[]): Promise<void> {
  if (msgs.length === 0) return;
  await env.DB.batch(
    msgs.map((m) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO messages (event_id, student_line_id, role, type, text, image_id, mark_as_read_token, ts)
         VALUES (?, ?, 'student', ?, ?, ?, ?, ?)`,
      ).bind(m.eventId, m.studentLineId, m.type, m.text, m.imageId, m.markAsReadToken, m.ts),
    ),
  );
}

/** 本批之前、時間窗內的對話（由舊到新）。 */
export async function getHistory(env: Env, studentLineId: string, beforeTs: number, windowMs: number, limit: number): Promise<HistoryItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT role, type, text, image_id AS imageId, ts FROM messages
      WHERE student_line_id = ? AND ts < ? AND ts >= ?
      ORDER BY ts DESC LIMIT ?`,
  )
    .bind(studentLineId, beforeTs, beforeTs - windowMs, limit)
    .run<HistoryItem>();
  return results.reverse();
}

export async function getQuestionByBatch(env: Env, batchId: string): Promise<QuestionRow | null> {
  return env.DB.prepare("SELECT * FROM questions WHERE batch_id = ?").bind(batchId).first<QuestionRow>();
}

export interface NewQuestion {
  batchId: string;
  studentLineId: string;
  studentName: string;
  questionText: string | null;
  imageIds: string[];
  contextImageId: string | null;
  result: DraftResult | null; // null = AI 重試到最後仍失敗
  aiError: string | null;
  eventIds: string[];
  now: number;
}

/** 建立提問（batch_id 唯一，重試時回傳既有那筆），並把本批訊息連到這筆提問。 */
export async function createQuestion(env: Env, q: NewQuestion): Promise<QuestionRow> {
  const draft = q.result?.draft ?? null;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO questions
       (id, batch_id, student_line_id, student_name, question_text, image_ids, context_image_id,
        kind, ai_status, ai_error, ai_answer, tutor_note, confidence, ai_meta, final_answer, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      q.batchId,
      q.studentLineId,
      q.studentName,
      q.questionText,
      JSON.stringify(q.imageIds),
      q.contextImageId,
      draft?.kind ?? null,
      draft ? "ok" : "error",
      q.aiError,
      draft?.answer ?? null,
      draft?.tutor_note ?? null,
      draft?.confidence ?? null,
      q.result ? JSON.stringify(q.result.meta) : null,
      draft?.answer ?? null,
      q.now,
    )
    .run();

  const row = (await getQuestionByBatch(env, q.batchId))!;
  const placeholders = q.eventIds.map(() => "?").join(",");
  await env.DB.prepare(`UPDATE messages SET question_id = ? WHERE event_id IN (${placeholders})`)
    .bind(row.id, ...q.eventIds)
    .run();
  return row;
}

export async function markNotified(env: Env, questionId: string, now = Date.now()): Promise<void> {
  await env.DB.prepare("UPDATE questions SET notified_at = ?, notify_error = NULL WHERE id = ? AND notified_at IS NULL").bind(now, questionId).run();
}

// 一次發送最多等 Telegram 限流約 1 分鐘；租約要比這長，才不會發到一半被排程搶去重發
export const NOTIFY_LEASE_MS = 3 * 60 * 1000;
// 超過 2 天還發不出去就不再補發（題目仍在審核頁的待處理清單上）
export const NOTIFY_GIVE_UP_MS = 2 * 24 * 60 * 60 * 1000;

/** 取得發送通知的權利：還沒通知成功、且沒有人正在發（或上一次已超過租約）時才回傳 true。 */
export async function claimNotify(env: Env, questionId: string, now = Date.now()): Promise<boolean> {
  const row = await env.DB.prepare(
    `UPDATE questions SET notify_attempts = notify_attempts + 1, notify_attempt_at = ?
      WHERE id = ? AND notified_at IS NULL AND (notify_attempt_at IS NULL OR notify_attempt_at < ?)
      RETURNING id`,
  )
    .bind(now, questionId, now - NOTIFY_LEASE_MS)
    .first();
  return Boolean(row);
}

/** 記下失敗原因並放掉租約：下一次排程就能再試（租約只用來擋「正在發」的重複）。 */
export async function recordNotifyError(env: Env, questionId: string, error: string): Promise<void> {
  await env.DB.prepare("UPDATE questions SET notify_error = ?, notify_attempt_at = NULL WHERE id = ?").bind(error.slice(0, 500), questionId).run();
}

/** 排程補發用：2 天內、還沒通知成功、目前沒有人正在發的題目（由舊到新）。 */
export async function listUnnotified(env: Env, now = Date.now(), limit = 20): Promise<{ id: string; student_line_id: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, student_line_id FROM questions
      WHERE notified_at IS NULL AND created_at > ? AND (notify_attempt_at IS NULL OR notify_attempt_at < ?)
      ORDER BY created_at LIMIT ?`,
  )
    .bind(now - NOTIFY_GIVE_UP_MS, now - NOTIFY_LEASE_MS, limit)
    .run<{ id: string; student_line_id: string }>();
  return results;
}
