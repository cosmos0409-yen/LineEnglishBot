// 學生資料：老師設定的備註名稱、班級；學生清單與單一學生的提問紀錄

export interface StudentRow {
  line_id: string;
  line_name: string;
  display_name: string | null;
  class_name: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

export interface StudentListRow extends StudentRow {
  open_count: number;
  total_count: number;
}

export interface StudentQuestionRow {
  id: string;
  question_text: string | null;
  image_ids: string;
  kind: string | null;
  ai_status: string;
  status: string;
  final_answer: string | null;
  created_at: number;
  sent_at: number | null;
}

export const NAME_MAX = 30;
export const CLASS_MAX = 20;

/** 顯示用名稱：老師設定的備註名稱優先，否則用 LINE 暱稱。 */
export function studentLabel(s: { display_name?: string | null; line_name?: string | null; student_name?: string | null }): string {
  return s.display_name?.trim() || s.line_name || s.student_name || "未知用戶";
}

/** 每次有新提問時更新：記下最新的 LINE 暱稱與時間；老師設定的名稱、班級不動。 */
export async function upsertStudent(env: Env, lineId: string, lineName: string, now = Date.now()): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO students (line_id, line_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(line_id) DO UPDATE SET line_name = excluded.line_name, last_seen_at = excluded.last_seen_at`,
  )
    .bind(lineId, lineName, now, now)
    .run();
}

export async function getStudent(env: Env, lineId: string): Promise<StudentRow | null> {
  return env.DB.prepare("SELECT * FROM students WHERE line_id = ?").bind(lineId).first<StudentRow>();
}

export async function listStudents(env: Env): Promise<StudentListRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.*,
            (SELECT COUNT(*) FROM questions q WHERE q.student_line_id = s.line_id AND q.status IN ('pending', 'approved', 'push_failed')) AS open_count,
            (SELECT COUNT(*) FROM questions q WHERE q.student_line_id = s.line_id) AS total_count
       FROM students s
      ORDER BY open_count > 0 DESC, s.last_seen_at DESC
      LIMIT 500`,
  ).run<StudentListRow>();
  return results;
}

export async function listStudentQuestions(env: Env, lineId: string): Promise<StudentQuestionRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, question_text, image_ids, kind, ai_status, status, final_answer, created_at, sent_at
       FROM questions WHERE student_line_id = ? ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(lineId)
    .run<StudentQuestionRow>();
  return results;
}

/** 清理老師輸入：去頭尾空白、限制長度；空白存成 NULL（代表未設定）。 */
export function cleanField(value: unknown, max: number): string | null {
  const s = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return s === "" ? null : s;
}

export async function updateStudent(env: Env, lineId: string, displayName: string | null, className: string | null, now = Date.now()): Promise<boolean> {
  const res = await env.DB.prepare("UPDATE students SET display_name = ?, class_name = ?, updated_at = ? WHERE line_id = ?")
    .bind(displayName, className, now, lineId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}
