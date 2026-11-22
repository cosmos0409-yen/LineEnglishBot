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
  draft_version: number;
  merge_count: number;
  notify_kind: "new" | "update" | "upgrade";
  notify_note: string | null;
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

/** 這一批已經處理過（建立新題或併入某題）時，回傳那一題；用第一則訊息的連結判斷，alarm 重跑時不會重複處理。 */
export async function getQuestionByEvent(env: Env, eventId: string): Promise<QuestionRow | null> {
  return env.DB.prepare("SELECT q.* FROM messages m JOIN questions q ON q.id = m.question_id WHERE m.event_id = ?").bind(eventId).first<QuestionRow>();
}

// 老師還沒處理、和學生上一則訊息相隔在這個時間內，新訊息就併入同一題
export const MERGE_WINDOW_MS = 10 * 60 * 1000;

/**
 * 找可以併入的題目：必須是這位學生「最新的一題」，還在等待審核、沒有任何老師按過通過，
 * 而且這一批的第一則訊息和那一題最後一則學生訊息相隔不超過 10 分鐘。
 */
export async function findMergeTarget(env: Env, studentLineId: string, batchFirstTs: number): Promise<QuestionRow | null> {
  const latest = await env.DB.prepare("SELECT * FROM questions WHERE student_line_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(studentLineId)
    .first<QuestionRow & { approver_cheng_jie: number; approver_tutor: number }>();
  if (!latest || latest.status !== "pending" || latest.approver_cheng_jie || latest.approver_tutor) return null;
  const last = await env.DB.prepare("SELECT MAX(ts) AS ts FROM messages WHERE question_id = ? AND role = 'student'")
    .bind(latest.id)
    .first<{ ts: number | null }>();
  const lastTs = last?.ts ?? latest.created_at;
  return batchFirstTs - lastTs <= MERGE_WINDOW_MS ? latest : null;
}

/** 這一題所有學生訊息（由舊到新），併入後重寫草稿時用。 */
export async function getQuestionMessages(env: Env, questionId: string): Promise<{ type: string; text: string | null; image_id: string | null; ts: number }[]> {
  const { results } = await env.DB.prepare("SELECT type, text, image_id, ts FROM messages WHERE question_id = ? AND role = 'student' ORDER BY ts")
    .bind(questionId)
    .run<{ type: string; text: string | null; image_id: string | null; ts: number }>();
  return results;
}

export interface MergeUpdate {
  questionText: string | null;
  imageIds: string[];
  contextImageId: string | null;
  result: DraftResult | null; // null = AI 失敗：保留原本的草稿，只記錄錯誤
  aiError: string | null;
  notifyKind: QuestionRow["notify_kind"];
  notifyNote: string | null;
  eventIds: string[];
  now: number;
}

/**
 * 把一批訊息併入既有題目並寫回新草稿（同一個交易）。
 * 只有草稿版本沒變、還在等待審核、沒有老師按過通過時才會成功；否則回傳 null，由呼叫端改成建立新題。
 * 併入前還沒有老師處理，所以 final_answer 一定還是 AI 原稿，直接換成新草稿。
 */
export async function mergeIntoQuestion(env: Env, target: QuestionRow, m: MergeUpdate): Promise<QuestionRow | null> {
  const d = m.result?.draft ?? null;
  const update = d
    ? env.DB.prepare(
        `UPDATE questions
            SET question_text = ?, image_ids = ?, context_image_id = ?,
                kind = ?, ai_status = 'ok', ai_error = NULL, ai_answer = ?, tutor_note = ?, confidence = ?, ai_meta = ?, final_answer = ?,
                draft_version = draft_version + 1, merge_count = merge_count + 1,
                notified_at = NULL, notify_attempts = 0, notify_attempt_at = NULL, notify_error = NULL, notify_kind = ?, notify_note = ?, updated_at = ?
          WHERE id = ? AND status = 'pending' AND approver_cheng_jie = 0 AND approver_tutor = 0 AND draft_version = ?
          RETURNING id`,
      ).bind(
        m.questionText,
        JSON.stringify(m.imageIds),
        m.contextImageId,
        d.kind,
        d.answer,
        d.tutor_note,
        d.confidence,
        JSON.stringify(m.result!.meta),
        d.answer,
        m.notifyKind,
        m.notifyNote,
        m.now,
        target.id,
        target.draft_version,
      )
    : env.DB.prepare(
        `UPDATE questions
            SET question_text = ?, image_ids = ?, context_image_id = ?, ai_status = 'error', ai_error = ?,
                draft_version = draft_version + 1, merge_count = merge_count + 1,
                notified_at = NULL, notify_attempts = 0, notify_attempt_at = NULL, notify_error = NULL, notify_kind = ?, notify_note = ?, updated_at = ?
          WHERE id = ? AND status = 'pending' AND approver_cheng_jie = 0 AND approver_tutor = 0 AND draft_version = ?
          RETURNING id`,
      ).bind(m.questionText, JSON.stringify(m.imageIds), m.contextImageId, m.aiError, m.notifyKind, m.notifyNote, m.now, target.id, target.draft_version);
  const placeholders = m.eventIds.map(() => "?").join(",");
  // 連結訊息只在更新成功時生效：WHERE 再確認一次題目已是新版本
  const link = env.DB.prepare(
    `UPDATE messages SET question_id = ? WHERE event_id IN (${placeholders})
       AND EXISTS (SELECT 1 FROM questions WHERE id = ? AND draft_version = ?)`,
  ).bind(target.id, ...m.eventIds, target.id, target.draft_version + 1);
  const [res] = await env.DB.batch([update, link]);
  if (res.results.length === 0) return null;
  return env.DB.prepare("SELECT * FROM questions WHERE id = ?").bind(target.id).first<QuestionRow>();
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
