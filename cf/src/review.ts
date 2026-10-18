// 審核流程：原子化審核、推播（可重送、不重複）、標已讀、待審核清單
import type { Role } from "./auth";
import type { QuestionRow } from "./db";
import { markAsRead, pushText } from "./line";
import type { DraftResult } from "./openai";

export interface ReviewQuestion extends QuestionRow {
  ai_meta: string | null;
  approver_cheng_jie: number;
  approver_tutor: number;
  direct_approved: number;
  push_retry_key: string | null;
  push_error: string | null;
  read_marked_at: number | null;
  dismissed_by: string | null;
  dismissed_at: number | null;
  sent_at: number | null;
  // 來自 students（老師設定的備註名稱、班級；可能為 NULL）
  student_display_name: string | null;
  student_class: string | null;
}

const WITH_STUDENT = `SELECT q.*, s.display_name AS student_display_name, s.class_name AS student_class
  FROM questions q LEFT JOIN students s ON s.line_id = q.student_line_id`;

export interface ContextMessage {
  role: "student" | "teacher";
  type: string;
  text: string | null;
  image_id: string | null;
  question_id: string | null;
  ts: number;
}

const CONTEXT_WINDOW_MS = 60 * 60 * 1000;

export async function getQuestion(env: Env, id: string): Promise<ReviewQuestion | null> {
  return env.DB.prepare(`${WITH_STUDENT} WHERE q.id = ?`).bind(id).first<ReviewQuestion>();
}

/** 待處理（等待審核、推播失敗）＋最近完成的 10 筆；可只看某位學生。 */
/** 待處理的條件：等待審核、推播中、推播失敗，但不含 AI 判斷為非英文問題、還沒人處理的訊息。 */
export const OPEN_CONDITION = `q.status IN ('pending', 'approved', 'push_failed') AND NOT (q.status = 'pending' AND q.kind = 'non_question')`;

export interface QueueLists {
  open: ReviewQuestion[];
  /** AI 判斷為非英文問題、還沒人處理（清單上收合顯示，不算在待處理） */
  others: ReviewQuestion[];
  recent: ReviewQuestion[];
}

/** 待處理＋非英文訊息＋最近送出；可只看某位學生。 */
export async function listQueue(env: Env, studentLineId: string | null = null): Promise<QueueLists> {
  const filter = studentLineId ? " AND q.student_line_id = ?" : "";
  const bind = (stmt: D1PreparedStatement) => (studentLineId ? stmt.bind(studentLineId) : stmt);
  const [open, others, recent] = await env.DB.batch<ReviewQuestion>([
    bind(env.DB.prepare(`${WITH_STUDENT} WHERE ${OPEN_CONDITION}${filter} ORDER BY q.created_at DESC LIMIT 100`)),
    bind(env.DB.prepare(`${WITH_STUDENT} WHERE q.status = 'pending' AND q.kind = 'non_question'${filter} ORDER BY q.created_at DESC LIMIT 100`)),
    bind(env.DB.prepare(`${WITH_STUDENT} WHERE q.status = 'sent'${filter} ORDER BY q.sent_at DESC LIMIT 10`)),
  ]);
  return { open: open.results, others: others.results, recent: recent.results };
}

/** 標記「不需回覆」：只有還在等待審核的才能標記（已推播的不受影響）。 */
export async function dismiss(env: Env, id: string, role: Role, now = Date.now()): Promise<boolean> {
  const row = await env.DB.prepare(
    "UPDATE questions SET status = 'dismissed', dismissed_by = ?, dismissed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' RETURNING id",
  )
    .bind(role, now, now, id)
    .first();
  return Boolean(row);
}

/** 一次把所有（或某位學生的）非英文訊息標記為不需回覆，回傳筆數。 */
export async function dismissAllNonQuestions(env: Env, role: Role, studentLineId: string | null, now = Date.now()): Promise<number> {
  const filter = studentLineId ? " AND student_line_id = ?" : "";
  const stmt = env.DB.prepare(
    `UPDATE questions SET status = 'dismissed', dismissed_by = ?, dismissed_at = ?, updated_at = ?
      WHERE status = 'pending' AND kind = 'non_question'${filter}`,
  );
  const res = await (studentLineId ? stmt.bind(role, now, now, studentLineId) : stmt.bind(role, now, now)).run();
  return res.meta.changes ?? 0;
}

/** 改回待處理（標錯時用）。 */
export async function reopen(env: Env, id: string, now = Date.now()): Promise<boolean> {
  const row = await env.DB.prepare(
    "UPDATE questions SET status = 'pending', dismissed_by = NULL, dismissed_at = NULL, updated_at = ? WHERE id = ? AND status = 'dismissed' RETURNING id",
  )
    .bind(now, id)
    .first();
  return Boolean(row);
}

/** 這一題之前 60 分鐘內的對話，加上這一題本身的訊息（由舊到新）。 */
export async function getContextMessages(env: Env, q: ReviewQuestion): Promise<ContextMessage[]> {
  const { results } = await env.DB.prepare(
    `SELECT role, type, text, image_id, question_id, ts FROM messages
      WHERE student_line_id = ? AND ts >= ? AND (ts <= ? OR question_id = ?)
      ORDER BY ts`,
  )
    .bind(q.student_line_id, q.created_at - CONTEXT_WINDOW_MS, q.created_at, q.id)
    .run<ContextMessage>();
  return results;
}

export type ApproveOutcome =
  | { kind: "approved"; question: ReviewQuestion } // 兩位都通過（或直接通過）→ 呼叫端負責推播
  | { kind: "waiting"; question: ReviewQuestion } // 還在等另一位
  | { kind: "rejected"; reason: "not_found" | "already_done" | "already_approved_by_you" | "empty_answer" | "direct_not_allowed" };

/**
 * 原子化審核：同一個 UPDATE 同時檢查狀態與「我還沒審過」，再決定是否轉成 approved。
 * 兩位同時按也只會有一個請求拿到 approved，所以只會推播一次，也不會卡在 1/2。
 */
export async function approve(env: Env, id: string, role: Role, finalAnswer: string, direct: boolean, now = Date.now()): Promise<ApproveOutcome> {
  if (!finalAnswer.trim()) return { kind: "rejected", reason: "empty_answer" };
  if (direct && role !== "cheng_jie") return { kind: "rejected", reason: "direct_not_allowed" };

  const mine = role === "cheng_jie" ? "approver_cheng_jie" : "approver_tutor";
  const other = role === "cheng_jie" ? "approver_tutor" : "approver_cheng_jie";
  const row = await env.DB.prepare(
    `UPDATE questions
        SET ${mine} = 1,
            final_answer = ?,
            direct_approved = CASE WHEN ? = 1 THEN 1 ELSE direct_approved END,
            status = CASE WHEN ${other} = 1 OR ? = 1 THEN 'approved' ELSE 'pending' END,
            updated_at = ?
      WHERE id = ? AND status = 'pending' AND ${mine} = 0
      RETURNING *`,
  )
    .bind(finalAnswer.trim(), direct ? 1 : 0, direct ? 1 : 0, now, id)
    .first<ReviewQuestion>();

  if (row) return row.status === "approved" ? { kind: "approved", question: row } : { kind: "waiting", question: row };

  const current = await getQuestion(env, id);
  if (!current) return { kind: "rejected", reason: "not_found" };
  if (current.status !== "pending") return { kind: "rejected", reason: "already_done" };
  return { kind: "rejected", reason: "already_approved_by_you" };
}

export type DeliverOutcome = { ok: true } | { ok: false; error: string };

/**
 * 推播最終解答給學生（approved 或 push_failed 狀態才會送）。
 * retry key 第一次產生後就固定保存，重送時沿用 → LINE 24 小時內不會重複發送。
 */
export async function deliver(env: Env, id: string, now = Date.now()): Promise<DeliverOutcome> {
  const keyRow = await env.DB.prepare(
    `UPDATE questions SET push_retry_key = COALESCE(push_retry_key, ?)
      WHERE id = ? AND status IN ('approved', 'push_failed')
      RETURNING push_retry_key, student_line_id, final_answer`,
  )
    .bind(crypto.randomUUID(), id)
    .first<{ push_retry_key: string; student_line_id: string; final_answer: string }>();
  if (!keyRow) return { ok: false, error: "這一題目前不是可推播的狀態" };

  const result = await pushText(env, keyRow.student_line_id, keyRow.final_answer, keyRow.push_retry_key);
  if (!result.ok) {
    const error = `LINE ${result.status}: ${result.error}`;
    await env.DB.prepare("UPDATE questions SET status = 'push_failed', push_error = ?, updated_at = ? WHERE id = ?").bind(error, now, id).run();
    console.log(JSON.stringify({ event: "push_failed", questionId: id, status: result.status }));
    return { ok: false, error };
  }

  // 已送出：狀態改 sent，並把老師的解答記成對話紀錄（之後的追問會當成前文）
  await env.DB.batch([
    env.DB.prepare("UPDATE questions SET status = 'sent', sent_at = ?, push_error = NULL, updated_at = ? WHERE id = ?").bind(now, now, id),
    env.DB.prepare(
      `INSERT INTO messages (event_id, student_line_id, role, type, text, question_id, ts)
       VALUES (NULL, ?, 'teacher', 'text', ?, ?, ?)`,
    ).bind(keyRow.student_line_id, keyRow.final_answer, id, now),
  ]);
  console.log(JSON.stringify({ event: "push_sent", questionId: id, duplicate: result.duplicate }));
  return { ok: true };
}

/** 老師第一次打開審核頁時標已讀（只做一次；失敗不影響流程）。 */
export async function markReadOnce(env: Env, q: ReviewQuestion, now = Date.now()): Promise<void> {
  if (q.read_marked_at) return;
  const claimed = await env.DB.prepare("UPDATE questions SET read_marked_at = ? WHERE id = ? AND read_marked_at IS NULL RETURNING id")
    .bind(now, q.id)
    .first();
  if (!claimed) return;
  const tokenRow = await env.DB.prepare(
    "SELECT mark_as_read_token AS token FROM messages WHERE question_id = ? AND mark_as_read_token IS NOT NULL ORDER BY ts DESC LIMIT 1",
  )
    .bind(q.id)
    .first<{ token: string }>();
  if (!tokenRow) return;
  const ok = await markAsRead(env, tokenRow.token);
  console.log(JSON.stringify({ event: "mark_as_read", questionId: q.id, ok }));
}

/** 老師按「產生解答」後寫回草稿；老師已經改過的最終解答不會被覆蓋。 */
export async function saveRegeneratedDraft(env: Env, id: string, result: DraftResult, now = Date.now()): Promise<void> {
  const d = result.draft;
  await env.DB.prepare(
    `UPDATE questions
        SET kind = ?, ai_status = 'ok', ai_error = NULL, ai_answer = ?, tutor_note = ?, confidence = ?, ai_meta = ?,
            final_answer = CASE WHEN final_answer IS NULL OR final_answer = '' OR final_answer = ai_answer THEN ? ELSE final_answer END,
            updated_at = ?
      WHERE id = ?`,
  )
    .bind(d.kind, d.answer, d.tutor_note, d.confidence, JSON.stringify(result.meta), d.answer, now, id)
    .run();
}
