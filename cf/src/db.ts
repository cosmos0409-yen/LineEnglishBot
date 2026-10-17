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
  await env.DB.prepare("UPDATE questions SET notified_at = ? WHERE id = ? AND notified_at IS NULL").bind(now, questionId).run();
}
